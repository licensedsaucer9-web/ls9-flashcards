import { type Card, type CardContent, type DeckFile, type LocalDeck, type Settings, type Srs, type Tier, type UserFile, type WordType } from './types.ts'
import { bumpMark } from './record-sync.ts'
import { type ReviewActivity } from './streak.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import { inSelectedTier, tierOf } from './tiers.ts'
import { inSelectedWordTypes } from './word-types.ts'
import { activeUserSlug } from './user.ts'
import { activeCards, contentTime, deckTombstones, load, namesFor, normalizeSettings, noteCardWrite, openDb, publicSettings, srsTime, txDone, upgradeAbort, value } from './db-core.ts'

export function localDeckFile(cards: Card[], settings: Settings): DeckFile {
  cards = activeCards(cards, settings)
  const deleted = deckTombstones(settings)
  let updatedAt = 0
  for (const card of cards) updatedAt = Math.max(updatedAt, contentTime(card))
  for (const time of Object.values(deleted)) updatedAt = Math.max(updatedAt, Number(time) || 0)
  return {
    version: 2,
    kind: 'deck',
    updated_at: updatedAt,
    // Sorted by id so a payload compare against the remote is not fooled by the
    // order IndexedDB happens to return rows in.
    cards: cards.map(stripSrs).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    deleted_ids: deleted,
  }
}

/** This user's scheduling half. */
export function localUserFile(cards: Card[], settings: Settings, user = activeUserSlug(), activity: ReviewActivity = {}): UserFile {
  cards = activeCards(cards, settings)
  let updatedAt = settings.settingsUpdatedAt
  for (const event of Object.values(activity)) updatedAt = Math.max(updatedAt, event.at)
  const progress: Record<string, Srs> = {}
  for (const card of cards) {
    if (!card.srs) continue
    progress[card.id] = card.srs
    updatedAt = Math.max(updatedAt, srsTime(card.srs))
  }
  return {
    version: 2,
    kind: 'user',
    user,
    updated_at: updatedAt,
    settings: publicSettings(settings),
    settings_updated_at: settings.settingsUpdatedAt || undefined,
    progress,
    ...(Object.keys(activity).length ? { activity } : {}),
  }
}

function stripSrs(card: Card): CardContent {
  return {
    id: card.id,
    de: card.de,
    en: card.en,
    article: card.article,
    example_de: card.example_de,
    example_en: card.example_en,
    tags: card.tags,
    rank: card.rank,
    tier: card.tier,
    created_at: card.created_at,
    updated_at: card.updated_at,
  }
}

export async function readLocalState(user = activeUserSlug()): Promise<{ snapshot: { deck: DeckFile; user: UserFile }; settings: Settings }> {
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) {
      const settings = normalizeSettings(null)
      return { snapshot: { deck: localDeckFile([], settings), user: localUserFile([], settings, user) }, settings }
    }
    const { cards, settings, activity, done } = await load(db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite'))
    await done
    if (!studyLockCurrent(lock)) {
      const empty = normalizeSettings(null)
      return { snapshot: { deck: localDeckFile([], empty), user: localUserFile([], empty, user) }, settings: empty }
    }
    return { snapshot: { deck: localDeckFile(cards, settings), user: localUserFile(cards, settings, user, activity) }, settings }
  } finally {
    db.close()
  }
}

export async function getAllCards(): Promise<Card[]> {
  const { lock, name } = namesFor()
  const db = await openDb(name, false)
  try {
    if (!studyLockCurrent(lock)) return []
    const tx = db.transaction(['cards', 'settings'], 'readonly')
    const [cards, stored] = await Promise.all([
      value(tx.objectStore('cards').getAll()) as Promise<Card[]>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
    ])
    return studyLockCurrent(lock) ? activeCards(cards, normalizeSettings(stored)) : []
  } finally {
    db.close()
  }
}

export async function getCard(id: string): Promise<Card | undefined> {
  return (await getAllCards()).find(card => card.id === id)
}

/**
 * Settings are written from a nested request callback. The outer handler only
 * starts those reads, so the transaction stays open until the markers are stored
 * with the edit.
 */
async function editLocal(work: (tx: IDBTransaction, settings: Settings) => void): Promise<void> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const done = txDone(tx)
    let aborted = false
    const request = tx.objectStore('settings').get('settings')
    request.onsuccess = () => {
      if (!studyLockCurrent(lock)) {
        aborted = true
        tx.abort()
        return
      }
      work(tx, normalizeSettings(request.result as Settings | undefined))
    }
    await done.catch((error) => {
      if (aborted || !studyLockCurrent(lock) || upgradeAbort(db, error)) return
      throw error
    })
  } finally {
    db.close()
  }
}

export async function putCard(card: Card): Promise<void> {
  const seen = captureStudyLock()
  await editLocal((tx, settings) => {
    const store = tx.objectStore('cards')
    const request = store.get(card.id)
    request.onsuccess = () => {
      if (!studyLockCurrent(seen)) {
        tx.abort()
        return
      }
      const previous = request.result as Card | undefined
      if (previous && previous.deckId !== settings.activeDeckId) return
      const saved = { ...card, deckId: settings.activeDeckId }
      noteCardWrite(settings, previous, saved, settings.localRevision + 1)
      store.put(saved)
      settings.localRevision += 1
      tx.objectStore('settings').put(settings)
    }
  })
}

export async function putCards(cards: Card[]): Promise<void> {
  if (!cards.length) return
  const seen = captureStudyLock()
  await editLocal((tx, settings) => {
    const store = tx.objectStore('cards')
    const reads = cards.map((card) => ({ card, request: store.get(card.id) }))
    let left = reads.length
    for (const item of reads) {
      item.request.onsuccess = () => {
        if (!studyLockCurrent(seen)) {
          tx.abort()
          return
        }
        const previous = item.request.result as Card | undefined
        if (!previous || previous.deckId === settings.activeDeckId) {
          const saved = { ...item.card, deckId: settings.activeDeckId }
          noteCardWrite(settings, previous, saved, settings.localRevision + 1)
          store.put(saved)
        }
        left -= 1
        if (left > 0) return
        settings.localRevision += 1
        tx.objectStore('settings').put(settings)
      }
    }
  })
}

/** Seed against current cards and tombstones in one transaction. */
export async function insertMissingSeeds(seeds: Card[]): Promise<number> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return 0
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock)) {
      tx.abort()
      await current.done.catch(() => {})
      return 0
    }
    const decks = await value(tx.objectStore('decks').getAll()) as LocalDeck[]
    const originalId = decks.find(deck => deck.origin === 'original')!.id
    const originalCards = current.cards.filter(card => card.deckId === originalId)
    const byId = new Map(current.cards.map((card) => [card.id, card]))
    const key = (card: Card) => `${card.de.trim().toLowerCase()}|${card.en.trim().toLowerCase()}`
    const byKey = new Set(originalCards.map(key))
    const store = tx.objectStore('cards')
    let added = 0
    const addedIds: string[] = []
    const repairedIds: string[] = []
    for (const seed of seeds) {
      if (deckTombstones(current.settings, originalId)[seed.id]) continue
      const mine = byId.get(seed.id)
      if (mine) {
        if (mine.deckId !== originalId) continue
        // A built-in card that predates the tier data, e.g. one that arrived through
        // the v1 snapshot migration, would otherwise sit in tier 3 for good. Seeds are
        // app-owned, so fill in a missing rank and tier. Only fill in what is absent:
        // a tier the user set by hand in the card editor is a deliberate choice, and
        // re-researched ranks are not worth churning every existing card for.
        if (mine.rank === undefined || mine.tier === undefined) {
          store.put({ ...mine, rank: mine.rank ?? seed.rank, tier: mine.tier ?? seed.tier })
          repairedIds.push(seed.id)
        }
        continue
      }
      const pair = key(seed)
      if (byKey.has(pair)) continue
      const saved = { ...seed, deckId: originalId }
      store.put(saved)
      byId.set(seed.id, saved)
      byKey.add(pair)
      added += 1
      addedIds.push(seed.id)
    }
    if (added || repairedIds.length) {
      const rev = current.settings.localRevision + 1
      current.settings.localRevision = rev
      for (const id of repairedIds) current.settings.pending.cards[id] = bumpMark(current.settings.pending.cards[id], rev)
      for (const id of addedIds) {
        current.settings.pending.cards[id] = bumpMark(current.settings.pending.cards[id], rev)
        current.settings.pending.progress[id] = bumpMark(current.settings.pending.progress[id], rev)
      }
      tx.objectStore('settings').put(current.settings)
    }
    await current.done
    return added
  } finally {
    db.close()
  }
}

export async function deleteCard(id: string, deletedAt = Date.now()): Promise<void> {
  await editLocal((tx, settings) => {
    const store = tx.objectStore('cards')
    const request = store.get(id)
    request.onsuccess = () => {
      const card = request.result as Card | undefined
      if (card && card.deckId !== settings.activeDeckId) return
      if (!card && settings.deletedDeckIds?.[id] && settings.deletedDeckIds[id] !== settings.activeDeckId) return
      store.delete(id)
      // The tombstone supersedes unsent content and its local schedule.
      delete settings.pending.cards[id]
      delete settings.pending.progress[id]
      settings.deletedIds[id] = Math.max(settings.deletedIds[id] || 0, deletedAt)
      ;(settings.deletedDeckIds ??= {})[id] = settings.activeDeckId
      settings.pending.tombstones[id] = { ...bumpMark(settings.pending.tombstones[id], settings.localRevision + 1), deckId: settings.activeDeckId }
      settings.localRevision += 1
      tx.objectStore('settings').put(settings)
    }
  })
}

export async function countCards(): Promise<number> {
  return (await getAllCards()).length
}

export type DueByTier = Record<Tier, { due: number; total: number }>

/** One pass for the whole deck: how many cards sit in each tier and how many are due. */
export async function getDueByTier(now = Date.now()): Promise<DueByTier> {
  const cards = await getAllCards()
  const out: DueByTier = { 1: { due: 0, total: 0 }, 2: { due: 0, total: 0 }, 3: { due: 0, total: 0 }, 4: { due: 0, total: 0 } }
  for (const card of cards) {
    const bucket = out[tierOf(card)]
    bucket.total += 1
    if (card.srs.due <= now) bucket.due += 1
  }
  return out
}

/**
 * Due cards in the tier, then limited to the selected word types.
 * An empty type list keeps every card. Scheduling fields are not copied or changed.
 * Omitting a tier returns the whole deck, which is what the deck list wants.
 */
export function selectDueCards(cards: readonly Card[], selected: Tier | undefined, types: readonly WordType[], now: number): Card[] {
  const list = [...cards]
  const inScope = selected === undefined ? list : inSelectedTier(list, selected)
  return inScope
    .filter((card) => card.srs.due <= now)
    .filter((card) => inSelectedWordTypes(card, types))
    .sort((a, b) => a.srs.due - b.srs.due || a.de.localeCompare(b.de, 'de'))
}

export async function getDueCards(selected?: Tier, now = Date.now(), types: readonly WordType[] = []): Promise<Card[]> {
  return selectDueCards(await getAllCards(), selected, types, now)
}

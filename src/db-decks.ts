import { STARTERS, starterCards, starterDeckId, type StarterLanguage } from './starter-decks.ts'
import { type Card, type LocalDeck, type Settings } from './types.ts'
import { bumpStudyGeneration, studyLockCurrent } from './study-lock.ts'
import { LOCAL_DECK_ID, namesFor, normalizeSettings, openDb, publicSettings, txDone, value } from './db-core.ts'
import { getSettings } from './db-settings.ts'

/** Read metadata without copying, filtering or reseeding the existing cards. */
export async function getDecks(): Promise<LocalDeck[]> {
  const { lock, name } = namesFor()
  const db = await openDb(name, false)
  try {
    if (!studyLockCurrent(lock)) return []
    // Legacy recovery reads must not upgrade or stamp the source database.
    if (!db.objectStoreNames.contains('decks')) return [{
      id: LOCAL_DECK_ID, name: 'German', targetLang: 'German', baseLang: 'English',
      articles: true, supportsWordTypes: true, tiers: true,
          ...publicSettings(normalizeSettings(null)), origin: 'original',
    }]
    const decks = await value(db.transaction('decks', 'readonly').objectStore('decks').getAll()) as LocalDeck[]
    return studyLockCurrent(lock) ? decks : []
  } finally { db.close() }
}

/** The deck this device is studying. Its id lives only in local settings. */
export async function getActiveDeck(): Promise<LocalDeck | undefined> {
  const [decks, settings] = await Promise.all([getDecks(), getSettings()])
  return decks.find(deck => deck.id === settings.activeDeckId)
}

/** Capability switches are local metadata; changing them never edits cards or schedules. */
export async function putDeckFeatures(next: Partial<Pick<LocalDeck, 'articles' | 'supportsWordTypes' | 'tiers'>>): Promise<void> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['decks', 'settings'], 'readwrite')
    const done = txDone(tx)
    const settings = normalizeSettings(await value(tx.objectStore('settings').get('settings')) as Settings | undefined)
    const deck = await value(tx.objectStore('decks').get(settings.activeDeckId)) as LocalDeck | undefined
    if (!studyLockCurrent(lock)) { tx.abort(); await done.catch(() => {}); return }
    if (deck) tx.objectStore('decks').put({ ...deck, ...next })
    await done
  } finally { db.close() }
}

/** Card counts per deck, grouped by the same deck id that scopes reviews. */
export async function getDeckCardCounts(): Promise<Map<string, number>> {
  const { lock, name } = namesFor()
  const db = await openDb(name, false)
  try {
    if (!studyLockCurrent(lock)) return new Map()
    const tx = db.transaction(['cards', 'settings'], 'readonly')
    const [cards, stored] = await Promise.all([
      value(tx.objectStore('cards').getAll()) as Promise<Card[]>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
    ])
    if (!studyLockCurrent(lock)) return new Map()
    const activeId = normalizeSettings(stored).activeDeckId
    const counts = new Map<string, number>()
    for (const card of cards) {
      const id = card.deckId || activeId
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  } finally { db.close() }
}

/** Create an empty local deck and make it the active deck in one transaction. */
export async function createLocalDeck(name: string, targetLang: string): Promise<LocalDeck | null> {
  const { lock, name: dbName } = namesFor()
  const db = await openDb(dbName)
  try {
    if (!studyLockCurrent(lock)) return null
    const tx = db.transaction(['decks', 'settings'], 'readwrite')
    const done = txDone(tx)
    const stored = await value(tx.objectStore('settings').get('settings')) as Settings | undefined
    if (!studyLockCurrent(lock)) { tx.abort(); await done.catch(() => {}); return null }
    const deck: LocalDeck = {
      id: crypto.randomUUID(), name, targetLang, baseLang: 'English',
      articles: false, supportsWordTypes: false, tiers: false, origin: 'local',
      direction: 'de-en', sessionSize: 20, tier: 4, wordTypes: [],
    }
    tx.objectStore('decks').add(deck)
    tx.objectStore('settings').put({ ...normalizeSettings(stored), activeDeckId: deck.id })
    await done
    if (!studyLockCurrent(lock)) return null
    // Any sync pass started against the previous deck must not merge or push now.
    bumpStudyGeneration()
    return deck
  } finally { db.close() }
}

/** Stage a starter deck's row and its missing seed cards in `tx`. The caller decides whether it becomes the open deck. */
export function stageStarterDeck(
  tx: IDBTransaction, language: StarterLanguage, id: string, settings: Settings,
  existing: LocalDeck | undefined, cards: Card[], rev: number,
): { deck: LocalDeck; added: Card[] } {
  const deck: LocalDeck = existing ?? {
    id, starter: language, name: STARTERS.find(s => s.key === language)!.name,
    targetLang: language === 'fr' ? 'French' : 'Spanish', baseLang: 'English',
    articles: true, supportsWordTypes: true, tiers: true, origin: 'local',
    direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: [],
  }
  const ids = new Set(cards.map(card => card.id))
  const added: Card[] = []
  for (const card of starterCards(language)) {
    if (ids.has(card.id) || settings.deletedIds[card.id]) continue
    const saved = { ...card, deckId: id }
    tx.objectStore('cards').add(saved)
    settings.pending.cards[card.id] = { revision: rev, acked: 0, deckId: id }
    added.push(saved)
  }
  tx.objectStore('decks').put(deck)
  return { deck, added }
}

/** Explicit catalog addition: one atomic insert, preserving edits, schedules and tombstones.
 * Existing built-ins are never overwritten; new seed IDs can be appended on repeat addition.
 */
export async function addStarterDeck(language: StarterLanguage): Promise<LocalDeck | null> {
  const { lock, name } = namesFor()
  const id = await starterDeckId(lock.uid ?? name, language)
  if (!studyLockCurrent(lock)) return null
  const db = await openDb(name)
  try {
    const tx = db.transaction(['decks', 'cards', 'settings'], 'readwrite')
    const done = txDone(tx)
    const [stored, existing, cards] = await Promise.all([
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
      value(tx.objectStore('decks').get(id)) as Promise<LocalDeck | undefined>,
      value(tx.objectStore('cards').getAll()) as Promise<Card[]>,
    ])
    if (!studyLockCurrent(lock)) { tx.abort(); await done.catch(() => {}); return null }
    const settings = normalizeSettings(stored)
    const rev = settings.localRevision + 1
    const { deck, added } = stageStarterDeck(tx, language, id, settings, existing, cards, rev)
    if (added.length) settings.localRevision = rev
    tx.objectStore('settings').put({ ...settings, activeDeckId: id })
    await done
    if (!studyLockCurrent(lock)) return null
    bumpStudyGeneration()
    return deck
  } finally { db.close() }
}

/** Rename metadata on this device without changing cards or cloud settings. */
export async function renameDeck(deckId: string, name: string): Promise<boolean> {
  name = name.trim()
  if (!name || name.length > 60) return false
  const { lock, name: dbName } = namesFor()
  const db = await openDb(dbName)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction('decks', 'readwrite')
    const done = txDone(tx)
    const deck = await value(tx.objectStore('decks').get(deckId)) as LocalDeck | undefined
    if (!deck || !studyLockCurrent(lock)) { await done; return false }
    tx.objectStore('decks').put({ ...deck, name })
    await done
    return studyLockCurrent(lock)
  } finally { db.close() }
}

/** Remove only a local deck and its owned records; keep account activity and cloud data. */
export async function deleteLocalDeck(deckId: string): Promise<boolean> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction(['decks', 'cards', 'settings'], 'readwrite')
    const done = txDone(tx)
    const [decks, cards, stored] = await Promise.all([
      value(tx.objectStore('decks').getAll()) as Promise<LocalDeck[]>,
      value(tx.objectStore('cards').getAll()) as Promise<Card[]>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
    ])
    const deck = decks.find(deck => deck.id === deckId)
    if (!studyLockCurrent(lock) || deck?.origin !== 'local' || deck.starter || decks.length <= 1) {
      await done
      return false
    }
    const settings = normalizeSettings(stored)
    const ownedIds = new Set(cards.filter(card => card.deckId === deckId).map(card => card.id))
    for (const [id, owner] of Object.entries(settings.deletedDeckIds ?? {})) {
      if (owner === deckId) ownedIds.add(id)
    }
    for (const id of ownedIds) {
      tx.objectStore('cards').delete(id)
      delete settings.deletedIds[id]
      delete settings.deletedDeckIds?.[id]
      delete settings.pending.cards[id]
      delete settings.pending.progress[id]
      delete settings.pending.tombstones[id]
      delete settings.stagedProgress?.[id]
    }
    if (settings.activeDeckId === deckId) {
      const remaining = decks.filter(other => other.id !== deckId)
      settings.activeDeckId = (remaining.find(other => other.origin === 'original') ?? remaining[0])!.id
    }
    tx.objectStore('decks').delete(deckId)
    delete settings.pending.extraSettings?.[deckId]
    tx.objectStore('settings').put(settings)
    await done
    if (!studyLockCurrent(lock)) return false
    bumpStudyGeneration()
    return true
  } finally { db.close() }
}

/** Local selection only: no revision, no pending mark, no cloud write. */
export async function switchActiveDeck(deckId: string): Promise<boolean> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction(['decks', 'settings'], 'readwrite')
    const done = txDone(tx)
    const [deck, stored] = await Promise.all([
      value(tx.objectStore('decks').get(deckId)) as Promise<LocalDeck | undefined>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
    ])
    if (!deck || !studyLockCurrent(lock)) { await done.catch(() => {}); return false }
    tx.objectStore('settings').put({ ...normalizeSettings(stored), activeDeckId: deck.id })
    await done
    if (!studyLockCurrent(lock)) return false
    bumpStudyGeneration()
    return true
  } finally { db.close() }
}

/** Point a local deck at a different cloud deck; its local ID, cards and pending marks stay as they are.
 * Only the first fallback is kept: when another tab already recorded a cloud ID, that one is
 * returned instead so every tab syncs to the same cloud deck. Undefined means refused.
 */
export async function recordCloudDeckId(deckId: string, cloudId: string): Promise<string | undefined> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return undefined
    const tx = db.transaction('decks', 'readwrite')
    const done = txDone(tx)
    const deck = await value(tx.objectStore('decks').get(deckId)) as LocalDeck | undefined
    if (!deck || deck.origin !== 'local' || !studyLockCurrent(lock)) { await done; return undefined }
    const recorded = deck.cloudId ?? cloudId
    if (!deck.cloudId) tx.objectStore('decks').put({ ...deck, cloudId })
    await done
    return studyLockCurrent(lock) ? recorded : undefined
  } finally { db.close() }
}

/** Attach the known assignment to this account's sole deck, including offline fallback upgrades. */
export async function recordAssignedDeck(deckId: string): Promise<void> {
  const { lock, name } = namesFor()
  if (!lock.uid || !deckId) return
  const db = await openDb(name, true, deckId)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['decks', 'settings', 'cards'], 'readwrite')
    const done = txDone(tx)
    const [decks, stored] = await Promise.all([
      value(tx.objectStore('decks').getAll()) as Promise<LocalDeck[]>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
    ])
    if (!studyLockCurrent(lock)) { tx.abort(); await done.catch(() => {}); return }
    const deck = decks.find(deck => deck.origin === 'original')
    if (deck && deck.id !== deckId) {
      tx.objectStore('decks').delete(deck.id)
      tx.objectStore('decks').put({ ...deck, id: deckId })
      const cards = await value(tx.objectStore('cards').getAll()) as Card[]
      for (const card of cards) if (card.deckId === deck.id) tx.objectStore('cards').put({ ...card, deckId })
      if (stored?.pending) {
        for (const marks of [stored.pending.cards, stored.pending.tombstones, stored.pending.progress]) {
          for (const mark of Object.values(marks)) if (mark.deckId === deck.id) mark.deckId = deckId
        }
      }
      if (stored?.deletedDeckIds) {
        for (const [id, owner] of Object.entries(stored.deletedDeckIds)) if (owner === deck.id) stored.deletedDeckIds[id] = deckId
      }
    }
    tx.objectStore('settings').put({ ...normalizeSettings(stored), activeDeckId: !stored?.activeDeckId || stored.activeDeckId === deck?.id ? deckId : stored.activeDeckId })
    await done
  } finally { db.close() }
}

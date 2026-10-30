import { starterDeckId, type StarterLanguage } from './starter-decks.ts'
import { type Card, type LocalDeck, type RecordMark, type Settings } from './types.ts'
import { sameSrs } from './merge.ts'
import { bumpMark } from './record-sync.ts'
import { newSrs } from './srs.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import { sameSelectedTiers } from './tiers.ts'
import { sameWordTypes } from './word-types.ts'
import { type ActivityRow, activityFromRows, activityRows, dataStores, deckTombstones, load, mergeActivityInTransaction, normalizeSettings, openDb, publicSettings, replacePreferences, storeOriginalPreferences, upgradeAbort, value } from './db-core.ts'
import { stageStarterDeck } from './db-decks.ts'

export type GuestCopyMode = 'progress' | 'vocabulary'

/** The original (German) deck of a database. A legacy database without deck rows only has the active deck. */
function originalDeckId(decks: LocalDeck[], settings: Settings): string {
  return decks.find(deck => deck.origin === 'original')?.id ?? settings.activeDeckId
}

/**
 * Copy a signed-out database into the database the current study lock names.
 * Progress copies schedules and settings only. Vocabulary also copies cards and deletions.
 * The original (German) deck is copied into the destination's original deck whichever deck is open
 * on either side: copying the open deck would put, say, French cards into the German deck. The
 * French and Spanish starter decks are copied into the destination's own starter deck of that
 * language, created with its seed cards when missing (starter IDs are per account, so they differ
 * from the device's). Created decks are not copied. The open deck never changes.
 * The source database is left in place. A lock that changed mid-copy writes nothing.
 */
export async function copyGuestDatabase(sourceName: string, mode: GuestCopyMode): Promise<boolean> {
  const lock = captureStudyLock()
  if (!lock.dbName || sourceName === lock.dbName) return false
  const source = await openDb(sourceName, false)
  let cards: Card[] = []
  let stored: Settings | undefined
  let sourceDecks: LocalDeck[] = []
  let sourceActivity: ActivityRow[]
  try {
    const hasDecks = source.objectStoreNames.contains('decks')
    const tx = source.transaction([...dataStores(source), ...(hasDecks ? ['decks'] : [])], 'readonly')
    const cardsRequest = tx.objectStore('cards').getAll()
    const settingsRequest = tx.objectStore('settings').get('settings')
    const decksRequest = hasDecks ? tx.objectStore('decks').getAll() : null
    ;[cards, stored, sourceActivity, sourceDecks] = await Promise.all([
      value(cardsRequest) as Promise<Card[]>,
      value(settingsRequest) as Promise<Settings | undefined>,
      activityRows(tx),
      decksRequest ? value(decksRequest) as Promise<LocalDeck[]> : Promise.resolve([]),
    ])
  } finally {
    source.close()
  }
  if (!studyLockCurrent(lock)) return false
  const copiedActivity = activityFromRows(sourceActivity)
  // A starter deck's ID is derived from its owner, so the account's French deck differs from the device's.
  const starterIds = new Map<StarterLanguage, string>()
  for (const deck of sourceDecks) {
    if (deck.starter && deck.origin === 'local' && !starterIds.has(deck.starter)) {
      starterIds.set(deck.starter, await starterDeckId(lock.uid ?? lock.dbName, deck.starter))
    }
  }
  if (!studyLockCurrent(lock)) return false
  const db = await openDb(lock.dbName)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    // Attach the handler before awaiting anything else: a request that finishes first never resolves later.
    const targetDecksRead = value(tx.objectStore('decks').getAll()) as Promise<LocalDeck[]>
    const current = await load(tx)
    const targetDecks = await targetDecksRead
    if (!studyLockCurrent(lock)) {
      tx.abort()
      await current.done.catch(() => {})
      return false
    }
    const sourceSettings = stored ? normalizeSettings(stored) : null
    const sourceId = originalDeckId(sourceDecks, sourceSettings ?? normalizeSettings(null))
    const targetId = originalDeckId(targetDecks, current.settings)
    const store = tx.objectStore('cards')
    const rev = current.settings.localRevision + 1
    // Marks name their deck so a sync of another open deck never picks them up.
    const mark = (previous: RecordMark | undefined, deckId: string): RecordMark => ({ ...bumpMark(previous, rev), deckId })
    // Tombstones without an owner predate multiple decks, so they belong to the original deck.
    const tombstoneSource = { ...(sourceSettings ?? normalizeSettings(null)), activeDeckId: sourceId }
    const staged = { ...(current.settings.stagedProgress ?? {}) }

    /** Copy one device deck into one account deck; `into` holds the account deck's cards so far. */
    const copyDeck = (from: string, to: string, into: Card[], original: boolean) => {
      const incoming = cards.filter(card => card.deckId === from || (original && !card.deckId))
      const mine = new Map(into.map(card => [card.id, card]))
      const elsewhere = (id: string) => current.cards.some(card => card.id === id && card.deckId !== to)
      if (mode === 'vocabulary') {
        const tombstoned = new Set<string>()
        if (sourceSettings) {
          for (const [id, time] of Object.entries(deckTombstones(tombstoneSource, from))) {
            if ((Number(time) || 0) > 0) tombstoned.add(id)
          }
        }
        for (const card of incoming) {
          if (elsewhere(card.id) || tombstoned.has(card.id)) continue
          const before = mine.get(card.id)
          // A starter card the device never studied must not erase the account's progress on it.
          const untouched = !original && before?.srs && (!card.srs || sameSrs(card.srs, newSrs(0)))
          store.put({ ...card, deckId: to, ...(untouched ? { srs: before.srs } : {}) })
          current.settings.pending.cards[card.id] = mark(current.settings.pending.cards[card.id], to)
          if (original || (!untouched && (!before?.srs || !card.srs || !sameSrs(card.srs, before.srs)))) {
            current.settings.pending.progress[card.id] = mark(current.settings.pending.progress[card.id], to)
          }
        }
        for (const id of tombstoned) {
          if (elsewhere(id)) continue
          if (current.settings.deletedDeckIds?.[id] && current.settings.deletedDeckIds[id] !== to) continue
          const stamp = Number(sourceSettings?.deletedIds[id]) || 0
          ;(current.settings.deletedDeckIds ??= {})[id] = to
          current.settings.deletedIds[id] = Math.max(current.settings.deletedIds[id] || 0, stamp)
          store.delete(id)
          current.settings.pending.tombstones[id] = mark(current.settings.pending.tombstones[id], to)
        }
      } else {
        for (const card of incoming) {
          if (!card.srs) continue
          const existing = mine.get(card.id)
          if (!existing) {
            if (original) staged[card.id] = card.srs
            continue
          }
          if (sameSrs(card.srs, existing.srs)) continue
          if (!original && sameSrs(card.srs, newSrs(0))) continue // never studied on the device
          store.put({ ...existing, srs: card.srs })
          current.settings.pending.progress[card.id] = mark(current.settings.pending.progress[card.id], to)
        }
      }
    }

    copyDeck(sourceId, targetId, current.cards.filter(card => !card.deckId || card.deckId === targetId), true)
    if (mode === 'progress') {
      if (Object.keys(staged).length) current.settings.stagedProgress = staged
      else delete current.settings.stagedProgress
    }

    for (const guest of sourceDecks) {
      const language = guest.starter
      const id = language && guest.origin === 'local' ? starterIds.get(language) : undefined
      if (!language || !id) continue
      const existing = targetDecks.find(deck => deck.id === id)
      const { deck, added } = stageStarterDeck(tx, language, id, current.settings, existing, current.cards, rev)
      copyDeck(guest.id, id, [...current.cards.filter(card => card.deckId === id), ...added], false)
      // Preferences: a newly created account deck takes the device's; an existing one only if the device's are newer.
      const guestAt = guest.settingsUpdatedAt ?? 0
      if (!existing || guestAt > (deck.settingsUpdatedAt ?? 0)) {
        const preferences = publicSettings(guest)
        const changed = deck.direction !== preferences.direction || deck.sessionSize !== preferences.sessionSize
          || deck.tier !== preferences.tier || !sameSelectedTiers(deck, preferences) || !sameWordTypes(deck.wordTypes, preferences.wordTypes)
        tx.objectStore('decks').put({ ...replacePreferences({ ...deck }, preferences), settingsUpdatedAt: Math.max(guestAt, deck.settingsUpdatedAt ?? 0) })
        if (changed) (current.settings.pending.extraSettings ??= {})[id] = bumpMark(current.settings.pending.extraSettings?.[id], rev)
      }
    }

    if (sourceSettings) {
      const settingsChanged = current.settings.direction !== sourceSettings.direction
        || current.settings.sessionSize !== sourceSettings.sessionSize
        || current.settings.tier !== sourceSettings.tier
        || !sameSelectedTiers(current.settings, sourceSettings)
        || !sameWordTypes(current.settings.wordTypes, sourceSettings.wordTypes)
        || sourceSettings.settingsUpdatedAt > current.settings.settingsUpdatedAt
      current.settings.direction = sourceSettings.direction
      current.settings.sessionSize = sourceSettings.sessionSize
      delete current.settings.selectedTiers
      if (sourceSettings.selectedTiers) current.settings.selectedTiers = [...sourceSettings.selectedTiers]
      current.settings.tier = sourceSettings.tier
      current.settings.wordTypes = sourceSettings.wordTypes
      storeOriginalPreferences(tx, current.settings)
      if (sourceSettings.settingsUpdatedAt > current.settings.settingsUpdatedAt) {
        current.settings.settingsUpdatedAt = sourceSettings.settingsUpdatedAt
      }
      if (settingsChanged) current.settings.pending.settings = bumpMark(current.settings.pending.settings, rev)
    }
    mergeActivityInTransaction(tx, current, copiedActivity, true, rev)
    current.settings.localRevision = rev
    tx.objectStore('settings').put(current.settings)
    let wrote = true
    await current.done.catch((error) => {
      if (!studyLockCurrent(lock) || upgradeAbort(db, error)) {
        wrote = false
        return
      }
      throw error
    })
    return wrote && studyLockCurrent(lock)
  } finally {
    db.close()
  }
}

import { type Card, type Settings } from './types.ts'
import { bumpMark } from './record-sync.ts'
import { mergeReviewActivity, type ReviewActivity } from './streak.ts'
import { activeUserSlug, dbNameForUser, hasMigrated, LEGACY_DB_NAME, markMigrated } from './user.ts'
import { activityFromRows, activityRows, dataStores, load, normalizeSettings, openDb, storeOriginalPreferences, value } from './db-core.ts'

/**
 * Copy the single-user database the pre-multi-user builds used into the active
 * user's own database. Runs once; the old database is left in place.
 */
export async function importLegacyData(destination?: string): Promise<number> {
  if (hasMigrated()) return 0
  const target = destination ?? dbNameForUser(activeUserSlug())
  if (target === LEGACY_DB_NAME) return 0
  const legacy = await openDb(LEGACY_DB_NAME, false)
  let cards: Card[] = []
  let settings: Settings | undefined
  let legacyActivity: ReviewActivity = {}
  try {
    const tx = legacy.transaction(dataStores(legacy), 'readonly')
    const [oldCards, oldSettings, rows] = await Promise.all([
      value(tx.objectStore('cards').getAll()) as Promise<Card[]>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
      activityRows(tx),
    ])
    cards = oldCards
    settings = oldSettings
    legacyActivity = activityFromRows(rows)
  } finally {
    legacy.close()
  }
  if (!cards.length && !settings) {
    markMigrated()
    return 0
  }

  const db = await openDb(target)
  try {
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const current = await load(tx)
    const store = tx.objectStore('cards')
    let mergedActivity: ReviewActivity
    try { mergedActivity = mergeReviewActivity(current.activity, legacyActivity) }
    catch (error) { tx.abort(); await current.done.catch(() => {}); throw error }
    const byId = new Set(current.cards.map((c) => c.id))
    let added = 0
    for (const card of cards) {
      if (byId.has(card.id) || current.settings.deletedIds[card.id]) continue
      store.put({ ...card, deckId: current.settings.activeDeckId })
      added += 1
    }
    const next = normalizeSettings(settings)
    next.activeDeckId = current.settings.activeDeckId
    storeOriginalPreferences(tx, next)
    // A row that already exists on this device wins; only fill the gaps.
    if (next.localRevision > current.settings.localRevision || added) next.localRevision = current.settings.localRevision + 1
    next.deletedIds = { ...next.deletedIds, ...current.settings.deletedIds }
    next.deletedDeckIds = { ...Object.fromEntries(Object.keys(next.deletedIds).map(id => [id, current.settings.activeDeckId])), ...current.settings.deletedDeckIds }
    for (const [id, event] of Object.entries(mergedActivity)) tx.objectStore('activity').put({ id, ...event })
    if (Object.keys(mergedActivity).length) {
      next.localRevision = Math.max(next.localRevision, current.settings.localRevision) + 1
      next.pending.activity = { ...current.settings.pending.activity, ...next.pending.activity }
      for (const id of Object.keys(mergedActivity)) next.pending.activity[id] = bumpMark(next.pending.activity[id], next.localRevision)
    }
    tx.objectStore('settings').put(next)
    await current.done
    markMigrated()
    return added
  } finally {
    db.close()
  }
}

export async function localDatabaseHasWork(name: string): Promise<boolean> {
  const db = await openDb(name, false)
  try {
    const tx = db.transaction(dataStores(db), 'readonly')
    const cardsRequest = tx.objectStore('cards').count()
    const settingsRequest = tx.objectStore('settings').count()
    const [cards, settings] = await Promise.all([value(cardsRequest), value(settingsRequest)])
    return cards > 0 || settings > 0
  } finally {
    db.close()
  }
}

import { type Card, type Grade, type Settings } from './types.ts'
import { bumpMark } from './record-sync.ts'
import { review } from './srs.ts'
import { deviceTimeZone, streakTimeZone, validReviewEvent, type ReviewActivity } from './streak.ts'
import { studyLockCurrent } from './study-lock.ts'
import { activityRows, dataStores, load, namesFor, normalizeSettings, noteCardWrite, openDb, repairStoredActivity, txDone, value } from './db-core.ts'

export async function getReviewActivity(): Promise<ReviewActivity> {
  const { lock, name } = namesFor()
  const db = await openDb(name, false)
  try {
    if (!studyLockCurrent(lock) || !db.objectStoreNames.contains('activity')) return {}
    const tx = db.transaction(dataStores(db), 'readwrite')
    const { activity, done } = await load(tx)
    await done
    return studyLockCurrent(lock) ? activity : {}
  } finally { db.close() }
}

/** Save the grade, unique activity event and both pending markers atomically. */
export async function saveReview(cardId: string, grade: Grade, eventId: string, at = Date.now(), zone = deviceTimeZone()): Promise<Card | null> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return null
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const done = txDone(tx)
    try {
      const [card, rawSettings, rows] = await Promise.all([
        value(tx.objectStore('cards').get(cardId)) as Promise<Card | undefined>,
        value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
        activityRows(tx),
      ])
      if (!studyLockCurrent(lock)) { tx.abort(); await done.catch(() => {}); return null }
      const settings = normalizeSettings(rawSettings)
      const activity = repairStoredActivity(tx, rows, settings)
      if (!card || card.deckId !== settings.activeDeckId) { await done; return null }
      if (activity[eventId]) { await done; return card }
      const event = { at, timeZone: streakTimeZone(activity, zone) }
      if (!validReviewEvent(eventId, event)) throw new Error('Invalid review activity')
      const rev = settings.localRevision + 1
      const saved = { ...card, srs: { ...review(card.srs, grade, at), updated_at: Math.max(at, (card.srs.updated_at ?? 0) + 1) } }
      noteCardWrite(settings, card, saved, rev)
      settings.localRevision = rev
      ;(settings.pending.activity ??= {})[eventId] = bumpMark(undefined, rev)
      tx.objectStore('cards').put(saved)
      tx.objectStore('activity').add({ id: eventId, ...event })
      tx.objectStore('settings').put(settings)
      await done
      return studyLockCurrent(lock) ? saved : null
    } catch (error) {
      try { tx.abort() } catch { /* Already completed/aborted. */ }
      await done.catch(() => {})
      throw error
    }
  } finally { db.close() }
}

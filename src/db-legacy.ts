import { type Card, type Settings } from './types.ts'
import { mergeDeck, mergeProgress, newerSettings } from './merge.ts'
import { bumpMark, contentChanged, progressChanged } from './record-sync.ts'
import { newSrs } from './srs.ts'
import { mergeReviewActivity, type ReviewActivity } from './streak.ts'
import { validateCard, validateMapping, validateSettings, validateSrs, validateTombstones } from './migration-data.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import { sameSelectedTiers } from './tiers.ts'
import { sameWordTypes } from './word-types.ts'
import { accountDatabaseName, activeUserSlug, dbNameForUser, hasMigrated, LEGACY_DB_NAME, listUsers, markMigrated } from './user.ts'
import { localDeckFile } from './db-cards.ts'
import { type ActivityRow, activeCards, activityFromRows, activityRows, dataStores, legacySettingsClock, load, mergeActivityInTransaction, mergeTombstones, normalizeSettings, openDb, publicSettings, replacePreferences, storeOriginalPreferences, txDone, value } from './db-core.ts'

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

/** Explicit operator-confirmed recovery, distinct from a first-login guest copy. */
export async function copyMappedLegacyProfile(
  profile: string,
  rawMapping: unknown,
  projectId: string,
  serverDeckId: string,
): Promise<{ state: 'copied' | 'already copied' | 'skipped'; cards: number; tombstones: number }> {
  const mapping = validateMapping(rawMapping)
  const lock = captureStudyLock()
  const uid = Object.hasOwn(mapping.profiles, profile) ? mapping.profiles[profile] : null
  if (profile === 'guest' || !uid || !listUsers().some((user) => user.slug === profile)) {
    return { state: 'skipped', cards: 0, tombstones: 0 }
  }
  if (mapping.projectId !== projectId || mapping.deckId !== serverDeckId || lock.uid !== uid
    || lock.dbName !== accountDatabaseName(uid)) throw new Error('This mapping does not match the signed-in account and its legacy deck')
  const source = await openDb(dbNameForUser(profile), false)
  let cards: Card[]
  let stored: Settings | undefined
  let sourceActivity: ActivityRow[]
  try {
    const tx = source.transaction(dataStores(source), 'readonly')
    const done = txDone(tx)
    ;[cards, stored, sourceActivity] = await Promise.all([
      value(tx.objectStore('cards').getAll()) as Promise<Card[]>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
      activityRows(tx),
    ])
    await done
  } finally { source.close() }
  if (!studyLockCurrent(lock)) throw new Error('Account changed before the copy')
  if (!cards.length && !stored) return { state: 'skipped', cards: 0, tombstones: 0 }
  // Refuse corrupt legacy rows instead of silently repairing away unsent work.
  for (const card of cards) { validateCard(card); validateSrs(card.srs, card.id) }
  if (stored) {
    validateSettings(stored)
    if (stored.deletedIds !== undefined) validateTombstones(stored.deletedIds)
    if (stored.stagedProgress) for (const [id, srs] of Object.entries(stored.stagedProgress)) validateSrs(srs, id)
  }
  const copiedActivity = activityFromRows(sourceActivity)
  const sourceSettings = normalizeSettings(stored)
  validateTombstones(sourceSettings.deletedIds)
  if (stored && stored.settingsUpdatedAt === undefined) sourceSettings.settingsUpdatedAt = legacySettingsClock(cards, sourceSettings.deletedIds)
  const db = await openDb(lock.dbName)
  try {
    if (!studyLockCurrent(lock)) throw new Error('Account changed before the copy')
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock)) { tx.abort(); await current.done.catch(() => {}); throw new Error('Account changed during the copy') }
    const merged = mergeDeck(localDeckFile(cards, sourceSettings), localDeckFile(current.cards, current.settings))
    const schedules = mergeProgress(
      { ...Object.fromEntries(cards.map((card) => [card.id, card.srs])), ...sourceSettings.stagedProgress },
      { ...Object.fromEntries(current.cards.map((card) => [card.id, card.srs])), ...current.settings.stagedProgress },
    )
    const byId = new Map(current.cards.map((card) => [card.id, card]))
    const store = tx.objectStore('cards')
    const sourceIds = new Set(cards.map((card) => card.id))
    const rev = Math.max(current.settings.localRevision, sourceSettings.localRevision) + 1
    if (!Number.isSafeInteger(rev)) { tx.abort(); await current.done.catch(() => {}); throw new Error('Local revision is outside the supported range') }
    let changed = false
    for (const content of merged.cards) {
      const previous = byId.get(content.id)
      if (previous && previous.deckId !== current.settings.activeDeckId) continue
      const next: Card = { ...content, deckId: current.settings.activeDeckId, srs: schedules[content.id] ?? previous?.srs ?? newSrs() }
      if (contentChanged(previous, next) || progressChanged(previous, next)) { store.put(next); changed = true }
      // GitHub's acknowledgement is not a Firestore acknowledgement. Backfill
      // copied records even on a pre-marker account database; preserve real acks.
      if (sourceIds.has(content.id)) {
        if (contentChanged(previous, next) || !current.settings.pending.cards[content.id]) {
          current.settings.pending.cards[content.id] = bumpMark(current.settings.pending.cards[content.id], rev); changed = true
        }
        if (progressChanged(previous, next) || !current.settings.pending.progress[content.id]) {
          current.settings.pending.progress[content.id] = bumpMark(current.settings.pending.progress[content.id], rev); changed = true
        }
      }
    }
    const liveIds = new Set(merged.cards.map((card) => card.id))
    const staged = Object.fromEntries(Object.entries(schedules).filter(([id]) => !liveIds.has(id) && !merged.deleted_ids[id]))
    if (Object.keys(staged).length) {
      if (JSON.stringify(staged) !== JSON.stringify(current.settings.stagedProgress)) changed = true
      current.settings.stagedProgress = staged
    } else if (current.settings.stagedProgress) { delete current.settings.stagedProgress; changed = true }
    for (const card of activeCards(current.cards, current.settings)) if (!liveIds.has(card.id)) { store.delete(card.id); changed = true }
    for (const [id, time] of Object.entries(merged.deleted_ids)) {
      if (Object.hasOwn(sourceSettings.deletedIds, id)
        && (current.settings.deletedIds[id] !== time || !current.settings.pending.tombstones[id])) {
        current.settings.pending.tombstones[id] = bumpMark(current.settings.pending.tombstones[id], rev); changed = true
      }
    }
    mergeTombstones(current.settings, merged.deleted_ids)
    const localAt = current.settings.settingsUpdatedAt
    const sourceAt = sourceSettings.settingsUpdatedAt
    const preferences = newerSettings(publicSettings(current.settings), localAt, publicSettings(sourceSettings), sourceAt)
    if (current.settings.direction !== preferences.direction || current.settings.sessionSize !== preferences.sessionSize
      || current.settings.tier !== preferences.tier || !sameSelectedTiers(current.settings, preferences) || !sameWordTypes(current.settings.wordTypes, preferences.wordTypes)
      || sourceAt > localAt || !current.settings.pending.settings) {
      replacePreferences(current.settings, preferences)
      storeOriginalPreferences(tx, current.settings)
      current.settings.settingsUpdatedAt = Math.max(localAt, sourceAt)
      current.settings.pending.settings = bumpMark(current.settings.pending.settings, rev)
      changed = true
    }
    if (Object.keys(copiedActivity).some((id) => !current.activity[id])) changed = true
    mergeActivityInTransaction(tx, current, copiedActivity, true, rev)
    if (changed) {
      current.settings.localRevision = rev
      tx.objectStore('settings').put(current.settings)
    }
    await current.done
    if (!studyLockCurrent(lock)) throw new Error('Account changed during the copy; reopen the original account to check it')
    return { state: changed ? 'copied' : 'already copied', cards: cards.length, tombstones: Object.keys(sourceSettings.deletedIds).length }
  } finally { db.close() }
}

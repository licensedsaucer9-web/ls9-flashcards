import type { Card, CardContent, DeckFile, Grade, LocalDeck, PublicSettings, Settings, Srs, Tier, UserFile, WordType } from './types.ts'
import { mergeDeck, mergeProgress, newerSettings, sameSrs } from './merge.ts'
import {
  applyAck,
  bumpMark,
  contentChanged,
  normalizePending,
  progressChanged,
  reconcileStagedProgress,
  type PushItem,
} from './record-sync.ts'
import { newSrs, review } from './srs.ts'
import { deviceTimeZone, mergeReviewActivity, parseStoredReviewActivity, streakTimeZone, validReviewEvent, type ReviewActivity, type ReviewEvent } from './streak.ts'
import { validateCard, validateMapping, validateSettings, validateSrs, validateTombstones } from './migration-data.ts'
import { bumpStudyGeneration, captureStudyLock, hasStudyBinding, studyLockCurrent, type StudyLock } from './study-lock.ts'
import { inSelectedTier, tierOf } from './tiers.ts'
import { inSelectedWordTypes, normalizeWordTypes, sameWordTypes } from './word-types.ts'
import { accountDatabaseName, activeUserSlug, dbNameForUser, hasMigrated, LEGACY_DB_NAME, listUsers, markMigrated } from './user.ts'

const DB_VERSION = 4
const LOCAL_DECK_ID = 'local-german'

export class DatabaseBlockedError extends Error {
  constructor() {
    super('Another tab is blocking a database upgrade. Close other LS9 Flashcards tabs and reload.')
    this.name = 'DatabaseBlockedError'
  }
}

export type DatabaseEvent = 'versionchange' | 'blocked'

const databaseListeners = new Set<(event: DatabaseEvent) => void>()
const upgradeClosed = new WeakSet<IDBDatabase>()

export function onDatabaseEvent(fn: (event: DatabaseEvent) => void): () => void {
  databaseListeners.add(fn)
  return () => databaseListeners.delete(fn)
}

function reportDatabaseEvent(event: DatabaseEvent): void {
  for (const fn of databaseListeners) fn(event)
}

export function attachDatabaseGuards(db: IDBDatabase): void {
  db.onversionchange = () => {
    upgradeClosed.add(db)
    db.close()
    reportDatabaseEvent('versionchange')
  }
}

function namesFor(explicitUser?: string): { lock: StudyLock; name: string } {
  const lock = captureStudyLock()
  const name = hasStudyBinding() ? lock.dbName : dbNameForUser(explicitUser ?? activeUserSlug())
  return { lock: { ...lock, dbName: name }, name }
}

/** A cloud pass stays bound to its original deck, including across tabs. */
export type CloudScope = { lock: StudyLock; deckId: string }

function cloudScopeCurrent(scope: CloudScope | undefined, settings: Settings): boolean {
  return !scope || (studyLockCurrent(scope.lock)
    && captureStudyLock().dbName === scope.lock.dbName
    && settings.activeDeckId === scope.deckId)
}

function upgradeAbort(db: IDBDatabase, error: unknown): boolean {
  if (!upgradeClosed.has(db)) return false
  if (!error || typeof error !== 'object') return true
  const name = 'name' in error ? String(error.name) : ''
  return name === 'AbortError' || name === 'InvalidStateError' || name === ''
}

function revision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function tier(value: unknown): Tier {
  return value === 1 || value === 2 || value === 3 ? value : 1
}

function stagedProgress(value: unknown): Record<string, Srs> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, Srs> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<Srs>
    if (typeof row.ease !== 'number' || typeof row.interval !== 'number' || typeof row.reps !== 'number' || typeof row.due !== 'number') {
      continue
    }
    out[id] = {
      ease: row.ease,
      interval: row.interval,
      reps: row.reps,
      due: row.due,
      ...(typeof row.updated_at === 'number' ? { updated_at: row.updated_at } : {}),
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function normalizeSettings(s?: Partial<Settings> | null): Settings {
  const localRevision = revision(s?.localRevision)
  const staged = stagedProgress(s?.stagedProgress)
  return {
    id: 'settings',
    activeDeckId: s?.activeDeckId || LOCAL_DECK_ID,
    direction: s?.direction === 'en-de' ? 'en-de' : 'de-en',
    sessionSize:
      typeof s?.sessionSize === 'number' && Number.isFinite(s.sessionSize)
        ? Math.max(0, Math.floor(s.sessionSize))
        : 20,
    tier: tier(s?.tier),
    wordTypes: normalizeWordTypes(s?.wordTypes),
    deletedIds: s?.deletedIds && typeof s.deletedIds === 'object' ? { ...s.deletedIds } : {},
    ...(s?.deletedDeckIds ? { deletedDeckIds: { ...s.deletedDeckIds } } : {}),
    localRevision,
    acknowledgedRevision: Math.min(localRevision, revision(s?.acknowledgedRevision)),
    settingsUpdatedAt: revision(s?.settingsUpdatedAt),
    pending: normalizePending(s?.pending),
    ...(staged ? { stagedProgress: staged } : {}),
  }
}

function openDb(name: string, upgrade = true, assignedDeckId?: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = upgrade ? indexedDB.open(name, DB_VERSION) : indexedDB.open(name)
    let settled = false
    let blockedTimer = 0
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      window.clearTimeout(blockedTimer)
      reject(error ?? new Error('Could not open the database'))
    }
    const succeed = (db: IDBDatabase) => {
      if (settled) {
        db.close()
        return
      }
      settled = true
      window.clearTimeout(blockedTimer)
      attachDatabaseGuards(db)
      resolve(db)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('activity')) db.createObjectStore('activity', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('decks')) {
        const id = assignedDeckId ?? LOCAL_DECK_ID
        db.createObjectStore('decks', { keyPath: 'id' }).add({
          id, name: 'German', targetLang: 'German', baseLang: 'English',
          articles: true, wordTypes: true, tiers: true, origin: 'original',
        } satisfies LocalDeck)
        const settings = req.transaction!.objectStore('settings')
        const stored = settings.get('settings')
        stored.onsuccess = () => {
          // Metadata alone is not device-study work. Keep a new database's
          // settings empty so welcome and guest-copy checks remain accurate.
          if (stored.result) settings.put({ ...stored.result, activeDeckId: id })
        }
      }
      const tx = req.transaction!
      const decks = tx.objectStore('decks').getAll()
      decks.onsuccess = () => {
        const original = (decks.result as LocalDeck[]).find(deck => deck.origin === 'original')
        const deckId = original?.id ?? assignedDeckId ?? LOCAL_DECK_ID
        const cursor = tx.objectStore('cards').openCursor()
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row) return
          if (!row.value.deckId) row.update({ ...row.value, deckId })
          row.continue()
        }
        const settings = tx.objectStore('settings').get('settings')
        settings.onsuccess = () => {
          if (!settings.result) return
          const stored = settings.result as Settings
          const owners = { ...stored.deletedDeckIds }
          for (const id of Object.keys(stored.deletedIds ?? {})) owners[id] ??= deckId
          if (Object.keys(owners).length) tx.objectStore('settings').put({ ...stored, deletedDeckIds: owners })
        }
      }
    }
    req.onblocked = () => {
      reportDatabaseEvent('blocked')
      window.clearTimeout(blockedTimer)
      blockedTimer = window.setTimeout(() => fail(new DatabaseBlockedError()), 1500)
    }
    req.onsuccess = () => succeed(req.result)
    req.onerror = () => {
      const error = req.error
      if (error?.name === 'VersionError') reportDatabaseEvent('blocked')
      fail(error)
    }
  })
}

/** Read metadata without copying, filtering or reseeding the existing cards. */
export async function getDecks(): Promise<LocalDeck[]> {
  const { lock, name } = namesFor()
  const db = await openDb(name, false)
  try {
    if (!studyLockCurrent(lock)) return []
    // Legacy recovery reads must not upgrade or stamp the source database.
    if (!db.objectStoreNames.contains('decks')) return [{
      id: LOCAL_DECK_ID, name: 'German', targetLang: 'German', baseLang: 'English',
      articles: true, wordTypes: true, tiers: true, origin: 'original',
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
      articles: false, wordTypes: false, tiers: false, origin: 'local',
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
      if (stored?.deletedDeckIds) {
        for (const [id, owner] of Object.entries(stored.deletedDeckIds)) if (owner === deck.id) stored.deletedDeckIds[id] = deckId
      }
    }
    tx.objectStore('settings').put({ ...normalizeSettings(stored), activeDeckId: !stored?.activeDeckId || stored.activeDeckId === deck?.id ? deckId : stored.activeDeckId })
    await done
  } finally { db.close() }
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function value<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

type Loaded = { cards: Card[]; settings: Settings; activity: ReviewActivity; done: Promise<void> }

type ActivityRow = ReviewEvent & { id: string }
function dataStores(db: IDBDatabase): string[] {
  return ['cards', 'settings', ...(db.objectStoreNames.contains('activity') ? ['activity'] : [])]
}
function activityRows(tx: IDBTransaction): Promise<ActivityRow[]> {
  return tx.objectStoreNames.contains('activity')
    ? value(tx.objectStore('activity').getAll()) as Promise<ActivityRow[]> : Promise.resolve([])
}
function activityFromRows(rows: ActivityRow[]): ReviewActivity {
  return parseStoredReviewActivity(Object.fromEntries(rows.map(({ id, ...event }) => [id, event])))
}

/** Persist zone repairs and remove unusable events/marks in the same transaction. */
function repairStoredActivity(tx: IDBTransaction, rows: ActivityRow[], settings: Settings): ReviewActivity {
  const activity = activityFromRows(rows)
  let changed = false
  for (const row of rows) {
    const event = activity[row.id]
    if (!event) tx.objectStore('activity').delete(row.id)
    else if (event.timeZone !== row.timeZone) tx.objectStore('activity').put({ id: row.id, ...event })
  }
  for (const id of Object.keys(settings.pending.activity ?? {})) {
    if (!activity[id]) { delete settings.pending.activity![id]; changed = true }
  }
  if (changed) tx.objectStore('settings').put(settings)
  return activity
}

function mergeActivityInTransaction(tx: IDBTransaction, current: Loaded, incoming: ReviewActivity, pending: boolean,
  rev = current.settings.localRevision + 1): ReviewActivity {
  let merged: ReviewActivity
  try { merged = mergeReviewActivity(current.activity, incoming) }
  catch (error) { tx.abort(); void current.done.catch(() => {}); throw error }
  for (const [id, event] of Object.entries(incoming)) {
    if (current.activity[id]) continue
    tx.objectStore('activity').put({ id, ...event })
    if (pending) (current.settings.pending.activity ??= {})[id] = bumpMark(undefined, rev)
  }
  return merged
}

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
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
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

/**
 * Read study stores in one readwrite transaction so revision counters and legacy
 * repairs are written in the same transaction as the data they describe.
 * The completion promise is returned rather than awaited: `oncomplete` fires once,
 * so a caller that still has work to do in this transaction must not wait on it yet.
 */
async function load(tx: IDBTransaction): Promise<Loaded> {
  const done = txDone(tx)
  const cardsRequest = tx.objectStore('cards').getAll()
  const settingsRequest = tx.objectStore('settings').get('settings')
  const [cards, stored, rows] = await Promise.all([
    value(cardsRequest) as Promise<Card[]>,
    value(settingsRequest) as Promise<Settings | undefined>,
    activityRows(tx),
  ])
  const settings = normalizeSettings(stored)
  let activity: ReviewActivity
  try { activity = repairStoredActivity(tx, rows, settings) }
  catch (error) { tx.abort(); await done.catch(() => {}); throw error }
  let dirty = false
  // A legacy row has no revision clock and may hold an unsynced grade, so its
  // first sync has to upload.
  if (stored?.localRevision === undefined && cards.length) {
    settings.localRevision = 1
    dirty = true
  }
  // A legacy row has no settingsUpdatedAt field at all. Derive one from local data so
  // the first merge keeps this device's direction and session size. A row that has the
  // field set to 0 is not legacy: it means settings have simply never been changed here,
  // and re-deriving from card edit times would mistake a vocabulary edit for a settings
  // change and rewrite every profile file.
  if (stored !== undefined && stored.settingsUpdatedAt === undefined) {
    settings.settingsUpdatedAt = legacySettingsClock(cards, settings.deletedIds)
    dirty = true
  }
  if (dirty) tx.objectStore('settings').put(settings)
  return { cards, settings, activity, done }
}

/** Newest card/tombstone time — used as a stand-in when a legacy settings row has no clock. */
function legacySettingsClock(cards: Card[], deletedIds: Record<string, number>): number {
  let t = 0
  for (const card of cards) t = Math.max(t, card.updated_at || card.created_at || 0)
  for (const time of Object.values(deletedIds)) t = Math.max(t, Number(time) || 0)
  return t
}

function srsTime(s: Srs | undefined): number {
  return typeof s?.updated_at === 'number' ? s.updated_at : 0
}

function contentTime(c: Pick<Card, 'updated_at' | 'created_at'>): number {
  return c.updated_at || c.created_at || 0
}

function publicSettings(settings: Settings): PublicSettings {
  return {
    direction: settings.direction,
    sessionSize: settings.sessionSize,
    tier: settings.tier,
    wordTypes: settings.wordTypes,
  }
}

// --- legacy import --------------------------------------------------------

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
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
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

// --- local projections ----------------------------------------------------

/** The shared vocabulary half. Deliberately excludes settings and progress clocks. */
function activeCards(cards: Card[], settings: Settings): Card[] {
  return cards.filter(card => !card.deckId || card.deckId === settings.activeDeckId)
}

function deckTombstones(settings: Settings, deckId = settings.activeDeckId): Record<string, number> {
  return Object.fromEntries(Object.entries(settings.deletedIds).filter(([id]) =>
    (settings.deletedDeckIds?.[id] ?? settings.activeDeckId) === deckId))
}

function mergeTombstones(settings: Settings, incoming: Record<string, number>): void {
  for (const [id, time] of Object.entries(incoming)) {
    if (settings.deletedDeckIds?.[id] && settings.deletedDeckIds[id] !== settings.activeDeckId) continue
    settings.deletedIds[id] = time
    ;(settings.deletedDeckIds ??= {})[id] = settings.activeDeckId
  }
}

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
    const { cards, settings, activity, done } = await load(db.transaction(['cards', 'settings', 'activity'], 'readwrite'))
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

async function changeLocal(change: (tx: IDBTransaction, settings: Settings) => void): Promise<void> {
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
      const settings = normalizeSettings(request.result as Settings | undefined)
      change(tx, settings)
      settings.localRevision += 1
      tx.objectStore('settings').put(settings)
    }
    await done.catch((error) => {
      if (aborted || !studyLockCurrent(lock) || upgradeAbort(db, error)) return
      throw error
    })
  } finally {
    db.close()
  }
}

// --- card reads and writes ------------------------------------------------

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

function noteCardWrite(settings: Settings, previous: Card | undefined, next: Card, rev: number): void {
  if (contentChanged(previous, next)) settings.pending.cards[next.id] = bumpMark(settings.pending.cards[next.id], rev)
  if (progressChanged(previous, next)) settings.pending.progress[next.id] = bumpMark(settings.pending.progress[next.id], rev)
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
      settings.deletedIds[id] = Math.max(settings.deletedIds[id] || 0, deletedAt)
      ;(settings.deletedDeckIds ??= {})[id] = settings.activeDeckId
      settings.pending.tombstones[id] = bumpMark(settings.pending.tombstones[id], settings.localRevision + 1)
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
  const out: DueByTier = { 1: { due: 0, total: 0 }, 2: { due: 0, total: 0 }, 3: { due: 0, total: 0 } }
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

export async function getSettings(): Promise<Settings> {
  const { lock, name } = namesFor()
  const db = await openDb(name, false)
  try {
    if (!studyLockCurrent(lock)) return normalizeSettings(null)
    const tx = db.transaction('settings', 'readonly')
    const settings = normalizeSettings((await value(tx.objectStore('settings').get('settings'))) as Settings | undefined)
    return studyLockCurrent(lock) ? settings : normalizeSettings(null)
  } finally {
    db.close()
  }
}

export async function putSettings(next: Partial<PublicSettings>): Promise<void> {
  await changeLocal((_tx, settings) => {
    const direction = next.direction ?? settings.direction
    const sessionSize = next.sessionSize ?? settings.sessionSize
    const nextTier = tier(next.tier ?? settings.tier)
    const nextTypes = next.wordTypes === undefined ? settings.wordTypes : normalizeWordTypes(next.wordTypes)
    if (
      settings.direction !== direction
      || settings.sessionSize !== sessionSize
      || settings.tier !== nextTier
      || !sameWordTypes(settings.wordTypes, nextTypes)
    ) {
      settings.settingsUpdatedAt = Math.max(Date.now(), settings.settingsUpdatedAt + 1)
      settings.pending.settings = bumpMark(settings.pending.settings, settings.localRevision + 1)
    }
    settings.direction = direction
    settings.sessionSize = sessionSize
    settings.tier = nextTier
    settings.wordTypes = nextTypes
  })
}

// --- remote merges --------------------------------------------------------

export type MergeResult = { deck: DeckFile; user: UserFile; revision: number; pending: boolean }

function untouchedMerge(user: string): MergeResult {
  const settings = normalizeSettings(null)
  return {
    deck: localDeckFile([], settings),
    user: localUserFile([], settings, user),
    revision: 0,
    pending: false,
  }
}

/** Apply a shared deck file. Card content merges; this user's progress is never touched. */
export async function mergeDeckIntoDb(remote: DeckFile, user = activeUserSlug(), scope?: CloudScope): Promise<MergeResult> {
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return untouchedMerge(user)
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) {
      tx.abort()
      await current.done.catch(() => {})
      return untouchedMerge(user)
    }
    const store = tx.objectStore('cards')
    const local = localDeckFile(current.cards, current.settings)
    const merged = mergeDeck(local, remote)

    const byId = new Map(activeCards(current.cards, current.settings).map((card) => [card.id, card]))
    // merged.cards is the union of both sides minus anything a tombstone removed,
    // so it is the whole truth. Seeding the result from the local cards instead
    // would keep every card a merge just deleted.
    const next = new Map<string, Card>()
    for (const content of merged.cards) {
      const mine = byId.get(content.id)
      // mergeDeck already settled which content wins. The only thing this device
      // owns here is the schedule, and a deck file never carries one.
      if (current.cards.some(card => card.id === content.id && card.deckId !== current.settings.activeDeckId)) continue
      next.set(content.id, { ...content, deckId: current.settings.activeDeckId, srs: mine?.srs ?? newSrs() })
    }

    for (const card of activeCards(current.cards, current.settings)) store.delete(card.id)
    for (const card of next.values()) store.put(card)
    mergeTombstones(current.settings, merged.deleted_ids)
    tx.objectStore('settings').put(current.settings)
    await current.done
    const cards = [...next.values()]
    return {
      deck: merged,
      user: localUserFile(cards, current.settings, user, current.activity),
      revision: current.settings.localRevision,
      pending: current.settings.localRevision > current.settings.acknowledgedRevision,
    }
  } finally {
    db.close()
  }
}

/** Apply one user's scheduling file. Ignores progress for cards this deck does not have. */
export async function mergeProgressIntoDb(remote: UserFile, user = activeUserSlug(), scope?: CloudScope): Promise<MergeResult> {
  const incomingActivity = parseStoredReviewActivity(remote.activity)
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return untouchedMerge(user)
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) {
      tx.abort()
      await current.done.catch(() => {})
      return untouchedMerge(user)
    }
    const store = tx.objectStore('cards')
    const next = new Map(activeCards(current.cards, current.settings).map((card) => [card.id, card]))
    const merged = mergeProgress(Object.fromEntries(activeCards(current.cards, current.settings).map((c) => [c.id, c.srs])), remote.progress)
    for (const [id, srs] of Object.entries(merged)) {
      const mine = next.get(id)
      // A deleted card must not come back just because progress for it arrived.
      if (!mine || !srs) continue
      // mergeProgress already decided the winner, including the tie case where both
      // sides have no clock — that is how a schedule migrated from a v1 snapshot, which
      // predates per-user progress clocks, gets adopted rather than dropped.
      if (!sameSrs(srs, mine.srs)) next.set(id, { ...mine, srs })
    }

    const localSettingsAt = current.settings.settingsUpdatedAt
    // A user file's updated_at is the newest of its settings *and* its progress, so it
    // must not stand in for the settings clock — otherwise any remote review would
    // look like a settings change and rewrite every profile file.
    const remoteSettingsAt = remote.settings_updated_at ?? 0
    const settings = newerSettings(publicSettings(current.settings), localSettingsAt, remote.settings, remoteSettingsAt)

    for (const card of activeCards(current.cards, current.settings)) store.delete(card.id)
    for (const card of next.values()) store.put(card)
    current.settings.direction = settings.direction
    current.settings.sessionSize = settings.sessionSize
    current.settings.tier = settings.tier
    current.settings.wordTypes = settings.wordTypes
    current.settings.settingsUpdatedAt = Math.max(localSettingsAt, remoteSettingsAt || 0)
    current.activity = mergeActivityInTransaction(tx, current, incomingActivity, false)
    tx.objectStore('settings').put(current.settings)
    await current.done
    const cards = [...next.values()]
    return {
      deck: localDeckFile(cards, current.settings),
      user: localUserFile(cards, current.settings, user, current.activity),
      revision: current.settings.localRevision,
      pending: current.settings.localRevision > current.settings.acknowledgedRevision,
    }
  } finally {
    db.close()
  }
}

export async function acknowledgeRevision(includedRevision: number, user = activeUserSlug(), scope?: CloudScope): Promise<boolean> {
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction('settings', 'readwrite')
    const done = txDone(tx)
    const request = tx.objectStore('settings').get('settings')
    let pending = false
    let aborted = false
    request.onsuccess = () => {
      if (!studyLockCurrent(lock)) {
        aborted = true
        tx.abort()
        return
      }
      const settings = normalizeSettings(request.result as Settings | undefined)
      if (!cloudScopeCurrent(scope, settings)) {
        aborted = true
        tx.abort()
        return
      }
      settings.acknowledgedRevision = Math.max(
        settings.acknowledgedRevision,
        Math.min(includedRevision, settings.localRevision),
      )
      pending = settings.localRevision > settings.acknowledgedRevision
      tx.objectStore('settings').put(settings)
    }
    await done.catch((error) => {
      if (aborted || !studyLockCurrent(lock)) return
      throw error
    })
    if (aborted || !studyLockCurrent(lock)) return false
    return pending
  } finally {
    db.close()
  }
}

export type CloudSnapshot = { cards: Map<string, Card>; settings: Settings; activity: ReviewActivity }

/** Cards and pending markers for one cloud push. Null when the account changed mid-read. */
export async function readCloudSnapshot(scope?: CloudScope): Promise<CloudSnapshot | null> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return null
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
    const { cards, settings, activity, done } = await load(tx)
    if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, settings)) {
      tx.abort()
      await done.catch(() => {})
      return null
    }
    await done
    if (!studyLockCurrent(lock)) return null
    const scoped = activeCards(cards, settings)
    const ids = new Set(scoped.map(card => card.id))
    const tombstones = deckTombstones(settings)
    settings.deletedIds = tombstones
    settings.pending.cards = Object.fromEntries(Object.entries(settings.pending.cards).filter(([id]) => ids.has(id)))
    settings.pending.progress = Object.fromEntries(Object.entries(settings.pending.progress).filter(([id]) => ids.has(id)))
    settings.pending.tombstones = Object.fromEntries(Object.entries(settings.pending.tombstones).filter(([id]) => Object.hasOwn(tombstones, id)))
    return { cards: new Map(scoped.map((card) => [card.id, card])), settings, activity }
  } finally {
    db.close()
  }
}

/**
 * Record the revision a transaction committed. A lock that no longer names the
 * same account writes nothing, so the acknowledgement cannot land on another uid.
 */
export async function acknowledgePending(
  item: PushItem,
  expect: { uid: string; generation: number; scope?: CloudScope },
): Promise<boolean> {
  const live = captureStudyLock()
  if (live.uid !== expect.uid || live.generation !== expect.generation) return false
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock) || lock.uid !== expect.uid) return false
    const tx = db.transaction('settings', 'readwrite')
    const done = txDone(tx)
    const request = tx.objectStore('settings').get('settings')
    let applied = false
    let aborted = false
    request.onsuccess = () => {
      if (!studyLockCurrent(lock) || captureStudyLock().uid !== expect.uid) {
        aborted = true
        tx.abort()
        return
      }
      const settings = normalizeSettings(request.result as Settings | undefined)
      if (!cloudScopeCurrent(expect.scope, settings)) {
        aborted = true
        tx.abort()
        return
      }
      if (item.kind === 'settings') {
        if (settings.pending.settings) settings.pending.settings = applyAck(settings.pending.settings, item.revision)
      } else if (item.kind === 'progress' || item.kind === 'activity') {
        const marks = item.kind === 'progress' ? settings.pending.progress : settings.pending.activity
        const mark = marks?.[item.id]
        if (mark) {
          const next = applyAck(mark, item.revision)
          if (item.kind === 'activity' && next.acked === next.revision) delete marks![item.id]
          else marks![item.id] = next
        }
      } else {
        if (item.contentRevision > 0) {
          const mark = settings.pending.cards[item.id]
          if (mark) settings.pending.cards[item.id] = applyAck(mark, item.contentRevision)
        }
        if (item.tombstoneRevision > 0) {
          const mark = settings.pending.tombstones[item.id]
          if (mark) settings.pending.tombstones[item.id] = applyAck(mark, item.tombstoneRevision)
        }
      }
      tx.objectStore('settings').put(settings)
      applied = true
    }
    await done.catch((error) => {
      if (aborted || !studyLockCurrent(lock)) return
      throw error
    })
    return applied && studyLockCurrent(lock) && captureStudyLock().uid === expect.uid
  } finally {
    db.close()
  }
}

/** Attach schedules that were copied before the matching cards existed. */
export async function applyStagedProgress(scope?: CloudScope): Promise<void> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
    const current = await load(tx)
    const staged = current.settings.stagedProgress
    if (!staged || !studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) {
      if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) tx.abort()
      await current.done.catch(() => {})
      return
    }
    const store = tx.objectStore('cards')
    const byId = new Map(activeCards(current.cards, current.settings).map((card) => [card.id, card]))
    let changed = false
    const rev = current.settings.localRevision + 1
    for (const [id, srs] of Object.entries(staged)) {
      delete staged[id]
      const mine = byId.get(id)
      if (!mine) continue
      const merged = reconcileStagedProgress(srs, mine.srs)
      if (sameSrs(merged, mine.srs)) continue
      store.put({ ...mine, srs: merged })
      current.settings.pending.progress[id] = bumpMark(current.settings.pending.progress[id], rev)
      changed = true
    }
    if (!Object.keys(staged).length) delete current.settings.stagedProgress
    else current.settings.stagedProgress = staged
    if (changed) current.settings.localRevision = rev
    tx.objectStore('settings').put(current.settings)
    await current.done
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
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
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
      || current.settings.tier !== preferences.tier || !sameWordTypes(current.settings.wordTypes, preferences.wordTypes)
      || sourceAt > localAt || !current.settings.pending.settings) {
      Object.assign(current.settings, preferences)
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

export type GuestCopyMode = 'progress' | 'vocabulary'

/**
 * Copy a signed-out database into the database the current study lock names.
 * Progress copies schedules and settings only. Vocabulary also copies cards and deletions.
 * The source database is left in place. A lock that changed mid-copy writes nothing.
 */
export async function copyGuestDatabase(sourceName: string, mode: GuestCopyMode): Promise<boolean> {
  const lock = captureStudyLock()
  if (!lock.dbName || sourceName === lock.dbName) return false
  const source = await openDb(sourceName, false)
  let cards: Card[] = []
  let stored: Settings | undefined
  let sourceActivity: ActivityRow[]
  try {
    const tx = source.transaction(dataStores(source), 'readonly')
    const cardsRequest = tx.objectStore('cards').getAll()
    const settingsRequest = tx.objectStore('settings').get('settings')
    ;[cards, stored, sourceActivity] = await Promise.all([
      value(cardsRequest) as Promise<Card[]>,
      value(settingsRequest) as Promise<Settings | undefined>,
      activityRows(tx),
    ])
  } finally {
    source.close()
  }
  if (!studyLockCurrent(lock)) return false
  const copiedActivity = activityFromRows(sourceActivity)
  const db = await openDb(lock.dbName)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction(['cards', 'settings', 'activity'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock)) {
      tx.abort()
      await current.done.catch(() => {})
      return false
    }
    const sourceSettings = stored ? normalizeSettings(stored) : null
    cards = activeCards(cards, sourceSettings ?? normalizeSettings(null))
    const store = tx.objectStore('cards')
    const rev = current.settings.localRevision + 1
    if (mode === 'vocabulary') {
      const tombstoned = new Set<string>()
      if (sourceSettings) {
        for (const [id, time] of Object.entries(deckTombstones(sourceSettings))) {
          if ((Number(time) || 0) > 0) tombstoned.add(id)
        }
      }
      for (const card of cards) {
        if (current.cards.some(mine => mine.id === card.id && mine.deckId !== current.settings.activeDeckId)) continue
        if (tombstoned.has(card.id)) continue
        store.put({ ...card, deckId: current.settings.activeDeckId })
        current.settings.pending.cards[card.id] = bumpMark(current.settings.pending.cards[card.id], rev)
        current.settings.pending.progress[card.id] = bumpMark(current.settings.pending.progress[card.id], rev)
      }
      for (const id of tombstoned) {
        if (current.cards.some(mine => mine.id === id && mine.deckId !== current.settings.activeDeckId)) continue
        if (current.settings.deletedDeckIds?.[id] && current.settings.deletedDeckIds[id] !== current.settings.activeDeckId) continue
        const stamp = Number(sourceSettings?.deletedIds[id]) || 0
        ;(current.settings.deletedDeckIds ??= {})[id] = current.settings.activeDeckId
        current.settings.deletedIds[id] = Math.max(current.settings.deletedIds[id] || 0, stamp)
        store.delete(id)
        current.settings.pending.tombstones[id] = bumpMark(current.settings.pending.tombstones[id], rev)
      }
    } else {
      const byId = new Map(activeCards(current.cards, current.settings).map((card) => [card.id, card]))
      const staged = { ...(current.settings.stagedProgress ?? {}) }
      for (const card of cards) {
        if (!card.srs) continue
        const mine = byId.get(card.id)
        if (!mine) {
          staged[card.id] = card.srs
          continue
        }
        if (sameSrs(card.srs, mine.srs)) continue
        store.put({ ...mine, srs: card.srs })
        current.settings.pending.progress[card.id] = bumpMark(current.settings.pending.progress[card.id], rev)
      }
      if (Object.keys(staged).length) current.settings.stagedProgress = staged
      else delete current.settings.stagedProgress
    }
    if (sourceSettings) {
      const settingsChanged = current.settings.direction !== sourceSettings.direction
        || current.settings.sessionSize !== sourceSettings.sessionSize
        || current.settings.tier !== sourceSettings.tier
        || !sameWordTypes(current.settings.wordTypes, sourceSettings.wordTypes)
        || sourceSettings.settingsUpdatedAt > current.settings.settingsUpdatedAt
      current.settings.direction = sourceSettings.direction
      current.settings.sessionSize = sourceSettings.sessionSize
      current.settings.tier = sourceSettings.tier
      current.settings.wordTypes = sourceSettings.wordTypes
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

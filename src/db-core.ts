import { type Card, type LocalDeck, type PublicSettings, type Settings, type Srs, type Tier } from './types.ts'
import { isTier } from './types.ts'
import { bumpMark, contentChanged, normalizePending, progressChanged } from './record-sync.ts'
import { mergeReviewActivity, parseStoredReviewActivity, type ReviewActivity, type ReviewEvent } from './streak.ts'
import { captureStudyLock, hasStudyBinding, studyLockCurrent, type StudyLock } from './study-lock.ts'
import { reviewTiers, validSelectedTiers } from './tiers.ts'
import { normalizeWordTypes } from './word-types.ts'
import { activeUserSlug, dbNameForUser } from './user.ts'

const DB_VERSION = 5

export const LOCAL_DECK_ID = 'local-german'

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

export function namesFor(explicitUser?: string): { lock: StudyLock; name: string } {
  const lock = captureStudyLock()
  const name = hasStudyBinding() ? lock.dbName : dbNameForUser(explicitUser ?? activeUserSlug())
  return { lock: { ...lock, dbName: name }, name }
}

/** A cloud pass stays bound to its original deck, including across tabs. */
export type CloudScope = { lock: StudyLock; deckId: string }

export function cloudScopeCurrent(scope: CloudScope | undefined, settings: Settings): boolean {
  return !scope || (studyLockCurrent(scope.lock)
    && captureStudyLock().dbName === scope.lock.dbName
    && settings.activeDeckId === scope.deckId)
}

export function upgradeAbort(db: IDBDatabase, error: unknown): boolean {
  if (!upgradeClosed.has(db)) return false
  if (!error || typeof error !== 'object') return true
  const name = 'name' in error ? String(error.name) : ''
  return name === 'AbortError' || name === 'InvalidStateError' || name === ''
}

export function revision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function tier(value: unknown): Tier {
  return isTier(value) ? value : 1
}

export function stagedProgress(value: unknown): Record<string, Srs> | undefined {
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
    ...(validSelectedTiers(s?.selectedTiers) ? { selectedTiers: reviewTiers(s as Settings) } : {}),
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

/** Account settings remain the original deck's cloud-compatible mirror. */
export function storeOriginalPreferences(tx: IDBTransaction, settings: Settings): void {
  const request = tx.objectStore('decks').getAll()
  const preferences = publicSettings(settings)
  request.onsuccess = () => {
    const original = (request.result as LocalDeck[]).find(deck => deck.origin === 'original')
    if (original) tx.objectStore('decks').put(replacePreferences({ ...original }, preferences))
  }
}

export function openDb(name: string, upgrade = true, assignedDeckId?: string): Promise<IDBDatabase> {
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
          articles: true, supportsWordTypes: true, tiers: true,
          origin: 'original',
        })
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
          const stored = settings.result as Settings | undefined
          for (const deck of decks.result as LocalDeck[]) {
            if (deck.direction !== undefined) continue
            tx.objectStore('decks').put({
              ...deck,
              supportsWordTypes: deck.supportsWordTypes ?? (deck as unknown as { wordTypes: unknown }).wordTypes === true,
              ...(deck.origin === 'original' ? publicSettings(normalizeSettings(stored))
                : { direction: 'de-en', sessionSize: 20, tier: 4, wordTypes: [] }),
            })
          }
          if (!stored) return
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

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export function value<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

type Loaded = { cards: Card[]; settings: Settings; activity: ReviewActivity; done: Promise<void> }

export type ActivityRow = ReviewEvent & { id: string }

export function dataStores(db: IDBDatabase): string[] {
  return ['cards', 'settings', ...(db.objectStoreNames.contains('activity') ? ['activity'] : [])]
}

export function activityRows(tx: IDBTransaction): Promise<ActivityRow[]> {
  return tx.objectStoreNames.contains('activity')
    ? value(tx.objectStore('activity').getAll()) as Promise<ActivityRow[]> : Promise.resolve([])
}

export function activityFromRows(rows: ActivityRow[]): ReviewActivity {
  return parseStoredReviewActivity(Object.fromEntries(rows.map(({ id, ...event }) => [id, event])))
}

/** Persist zone repairs and remove unusable events/marks in the same transaction. */
export function repairStoredActivity(tx: IDBTransaction, rows: ActivityRow[], settings: Settings): ReviewActivity {
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

export function mergeActivityInTransaction(tx: IDBTransaction, current: Loaded, incoming: ReviewActivity, pending: boolean,
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

/**
 * Read study stores in one readwrite transaction so revision counters and legacy
 * repairs are written in the same transaction as the data they describe.
 * The completion promise is returned rather than awaited: `oncomplete` fires once,
 * so a caller that still has work to do in this transaction must not wait on it yet.
 */
export async function load(tx: IDBTransaction): Promise<Loaded> {
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
export function legacySettingsClock(cards: Card[], deletedIds: Record<string, number>): number {
  let t = 0
  for (const card of cards) t = Math.max(t, card.updated_at || card.created_at || 0)
  for (const time of Object.values(deletedIds)) t = Math.max(t, Number(time) || 0)
  return t
}

export function srsTime(s: Srs | undefined): number {
  return typeof s?.updated_at === 'number' ? s.updated_at : 0
}

export function contentTime(c: Pick<Card, 'updated_at' | 'created_at'>): number {
  return c.updated_at || c.created_at || 0
}

export function publicSettings(settings: PublicSettings): PublicSettings {
  return {
    direction: settings.direction,
    sessionSize: settings.sessionSize,
    tier: settings.tier,
    ...(validSelectedTiers(settings.selectedTiers) ? { selectedTiers: reviewTiers(settings) } : {}),
    wordTypes: settings.wordTypes,
  }
}

/** Replace optional selection too when a newer legacy client omits it. */
export function replacePreferences<T extends PublicSettings>(target: T, preferences: PublicSettings): T {
  delete target.selectedTiers
  return Object.assign(target, preferences)
}

/** The shared vocabulary half. Deliberately excludes settings and progress clocks. */
export function activeCards(cards: Card[], settings: Settings): Card[] {
  return cards.filter(card => !card.deckId || card.deckId === settings.activeDeckId)
}

export function deckTombstones(settings: Settings, deckId = settings.activeDeckId): Record<string, number> {
  return Object.fromEntries(Object.entries(settings.deletedIds).filter(([id]) =>
    (settings.deletedDeckIds?.[id] ?? settings.activeDeckId) === deckId))
}

export function mergeTombstones(settings: Settings, incoming: Record<string, number>): void {
  for (const [id, time] of Object.entries(incoming)) {
    if (settings.deletedDeckIds?.[id] && settings.deletedDeckIds[id] !== settings.activeDeckId) continue
    settings.deletedIds[id] = time
    ;(settings.deletedDeckIds ??= {})[id] = settings.activeDeckId
  }
}

export function noteCardWrite(settings: Settings, previous: Card | undefined, next: Card, rev: number): void {
  if (contentChanged(previous, next)) settings.pending.cards[next.id] = { ...bumpMark(settings.pending.cards[next.id], rev), deckId: next.deckId ?? settings.activeDeckId }
  if (progressChanged(previous, next)) settings.pending.progress[next.id] = { ...bumpMark(settings.pending.progress[next.id], rev), deckId: next.deckId ?? settings.activeDeckId }
}

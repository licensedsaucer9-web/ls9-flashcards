import type { Card, CardContent, DeckFile, PublicSettings, Settings, Srs, Tier, UserFile } from './types.ts'
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
import { newSrs } from './srs.ts'
import { captureStudyLock, hasStudyBinding, studyLockCurrent, type StudyLock } from './study-lock.ts'
import { inSelectedTier, tierOf } from './tiers.ts'
import { activeUserSlug, dbNameForUser, hasMigrated, LEGACY_DB_NAME, markMigrated } from './user.ts'

const DB_VERSION = 1

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
    direction: s?.direction === 'en-de' ? 'en-de' : 'de-en',
    sessionSize:
      typeof s?.sessionSize === 'number' && Number.isFinite(s.sessionSize)
        ? Math.max(0, Math.floor(s.sessionSize))
        : 20,
    tier: tier(s?.tier),
    deletedIds: s?.deletedIds && typeof s.deletedIds === 'object' ? { ...s.deletedIds } : {},
    localRevision,
    acknowledgedRevision: Math.min(localRevision, revision(s?.acknowledgedRevision)),
    settingsUpdatedAt: revision(s?.settingsUpdatedAt),
    pending: normalizePending(s?.pending),
    ...(staged ? { stagedProgress: staged } : {}),
  }
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION)
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

type Loaded = { cards: Card[]; settings: Settings; done: Promise<void> }

/**
 * Read both stores in one readwrite transaction so revision counters and legacy
 * repairs are written in the same transaction as the data they describe.
 * The completion promise is returned rather than awaited: `oncomplete` fires once,
 * so a caller that still has work to do in this transaction must not wait on it yet.
 */
async function load(tx: IDBTransaction): Promise<Loaded> {
  const done = txDone(tx)
  const cardsRequest = tx.objectStore('cards').getAll()
  const settingsRequest = tx.objectStore('settings').get('settings')
  const [cards, stored] = await Promise.all([
    value(cardsRequest) as Promise<Card[]>,
    value(settingsRequest) as Promise<Settings | undefined>,
  ])
  const settings = normalizeSettings(stored)
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
  return { cards, settings, done }
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
  return { direction: settings.direction, sessionSize: settings.sessionSize, tier: settings.tier }
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
  const legacy = await openDb(LEGACY_DB_NAME)
  let cards: Card[] = []
  let settings: Settings | undefined
  try {
    const tx = legacy.transaction(['cards', 'settings'], 'readonly')
    const [oldCards, oldSettings] = await Promise.all([
      value(tx.objectStore('cards').getAll()) as Promise<Card[]>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
    ])
    cards = oldCards
    settings = oldSettings
  } finally {
    legacy.close()
  }
  if (!cards.length && !settings) {
    markMigrated()
    return 0
  }

  const db = await openDb(target)
  try {
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
    const store = tx.objectStore('cards')
    const byId = new Set(current.cards.map((c) => c.id))
    let added = 0
    for (const card of cards) {
      if (byId.has(card.id) || current.settings.deletedIds[card.id]) continue
      store.put(card)
      added += 1
    }
    const next = normalizeSettings(settings)
    // A row that already exists on this device wins; only fill the gaps.
    if (next.localRevision > current.settings.localRevision || added) next.localRevision = current.settings.localRevision + 1
    next.deletedIds = { ...next.deletedIds, ...current.settings.deletedIds }
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
export function localDeckFile(cards: Card[], settings: Settings): DeckFile {
  let updatedAt = 0
  for (const card of cards) updatedAt = Math.max(updatedAt, contentTime(card))
  for (const time of Object.values(settings.deletedIds)) updatedAt = Math.max(updatedAt, Number(time) || 0)
  return {
    version: 2,
    kind: 'deck',
    updated_at: updatedAt,
    // Sorted by id so a payload compare against the remote is not fooled by the
    // order IndexedDB happens to return rows in.
    cards: cards.map(stripSrs).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    deleted_ids: settings.deletedIds,
  }
}

/** This user's scheduling half. */
export function localUserFile(cards: Card[], settings: Settings, user = activeUserSlug()): UserFile {
  let updatedAt = settings.settingsUpdatedAt
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
    const { cards, settings, done } = await load(db.transaction(['cards', 'settings'], 'readwrite'))
    await done
    if (!studyLockCurrent(lock)) {
      const empty = normalizeSettings(null)
      return { snapshot: { deck: localDeckFile([], empty), user: localUserFile([], empty, user) }, settings: empty }
    }
    return { snapshot: { deck: localDeckFile(cards, settings), user: localUserFile(cards, settings, user) }, settings }
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
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return []
    const tx = db.transaction('cards', 'readonly')
    const cards = (await value(tx.objectStore('cards').getAll())) as Card[]
    return studyLockCurrent(lock) ? cards : []
  } finally {
    db.close()
  }
}

export async function getCard(id: string): Promise<Card | undefined> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return undefined
    const tx = db.transaction('cards', 'readonly')
    const card = (await value(tx.objectStore('cards').get(id))) as Card | undefined
    return studyLockCurrent(lock) ? card : undefined
  } finally {
    db.close()
  }
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
      noteCardWrite(settings, request.result as Card | undefined, card, settings.localRevision + 1)
      store.put(card)
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
        noteCardWrite(settings, item.request.result as Card | undefined, item.card, settings.localRevision + 1)
        store.put(item.card)
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
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock)) {
      tx.abort()
      await current.done.catch(() => {})
      return 0
    }
    const byId = new Map(current.cards.map((card) => [card.id, card]))
    const key = (card: Card) => `${card.de.trim().toLowerCase()}|${card.en.trim().toLowerCase()}`
    const byKey = new Set(current.cards.map(key))
    const store = tx.objectStore('cards')
    let added = 0
    const addedIds: string[] = []
    const repairedIds: string[] = []
    for (const seed of seeds) {
      if (current.settings.deletedIds[seed.id]) continue
      const mine = byId.get(seed.id)
      if (mine) {
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
      store.put(seed)
      byId.set(seed.id, seed)
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
  await changeLocal((tx, settings) => {
    tx.objectStore('cards').delete(id)
    settings.deletedIds[id] = Math.max(settings.deletedIds[id] || 0, deletedAt)
    settings.pending.tombstones[id] = bumpMark(settings.pending.tombstones[id], settings.localRevision + 1)
  })
}

export async function countCards(): Promise<number> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return 0
    const tx = db.transaction('cards', 'readonly')
    const count = await value(tx.objectStore('cards').count())
    return studyLockCurrent(lock) ? count : 0
  } finally {
    db.close()
  }
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

/** Omitting a tier returns the whole deck, which is what the deck list wants. */
export async function getDueCards(selected?: Tier, now = Date.now()): Promise<Card[]> {
  const cards = await getAllCards()
  const inScope = selected === undefined ? cards : inSelectedTier(cards, selected)
  return inScope
    .filter((card) => card.srs.due <= now)
    .sort((a, b) => a.srs.due - b.srs.due || a.de.localeCompare(b.de, 'de'))
}

export async function getSettings(): Promise<Settings> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
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
    if (settings.direction !== direction || settings.sessionSize !== sessionSize || settings.tier !== nextTier) {
      settings.settingsUpdatedAt = Math.max(Date.now(), settings.settingsUpdatedAt + 1)
      settings.pending.settings = bumpMark(settings.pending.settings, settings.localRevision + 1)
    }
    settings.direction = direction
    settings.sessionSize = sessionSize
    settings.tier = nextTier
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
export async function mergeDeckIntoDb(remote: DeckFile, user = activeUserSlug()): Promise<MergeResult> {
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return untouchedMerge(user)
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock)) {
      tx.abort()
      await current.done.catch(() => {})
      return untouchedMerge(user)
    }
    const store = tx.objectStore('cards')
    const local = localDeckFile(current.cards, current.settings)
    const merged = mergeDeck(local, remote)

    const byId = new Map(current.cards.map((card) => [card.id, card]))
    // merged.cards is the union of both sides minus anything a tombstone removed,
    // so it is the whole truth. Seeding the result from the local cards instead
    // would keep every card a merge just deleted.
    const next = new Map<string, Card>()
    for (const content of merged.cards) {
      const mine = byId.get(content.id)
      // mergeDeck already settled which content wins. The only thing this device
      // owns here is the schedule, and a deck file never carries one.
      next.set(content.id, mine ? ({ ...content, srs: mine.srs } as Card) : ({ ...content, srs: newSrs() } as Card))
    }

    store.clear()
    for (const card of next.values()) store.put(card)
    current.settings.deletedIds = merged.deleted_ids
    tx.objectStore('settings').put(current.settings)
    await current.done
    const cards = [...next.values()]
    return {
      deck: merged,
      user: localUserFile(cards, current.settings, user),
      revision: current.settings.localRevision,
      pending: current.settings.localRevision > current.settings.acknowledgedRevision,
    }
  } finally {
    db.close()
  }
}

/** Apply one user's scheduling file. Ignores progress for cards this deck does not have. */
export async function mergeProgressIntoDb(remote: UserFile, user = activeUserSlug()): Promise<MergeResult> {
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return untouchedMerge(user)
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock)) {
      tx.abort()
      await current.done.catch(() => {})
      return untouchedMerge(user)
    }
    const store = tx.objectStore('cards')
    const next = new Map(current.cards.map((card) => [card.id, card]))
    const merged = mergeProgress(Object.fromEntries(current.cards.map((c) => [c.id, c.srs])), remote.progress)
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

    store.clear()
    for (const card of next.values()) store.put(card)
    current.settings.direction = settings.direction
    current.settings.sessionSize = settings.sessionSize
    current.settings.tier = settings.tier
    current.settings.settingsUpdatedAt = Math.max(localSettingsAt, remoteSettingsAt || 0)
    tx.objectStore('settings').put(current.settings)
    await current.done
    const cards = [...next.values()]
    return {
      deck: localDeckFile(cards, current.settings),
      user: localUserFile(cards, current.settings, user),
      revision: current.settings.localRevision,
      pending: current.settings.localRevision > current.settings.acknowledgedRevision,
    }
  } finally {
    db.close()
  }
}

export async function acknowledgeRevision(includedRevision: number, user = activeUserSlug()): Promise<boolean> {
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

export type CloudSnapshot = { cards: Map<string, Card>; settings: Settings }

/** Cards and pending markers for one cloud push. Null when the account changed mid-read. */
export async function readCloudSnapshot(): Promise<CloudSnapshot | null> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return null
    const { cards, settings, done } = await load(db.transaction(['cards', 'settings'], 'readwrite'))
    await done
    if (!studyLockCurrent(lock)) return null
    return { cards: new Map(cards.map((card) => [card.id, card])), settings }
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
  expect: { uid: string; generation: number },
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
      if (item.kind === 'settings') {
        if (settings.pending.settings) settings.pending.settings = applyAck(settings.pending.settings, item.revision)
      } else if (item.kind === 'progress') {
        const mark = settings.pending.progress[item.id]
        if (mark) settings.pending.progress[item.id] = applyAck(mark, item.revision)
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
export async function applyStagedProgress(): Promise<void> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
    const staged = current.settings.stagedProgress
    if (!staged || !studyLockCurrent(lock)) {
      if (!studyLockCurrent(lock)) tx.abort()
      await current.done.catch(() => {})
      return
    }
    const store = tx.objectStore('cards')
    const byId = new Map(current.cards.map((card) => [card.id, card]))
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
  const db = await openDb(name)
  try {
    const tx = db.transaction(['cards', 'settings'], 'readonly')
    const cardsRequest = tx.objectStore('cards').count()
    const settingsRequest = tx.objectStore('settings').count()
    const [cards, settings] = await Promise.all([value(cardsRequest), value(settingsRequest)])
    return cards > 0 || settings > 0
  } finally {
    db.close()
  }
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
  const source = await openDb(sourceName)
  let cards: Card[] = []
  let stored: Settings | undefined
  try {
    const tx = source.transaction(['cards', 'settings'], 'readonly')
    const cardsRequest = tx.objectStore('cards').getAll()
    const settingsRequest = tx.objectStore('settings').get('settings')
    ;[cards, stored] = await Promise.all([
      value(cardsRequest) as Promise<Card[]>,
      value(settingsRequest) as Promise<Settings | undefined>,
    ])
  } finally {
    source.close()
  }
  if (!studyLockCurrent(lock)) return false
  const db = await openDb(lock.dbName)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock)) {
      tx.abort()
      await current.done.catch(() => {})
      return false
    }
    const sourceSettings = stored ? normalizeSettings(stored) : null
    const store = tx.objectStore('cards')
    const rev = current.settings.localRevision + 1
    if (mode === 'vocabulary') {
      const tombstoned = new Set<string>()
      if (sourceSettings) {
        for (const [id, time] of Object.entries(sourceSettings.deletedIds)) {
          if ((Number(time) || 0) > 0) tombstoned.add(id)
        }
      }
      for (const card of cards) {
        if (tombstoned.has(card.id)) continue
        store.put(card)
        current.settings.pending.cards[card.id] = bumpMark(current.settings.pending.cards[card.id], rev)
        current.settings.pending.progress[card.id] = bumpMark(current.settings.pending.progress[card.id], rev)
      }
      for (const id of tombstoned) {
        const stamp = Number(sourceSettings?.deletedIds[id]) || 0
        current.settings.deletedIds[id] = Math.max(current.settings.deletedIds[id] || 0, stamp)
        store.delete(id)
        current.settings.pending.tombstones[id] = bumpMark(current.settings.pending.tombstones[id], rev)
      }
    } else {
      const byId = new Map(current.cards.map((card) => [card.id, card]))
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
        || sourceSettings.settingsUpdatedAt > current.settings.settingsUpdatedAt
      current.settings.direction = sourceSettings.direction
      current.settings.sessionSize = sourceSettings.sessionSize
      current.settings.tier = sourceSettings.tier
      if (sourceSettings.settingsUpdatedAt > current.settings.settingsUpdatedAt) {
        current.settings.settingsUpdatedAt = sourceSettings.settingsUpdatedAt
      }
      if (settingsChanged) current.settings.pending.settings = bumpMark(current.settings.pending.settings, rev)
    }
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

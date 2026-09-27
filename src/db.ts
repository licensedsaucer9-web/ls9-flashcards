import type { Card, CardContent, DeckFile, PublicSettings, Settings, Srs, Tier, UserFile } from './types.ts'
import { mergeDeck, mergeProgress, newerSettings, sameSrs } from './merge.ts'
import { newSrs } from './srs.ts'
import { inSelectedTier, tierOf } from './tiers.ts'
import { activeUserSlug, dbNameForUser, hasMigrated, LEGACY_DB_NAME, markMigrated } from './user.ts'

const DB_VERSION = 1

function revision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function tier(value: unknown): Tier {
  return value === 1 || value === 2 || value === 3 ? value : 1
}

export function normalizeSettings(s?: Partial<Settings> | null): Settings {
  const localRevision = revision(s?.localRevision)
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
  }
}

function openDb(name = dbNameForUser(activeUserSlug())): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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
export async function importLegacyData(): Promise<number> {
  if (hasMigrated()) return 0
  const user = activeUserSlug()
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

  const db = await openDb(dbNameForUser(user))
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
  const db = await openDb(dbNameForUser(user))
  try {
    const { cards, settings, done } = await load(db.transaction(['cards', 'settings'], 'readwrite'))
    await done
    return { snapshot: { deck: localDeckFile(cards, settings), user: localUserFile(cards, settings, user) }, settings }
  } finally {
    db.close()
  }
}

async function changeLocal(change: (tx: IDBTransaction, settings: Settings) => void): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const done = txDone(tx)
    const request = tx.objectStore('settings').get('settings')
    request.onsuccess = () => {
      const settings = normalizeSettings(request.result as Settings | undefined)
      change(tx, settings)
      settings.localRevision += 1
      tx.objectStore('settings').put(settings)
    }
    await done
  } finally {
    db.close()
  }
}

// --- card reads and writes ------------------------------------------------

export async function getAllCards(): Promise<Card[]> {
  const db = await openDb()
  try {
    const tx = db.transaction('cards', 'readonly')
    return (await value(tx.objectStore('cards').getAll())) as Card[]
  } finally {
    db.close()
  }
}

export async function getCard(id: string): Promise<Card | undefined> {
  const db = await openDb()
  try {
    const tx = db.transaction('cards', 'readonly')
    return (await value(tx.objectStore('cards').get(id))) as Card | undefined
  } finally {
    db.close()
  }
}

export async function putCard(card: Card): Promise<void> {
  await changeLocal((tx) => tx.objectStore('cards').put(card))
}

export async function putCards(cards: Card[]): Promise<void> {
  if (!cards.length) return
  await changeLocal((tx) => {
    const store = tx.objectStore('cards')
    for (const card of cards) store.put(card)
  })
}

/** Seed against current cards and tombstones in one transaction. */
export async function insertMissingSeeds(seeds: Card[]): Promise<number> {
  const db = await openDb()
  try {
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
    const byId = new Map(current.cards.map((card) => [card.id, card]))
    const key = (card: Card) => `${card.de.trim().toLowerCase()}|${card.en.trim().toLowerCase()}`
    const byKey = new Set(current.cards.map(key))
    const store = tx.objectStore('cards')
    let added = 0
    let repaired = 0
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
          repaired += 1
        }
        continue
      }
      const pair = key(seed)
      if (byKey.has(pair)) continue
      store.put(seed)
      byId.set(seed.id, seed)
      byKey.add(pair)
      added += 1
    }
    if (added || repaired) {
      current.settings.localRevision += 1
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
  })
}

export async function countCards(): Promise<number> {
  const db = await openDb()
  try {
    const tx = db.transaction('cards', 'readonly')
    return await value(tx.objectStore('cards').count())
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
  const db = await openDb()
  try {
    const tx = db.transaction('settings', 'readonly')
    return normalizeSettings((await value(tx.objectStore('settings').get('settings'))) as Settings | undefined)
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
    }
    settings.direction = direction
    settings.sessionSize = sessionSize
    settings.tier = nextTier
  })
}

// --- remote merges --------------------------------------------------------

export type MergeResult = { deck: DeckFile; user: UserFile; revision: number; pending: boolean }

/** Apply a shared deck file. Card content merges; this user's progress is never touched. */
export async function mergeDeckIntoDb(remote: DeckFile, user = activeUserSlug()): Promise<MergeResult> {
  const db = await openDb(dbNameForUser(user))
  try {
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
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
  const db = await openDb(dbNameForUser(user))
  try {
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const current = await load(tx)
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
  const db = await openDb(dbNameForUser(user))
  try {
    const tx = db.transaction('settings', 'readwrite')
    const done = txDone(tx)
    const request = tx.objectStore('settings').get('settings')
    let pending = false
    request.onsuccess = () => {
      const settings = normalizeSettings(request.result as Settings | undefined)
      settings.acknowledgedRevision = Math.max(
        settings.acknowledgedRevision,
        Math.min(includedRevision, settings.localRevision),
      )
      pending = settings.localRevision > settings.acknowledgedRevision
      tx.objectStore('settings').put(settings)
    }
    await done
    return pending
  } finally {
    db.close()
  }
}

import type { Card, Settings, Snapshot } from './types.ts'
import { mergeSnapshots } from './merge.ts'

const DB_NAME = 'german-flashcards'
const DB_VERSION = 1

function revision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
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
    deletedIds: s?.deletedIds && typeof s.deletedIds === 'object' ? { ...s.deletedIds } : {},
    localRevision,
    acknowledgedRevision: Math.min(localRevision, revision(s?.acknowledgedRevision)),
    settingsUpdatedAt: revision(s?.settingsUpdatedAt),
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
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

function localSnapshot(cards: Card[], settings: Settings): Snapshot {
  let updatedAt = settings.settingsUpdatedAt
  for (const card of cards) updatedAt = Math.max(updatedAt, card.updated_at || card.created_at || 0)
  for (const time of Object.values(settings.deletedIds)) updatedAt = Math.max(updatedAt, Number(time) || 0)
  return {
    version: 1,
    updated_at: updatedAt,
    settings_updated_at: settings.settingsUpdatedAt,
    settings: { direction: settings.direction, sessionSize: settings.sessionSize },
    cards,
    deleted_ids: settings.deletedIds,
  }
}

/** A legacy DB may contain an unsynced grade, so its first sync must upload it. */
export async function readLocalState(): Promise<{ snapshot: Snapshot; settings: Settings }> {
  const db = await openDb()
  try {
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const done = txDone(tx)
    const cardsRequest = tx.objectStore('cards').getAll()
    const settingsRequest = tx.objectStore('settings').get('settings')
    const [cards, stored] = await Promise.all([
      value(cardsRequest) as Promise<Card[]>,
      value(settingsRequest) as Promise<Settings | undefined>,
    ])
    const settings = normalizeSettings(stored)
    if (stored?.localRevision === undefined && cards.length) {
      settings.localRevision = 1
      tx.objectStore('settings').put(settings)
    }
    await done
    return { snapshot: localSnapshot(cards, settings), settings }
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

export async function getAllCards(): Promise<Card[]> {
  const db = await openDb()
  try {
    const tx = db.transaction('cards', 'readonly')
    return await value(tx.objectStore('cards').getAll()) as Card[]
  } finally {
    db.close()
  }
}

export async function getCard(id: string): Promise<Card | undefined> {
  const db = await openDb()
  try {
    const tx = db.transaction('cards', 'readonly')
    return await value(tx.objectStore('cards').get(id)) as Card | undefined
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
    const done = txDone(tx)
    const cardsRequest = tx.objectStore('cards').getAll()
    const settingsRequest = tx.objectStore('settings').get('settings')
    const [cards, stored] = await Promise.all([
      value(cardsRequest) as Promise<Card[]>,
      value(settingsRequest) as Promise<Settings | undefined>,
    ])
    const settings = normalizeSettings(stored)
    const byId = new Set(cards.map((card) => card.id))
    const key = (card: Card) => `${card.de.trim().toLowerCase()}|${card.en.trim().toLowerCase()}`
    const byKey = new Set(cards.map(key))
    const store = tx.objectStore('cards')
    let added = 0
    for (const seed of seeds) {
      const pair = key(seed)
      if (settings.deletedIds[seed.id] || byId.has(seed.id) || byKey.has(pair)) continue
      store.put(seed)
      byId.add(seed.id)
      byKey.add(pair)
      added += 1
    }
    if (added) {
      settings.localRevision += 1
      tx.objectStore('settings').put(settings)
    }
    await done
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

export async function getDueCards(now = Date.now()): Promise<Card[]> {
  const cards = await getAllCards()
  return cards
    .filter((card) => card.srs.due <= now)
    .sort((a, b) => a.srs.due - b.srs.due || a.de.localeCompare(b.de, 'de'))
}

export async function getSettings(): Promise<Settings> {
  const db = await openDb()
  try {
    const tx = db.transaction('settings', 'readonly')
    return normalizeSettings(await value(tx.objectStore('settings').get('settings')) as Settings | undefined)
  } finally {
    db.close()
  }
}

export async function putSettings(next: Partial<Pick<Settings, 'direction' | 'sessionSize'>>): Promise<void> {
  await changeLocal((_tx, settings) => {
    const direction = next.direction ?? settings.direction
    const sessionSize = next.sessionSize ?? settings.sessionSize
    if (settings.direction !== direction || settings.sessionSize !== sessionSize) {
      settings.settingsUpdatedAt = Math.max(Date.now(), settings.settingsUpdatedAt + 1)
    }
    settings.direction = direction
    settings.sessionSize = sessionSize
  })
}

/** Merge in a single write transaction, using the latest local edits at apply time. */
export async function mergeRemoteIntoDb(remote: Snapshot): Promise<{ snapshot: Snapshot; revision: number; pending: boolean }> {
  const db = await openDb()
  try {
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    const done = txDone(tx)
    const cardsRequest = tx.objectStore('cards').getAll()
    const settingsRequest = tx.objectStore('settings').get('settings')
    const [cards, stored] = await Promise.all([
      value(cardsRequest) as Promise<Card[]>,
      value(settingsRequest) as Promise<Settings | undefined>,
    ])
    const settings = normalizeSettings(stored)
    if (stored?.localRevision === undefined && cards.length) settings.localRevision = 1
    const merged = mergeSnapshots(localSnapshot(cards, settings), remote)
    const cardStore = tx.objectStore('cards')
    cardStore.clear()
    for (const card of merged.cards) cardStore.put(card)
    settings.direction = merged.settings.direction
    settings.sessionSize = merged.settings.sessionSize
    settings.settingsUpdatedAt = merged.settings_updated_at || 0
    settings.deletedIds = merged.deleted_ids
    tx.objectStore('settings').put(settings)
    await done
    return {
      snapshot: merged,
      revision: settings.localRevision,
      pending: settings.localRevision > settings.acknowledgedRevision,
    }
  } finally {
    db.close()
  }
}

export async function acknowledgeRevision(includedRevision: number): Promise<boolean> {
  const db = await openDb()
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

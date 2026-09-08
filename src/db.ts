import type { Card, Settings } from './types.ts'

export function normalizeSettings(s?: Partial<Settings> | null): Settings {
  return {
    id: 'settings',
    direction: s?.direction === 'en-de' ? 'en-de' : 'de-en',
    sessionSize:
      typeof s?.sessionSize === 'number' && Number.isFinite(s.sessionSize)
        ? Math.max(0, Math.floor(s.sessionSize))
        : 20,
    deletedIds: s?.deletedIds && typeof s.deletedIds === 'object' ? { ...s.deletedIds } : {},
  }
}

const DB_NAME = 'german-flashcards'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('cards')) {
        db.createObjectStore('cards', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' })
      }
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

export async function getAllCards(): Promise<Card[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cards', 'readonly')
    const req = tx.objectStore('cards').getAll()
    req.onsuccess = () => resolve(req.result as Card[])
    req.onerror = () => reject(req.error)
  })
}

export async function getCard(id: string): Promise<Card | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cards', 'readonly')
    const req = tx.objectStore('cards').get(id)
    req.onsuccess = () => resolve(req.result as Card | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function putCard(card: Card): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('cards', 'readwrite')
  tx.objectStore('cards').put(card)
  await txDone(tx)
}

export async function putCards(cards: Card[]): Promise<void> {
  if (cards.length === 0) return
  const db = await openDb()
  const tx = db.transaction('cards', 'readwrite')
  const store = tx.objectStore('cards')
  for (const card of cards) store.put(card)
  await txDone(tx)
}

export async function deleteCard(id: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('cards', 'readwrite')
  tx.objectStore('cards').delete(id)
  await txDone(tx)
}

export async function replaceAllCards(cards: Card[]): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('cards', 'readwrite')
  const store = tx.objectStore('cards')
  store.clear()
  for (const card of cards) store.put(card)
  await txDone(tx)
}

export async function countCards(): Promise<number> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cards', 'readonly')
    const req = tx.objectStore('cards').count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getDueCards(now = Date.now()): Promise<Card[]> {
  const cards = await getAllCards()
  return cards
    .filter((c) => c.srs.due <= now)
    .sort((a, b) => a.srs.due - b.srs.due || a.de.localeCompare(b.de, 'de'))
}

export async function getSettings(): Promise<Settings> {
  const db = await openDb()
  const stored = await new Promise<Settings | undefined>((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly')
    const req = tx.objectStore('settings').get('settings')
    req.onsuccess = () => resolve(req.result as Settings | undefined)
    req.onerror = () => reject(req.error)
  })
  return normalizeSettings(stored)
}

export async function putSettings(settings: Settings): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('settings', 'readwrite')
  tx.objectStore('settings').put(normalizeSettings(settings))
  await txDone(tx)
}

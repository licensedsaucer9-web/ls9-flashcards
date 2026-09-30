import { collection, doc, getDoc, getDocs, runTransaction, type Firestore } from 'firebase/firestore'
import type { CardContent, PublicSettings, Srs } from './types.ts'
import type { CardDoc, CloudDocs, ProgressDoc, SettingsDoc } from './firestore-docs.ts'
import { planCardWrite, planProgressWrite, planSettingsWrite } from './record-sync.ts'

function asCard(data: unknown): CardDoc | null {
  if (!data || typeof data !== 'object') return null
  const row = data as CardDoc
  if (typeof row.de !== 'string' || typeof row.updated_at !== 'number' || typeof row.deletedAt !== 'number') return null
  return row
}

function asProgress(data: unknown): ProgressDoc | null {
  if (!data || typeof data !== 'object') return null
  const row = data as ProgressDoc
  if (typeof row.ease !== 'number' || typeof row.due !== 'number') return null
  return row
}

function asSettings(data: unknown): SettingsDoc | null {
  if (!data || typeof data !== 'object') return null
  const row = data as SettingsDoc
  if (row.direction !== 'de-en' && row.direction !== 'en-de') return null
  if (typeof row.settingsUpdatedAt !== 'number') return null
  return row
}

export async function accountDeckId(db: Firestore, uid: string): Promise<string> {
  const snap = await getDoc(doc(db, 'users', uid))
  const deckId = snap.exists() ? (snap.data() as { deckId?: unknown }).deckId : null
  if (typeof deckId !== 'string' || deckId === '') throw new Error('Account is missing a deck')
  return deckId
}

export async function pullCloud(db: Firestore, uid: string, deckId: string): Promise<CloudDocs> {
  const [cardsSnap, progressSnap, settingsSnap] = await Promise.all([
    getDocs(collection(db, 'decks', deckId, 'cards')),
    getDocs(collection(db, 'users', uid, 'progress')),
    getDoc(doc(db, 'users', uid, 'settings', 'current')),
  ])
  const cards = cardsSnap.docs.flatMap((item) => {
    const data = asCard(item.data())
    return data ? [{ id: item.id, data }] : []
  })
  const progress = progressSnap.docs.flatMap((item) => {
    const data = asProgress(item.data())
    return data ? [{ id: item.id, data }] : []
  })
  const settings = asSettings(settingsSnap.exists() ? settingsSnap.data() : null) ?? {
    direction: 'de-en' as const,
    sessionSize: 20,
    tier: 1 as const,
    settingsUpdatedAt: 0,
  }
  return { cards, progress, settings }
}

export async function commitCard(
  db: Firestore,
  deckId: string,
  id: string,
  local: CardContent | null,
  localDeletedAt: number,
): Promise<'wrote' | 'noop'> {
  const ref = doc(db, 'decks', deckId, 'cards', id)
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const remote = snap.exists() ? asCard(snap.data()) : null
    const next = planCardWrite(id, local, localDeletedAt, remote)
    if (!next) return 'noop'
    tx.set(ref, next)
    return 'wrote'
  })
}

export async function commitProgress(
  db: Firestore,
  uid: string,
  id: string,
  local: Srs | null,
): Promise<'wrote' | 'noop'> {
  const ref = doc(db, 'users', uid, 'progress', id)
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const remote = snap.exists() ? asProgress(snap.data()) : null
    const next = planProgressWrite(local, remote)
    if (!next) return 'noop'
    tx.set(ref, next)
    return 'wrote'
  })
}

export async function commitSettings(
  db: Firestore,
  uid: string,
  local: PublicSettings,
  localAt: number,
): Promise<'wrote' | 'noop'> {
  const ref = doc(db, 'users', uid, 'settings', 'current')
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const remote = snap.exists() ? asSettings(snap.data()) : null
    const next = planSettingsWrite(local, localAt, remote)
    if (!next) return 'noop'
    tx.set(ref, next)
    return 'wrote'
  })
}

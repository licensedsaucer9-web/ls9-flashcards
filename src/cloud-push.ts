import { collection, doc, getDoc, getDocs, runTransaction, setDoc, type Firestore } from 'firebase/firestore'
import type { CardContent, PublicSettings, Srs } from './types.ts'
import type { CardDoc, CloudDocs, ProgressDoc, SettingsDoc } from './firestore-docs.ts'
import { planCardWrite, planProgressWrite, planSettingsWrite } from './record-sync.ts'
import { newSrs } from './srs.ts'
import { filterReviewEvents, validReviewEvent, type ReviewEvent } from './streak.ts'

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

/** Creation is allowed without a read; rules deny reads of a missing deck. */
export async function ensureExtraDeck(db: Firestore, uid: string, deckId: string): Promise<void> {
  const ref = doc(db, 'decks', deckId)
  try {
    await setDoc(ref, { ownerUid: uid, memberUids: [uid] })
  } catch (error) {
    // Existing decks are immutable. Verify access without replacing their metadata.
    const existing = await getDoc(ref)
    if (!existing.exists() || existing.data().ownerUid !== uid) throw error
  }
}

export async function pullDeckCards(db: Firestore, deckId: string): Promise<CloudDocs['cards']> {
  const snap = await getDocs(collection(db, 'decks', deckId, 'cards'))
  return snap.docs.flatMap(item => {
    const data = asCard(item.data())
    return data ? [{ id: item.id, data }] : []
  })
}

export async function pullCloud(db: Firestore, uid: string, deckId: string, extra = false): Promise<CloudDocs> {
  const userPath = extra ? ['users', uid, 'decks', deckId] : ['users', uid]
  const [cardsSnap, progressSnap, settingsSnap, activitySnap] = await Promise.all([
    getDocs(collection(db, 'decks', deckId, 'cards')),
    getDocs(collection(db, userPath[0], ...userPath.slice(1), 'progress')),
    getDoc(doc(db, userPath[0], ...userPath.slice(1), 'settings', 'current')),
    getDocs(collection(db, 'users', uid, 'activity')),
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
    tier: extra ? 3 as const : 1 as const,
    settingsUpdatedAt: 0,
  }
  const { activity, skipped } = filterReviewEvents(activitySnap.docs.map((item) => ({ id: item.id, data: item.data() })))
  if (skipped) console.warn(`Skipped ${skipped} invalid cloud review activity events`)
  return { cards, progress, settings, activity }
}

export async function commitActivity(db: Firestore, uid: string, id: string, event: ReviewEvent): Promise<'wrote' | 'noop'> {
  if (!validReviewEvent(id, event)) throw new Error('Invalid review activity')
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'users', uid, 'activity', id)
    const snap = await tx.get(ref)
    if (snap.exists()) {
      const remote = snap.data()
      if (!validReviewEvent(id, remote) || remote.at !== event.at || remote.timeZone !== event.timeZone) {
        throw new Error('Conflicting review activity')
      }
      return 'noop'
    }
    tx.set(ref, event)
    return 'wrote'
  })
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
  extraDeckId?: string,
): Promise<'wrote' | 'noop'> {
  const ref = extraDeckId ? doc(db, 'users', uid, 'decks', extraDeckId, 'progress', id) : doc(db, 'users', uid, 'progress', id)
  // Editor/CSV creation stamps updated_at too. The initial schedule, rather
  // than that clock, identifies an unstudied card. Again/Gender lower ease
  // even though they also leave reps and interval at zero.
  if (extraDeckId && local && local.ease === newSrs(0).ease && local.reps === 0 && local.interval === 0) return 'noop'
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
  extraDeckId?: string,
): Promise<'wrote' | 'noop'> {
  const ref = extraDeckId ? doc(db, 'users', uid, 'decks', extraDeckId, 'settings', 'current') : doc(db, 'users', uid, 'settings', 'current')
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const remote = snap.exists() ? asSettings(snap.data()) : null
    const next = planSettingsWrite(local, localAt, remote)
    if (!next) return 'noop'
    tx.set(ref, next)
    return 'wrote'
  })
}

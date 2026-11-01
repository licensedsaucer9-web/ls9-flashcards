import {
  collection, doc, getDoc, getDocs, limit, query, where, writeBatch,
  type CollectionReference, type DocumentReference, type Firestore,
} from 'firebase/firestore'
import { storagePrefix } from './rehearsal.ts'

/**
 * Account deletion runs in the client: the Spark plan has no Cloud Functions.
 * Firestore data goes first, the Auth user only after a pass finds nothing left,
 * and this device's copy last. A marker in localStorage makes every step
 * resumable: an interrupted run continues the next time that account signs in here.
 */

/** Firestore allows at most 500 writes in one batch; a delete is one write. */
export const DELETE_BATCH = 500

/**
 * Spark allows 20,000 deletes (and 50,000 reads) a day for the whole project, shared by
 * every user. One account deletes at most half of that per Pacific day, so other
 * accounts keep syncing; a larger account continues the next day. See docs/architecture.md.
 */
export const DAILY_DELETE_BUDGET = 10_000

/** A pass that keeps finding new documents means another device is still writing. */
const MAX_PASSES = 5

const MARKER_KEY = `${storagePrefix}.account-deletion`

export type DeletionPhase = 'confirm' | 'data' | 'auth'

export type DeletionMarker = {
  uid: string
  /**
   * 'confirm' while Google re-authentication is away on a redirect; 'data' until a pass
   * finds no Firestore documents; 'auth' while the sign-in account and device copy go.
   */
  phase: DeletionPhase
  startedAt: number
  /** Pacific calendar day the budget below was counted on; Firestore quotas reset at its midnight. */
  day: string
  deletedToday: number
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function quotaDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now))
}

export function readDeletionMarker(storage: Store): DeletionMarker | null {
  try {
    const raw = storage.getItem(MARKER_KEY)
    if (!raw) return null
    const row = JSON.parse(raw) as Partial<DeletionMarker>
    if (!row || typeof row.uid !== 'string' || row.uid === '') return null
    return {
      uid: row.uid,
      phase: row.phase === 'auth' || row.phase === 'confirm' ? row.phase : 'data',
      startedAt: Number(row.startedAt) || 0,
      day: typeof row.day === 'string' ? row.day : '',
      deletedToday: Math.max(0, Number(row.deletedToday) || 0),
    }
  } catch {
    return null
  }
}

export function writeDeletionMarker(storage: Store, marker: DeletionMarker): void {
  storage.setItem(MARKER_KEY, JSON.stringify(marker))
}

export function clearDeletionMarker(storage: Store): void {
  storage.removeItem(MARKER_KEY)
}

export function startDeletionMarker(uid: string, now: number, existing: DeletionMarker | null): DeletionMarker {
  if (existing && existing.uid === uid) return existing
  return { uid, phase: 'data', startedAt: now, day: quotaDay(now), deletedToday: 0 }
}

/** Deletes still allowed today. A new Pacific day starts a fresh budget. */
export function remainingBudget(marker: DeletionMarker, now: number, budget = DAILY_DELETE_BUDGET): { marker: DeletionMarker; remaining: number } {
  const day = quotaDay(now)
  const next = marker.day === day ? marker : { ...marker, day, deletedToday: 0 }
  return { marker: next, remaining: Math.max(0, budget - next.deletedToday) }
}

export type DeleteOptions = {
  /** Deletes allowed in this run. */
  budget: number
  /** Cloud ids of decks this device knows; owned decks are also found by query. */
  knownDeckIds?: string[]
  /** Called after each committed batch with its size. */
  onBatch?: (deleted: number) => void
  batchSize?: number
}

export type DeleteResult = { state: 'done' | 'budget'; deleted: number }

class BudgetSpent extends Error {}

function denied(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? '')
  return code === 'permission-denied' || code.endsWith('/permission-denied')
}

/**
 * Delete every Firestore document the account owns: review activity, progress and
 * settings (also per extra deck), the cards of its personal deck and of decks it
 * created, those deck documents, and `users/{uid}` last. A shared deck it is only a
 * member of keeps its cards. Feedback is not linked to an account by rules and stays.
 * Returns 'done' only after a full pass found nothing to delete.
 */
export async function deleteAccountData(db: Firestore, uid: string, options: DeleteOptions): Promise<DeleteResult> {
  const size = Math.max(1, Math.min(DELETE_BATCH, options.batchSize ?? DELETE_BATCH))
  let left = Math.max(0, options.budget)
  let deleted = 0

  async function commit(refs: DocumentReference[]): Promise<void> {
    if (!refs.length) return
    const batch = writeBatch(db)
    for (const ref of refs) batch.delete(ref)
    await batch.commit()
    left -= refs.length
    deleted += refs.length
    options.onBatch?.(refs.length)
  }

  async function drain(coll: CollectionReference): Promise<number> {
    let count = 0
    for (;;) {
      if (left <= 0) {
        // One read tells a finished collection from a spent budget.
        const probe = await getDocs(query(coll, limit(1)))
        if (probe.empty) return count
        throw new BudgetSpent()
      }
      const snap = await getDocs(query(coll, limit(Math.min(size, left))))
      if (snap.empty) return count
      await commit(snap.docs.map((item) => item.ref))
      count += snap.size
    }
  }

  async function single(ref: DocumentReference): Promise<number> {
    const snap = await getDoc(ref)
    if (!snap.exists()) return 0
    if (left <= 0) throw new BudgetSpent()
    await commit([ref])
    return 1
  }

  /** Rules refuse reads of a missing deck, so a refused read means its document is gone. */
  async function ownedDeck(deckId: string): Promise<boolean> {
    try {
      const snap = await getDoc(doc(db, 'decks', deckId))
      if (!snap.exists()) return false
      const data = snap.data() as { ownerUid?: unknown }
      return deckId === uid || data.ownerUid === uid
    } catch (error) {
      if (denied(error)) return false
      throw error
    }
  }

  async function pass(): Promise<number> {
    let found = 0
    const owned = await getDocs(query(collection(db, 'decks'), where('ownerUid', '==', uid)))
    const extraIds = new Set([...owned.docs.map((item) => item.id), ...(options.knownDeckIds ?? [])])
    extraIds.delete(uid)
    found += await drain(collection(db, 'users', uid, 'activity'))
    found += await drain(collection(db, 'users', uid, 'progress'))
    found += await single(doc(db, 'users', uid, 'settings', 'current'))
    for (const deckId of extraIds) {
      found += await drain(collection(db, 'users', uid, 'decks', deckId, 'progress'))
      found += await single(doc(db, 'users', uid, 'decks', deckId, 'settings', 'current'))
      if (!await ownedDeck(deckId)) continue
      // The card rules look up the deck document, so it goes after its cards.
      found += await drain(collection(db, 'decks', deckId, 'cards'))
      found += await single(doc(db, 'decks', deckId))
    }
    if (await ownedDeck(uid)) {
      found += await drain(collection(db, 'decks', uid, 'cards'))
      found += await single(doc(db, 'decks', uid))
    }
    // Last: without it a later sign-in elsewhere provisions a fresh, empty account.
    found += await single(doc(db, 'users', uid))
    return found
  }

  try {
    for (let i = 0; i < MAX_PASSES; i += 1) {
      if (await pass() === 0) return { state: 'done', deleted }
    }
  } catch (error) {
    if (error instanceof BudgetSpent) return { state: 'budget', deleted }
    throw error
  }
  throw Object.assign(new Error('Account data kept reappearing; sign out on other devices and try again'), { code: 'deletion/still-writing' })
}

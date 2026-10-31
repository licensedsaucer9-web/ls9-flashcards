import {
  collection, doc, getDoc, getDocs, query, runTransaction, serverTimestamp, setDoc, Timestamp, where,
  type DocumentData, type Firestore, type Query, type QueryDocumentSnapshot,
} from 'firebase/firestore'
import type { CardContent, PublicSettings, Srs } from './types.ts'
import type { CardDoc, CloudDocs, ProgressDoc, SettingsDoc } from './firestore-docs.ts'
import { planCardWrite, planProgressWrite, planSettingsWrite } from './record-sync.ts'
import { newSrs } from './srs.ts'
import { filterReviewEvents, validReviewEvent, type ReviewEvent } from './streak.ts'

/**
 * Server commit time of a card, progress or activity write, set with serverTimestamp() so an
 * incremental pull can ask for "changed since" without trusting any device clock. Documents
 * written before this field existed (or by an older client) lack it; the daily full pull covers them.
 */
export const SYNCED_AT = 'syncedAt'

/**
 * Incremental queries first reach this far behind the cursor, so a write that committed just before
 * the newest one seen, but was not yet visible to that pull, is still read.
 */
export const PULL_OVERLAP_MS = 2 * 60 * 1000

/** The sync clock is transport metadata, never part of the record a merge or validation sees. */
function withoutSyncedAt(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !(SYNCED_AT in data)) return data
  const { [SYNCED_AT]: _, ...rest } = data as Record<string, unknown>
  return rest
}

function syncedAtMillis(data: DocumentData): number | null {
  const value = data[SYNCED_AT]
  return value instanceof Timestamp ? value.toMillis() : null
}

function asCard(data: unknown): CardDoc | null {
  data = withoutSyncedAt(data)
  if (!data || typeof data !== 'object') return null
  const row = data as CardDoc
  if (typeof row.de !== 'string' || typeof row.updated_at !== 'number' || typeof row.deletedAt !== 'number') return null
  return row
}

function asProgress(data: unknown): ProgressDoc | null {
  data = withoutSyncedAt(data)
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

/** Creation is allowed without a read; rules deny reads of a missing deck.
 * 'taken' means another account already holds this ID (starter IDs are predictable), so the
 * caller must sync this deck under a fresh random ID instead.
 */
export async function ensureExtraDeck(db: Firestore, uid: string, deckId: string): Promise<'ok' | 'taken'> {
  const ref = doc(db, 'decks', deckId)
  try {
    await setDoc(ref, { ownerUid: uid, memberUids: [uid] })
    return 'ok'
  } catch (error) {
    // Existing decks are immutable. Verify access without replacing their metadata.
    let existing
    try {
      existing = await getDoc(ref)
    } catch (readError) {
      // Creation and read were both refused: a deck we are not a member of holds the ID.
      if (denied(error) && denied(readError)) return 'taken'
      throw readError
    }
    if (!existing.exists() || existing.data().ownerUid !== uid) throw error
    return 'ok'
  }
}

function denied(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'permission-denied'
}

export async function pullDeckCards(db: Firestore, deckId: string): Promise<CloudDocs['cards']> {
  const snap = await getDocs(collection(db, 'decks', deckId, 'cards'))
  return snap.docs.flatMap(item => {
    const data = asCard(item.data())
    return data ? [{ id: item.id, data }] : []
  })
}

/**
 * What a pull reads. With `since` (server time) only cards, progress and activity written after it
 * are read. Without it every card and progress record is read, and
 * activity is read from `activityFrom` (a review time) onwards, or all of it when that is absent too.
 * Settings are one document and are always read.
 */
export type PullOptions = { since?: number | null; activityFrom?: number | null }

/** `cursor` is the newest server write time seen, or null when no document carried one. */
export type PulledDocs = CloudDocs & { cursor: number | null; reads: number }

export async function pullCloud(db: Firestore, uid: string, deckId: string, extra = false, options: PullOptions = {}): Promise<PulledDocs> {
  const userPath = extra ? ['users', uid, 'decks', deckId] : ['users', uid]
  const since = typeof options.since === 'number' ? Timestamp.fromMillis(Math.max(0, options.since)) : null
  const changed = (base: Query): Query => since ? query(base, where(SYNCED_AT, '>', since)) : base
  const activityBase = collection(db, 'users', uid, 'activity')
  const activityQuery = since ? changed(activityBase)
    : typeof options.activityFrom === 'number' ? query(activityBase, where('at', '>=', options.activityFrom))
    : activityBase
  const [cardsSnap, progressSnap, settingsSnap, activitySnap] = await Promise.all([
    getDocs(changed(collection(db, 'decks', deckId, 'cards'))),
    getDocs(changed(collection(db, userPath[0], ...userPath.slice(1), 'progress'))),
    getDoc(doc(db, userPath[0], ...userPath.slice(1), 'settings', 'current')),
    getDocs(activityQuery),
  ])
  let cursor: number | null = null
  const seen = (item: QueryDocumentSnapshot) => {
    const at = syncedAtMillis(item.data())
    if (at !== null && (cursor === null || at > cursor)) cursor = at
  }
  const cards = cardsSnap.docs.flatMap((item) => {
    seen(item)
    const data = asCard(item.data())
    return data ? [{ id: item.id, data }] : []
  })
  const progress = progressSnap.docs.flatMap((item) => {
    seen(item)
    const data = asProgress(item.data())
    return data ? [{ id: item.id, data }] : []
  })
  const settings = asSettings(settingsSnap.exists() ? settingsSnap.data() : null) ?? {
    direction: 'de-en' as const,
    sessionSize: 20,
    tier: extra ? 4 as const : 1 as const,
    settingsUpdatedAt: 0,
  }
  for (const item of activitySnap.docs) seen(item)
  const { activity, skipped } = filterReviewEvents(activitySnap.docs.map((item) => ({ id: item.id, data: withoutSyncedAt(item.data()) })))
  if (skipped) console.warn(`Skipped ${skipped} invalid cloud review activity events`)
  // A query that matches nothing is still billed as one read.
  const reads = [cardsSnap, progressSnap, activitySnap].reduce((sum, snap) => sum + Math.max(1, snap.size), 1)
  return { cards, progress, settings, activity, cursor, reads }
}

export async function commitActivity(db: Firestore, uid: string, id: string, event: ReviewEvent): Promise<'wrote' | 'noop'> {
  if (!validReviewEvent(id, event)) throw new Error('Invalid review activity')
  return runTransaction(db, async (tx) => {
    const ref = doc(db, 'users', uid, 'activity', id)
    const snap = await tx.get(ref)
    if (snap.exists()) {
      const remote = withoutSyncedAt(snap.data())
      if (!validReviewEvent(id, remote) || remote.at !== event.at || remote.timeZone !== event.timeZone) {
        throw new Error('Conflicting review activity')
      }
      return 'noop'
    }
    tx.set(ref, { ...event, [SYNCED_AT]: serverTimestamp() })
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
    tx.set(ref, { ...next, [SYNCED_AT]: serverTimestamp() })
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
  // even when they also leave reps and interval at zero.
  if (extraDeckId && local && local.ease === newSrs(0).ease && local.reps === 0 && local.interval === 0) return 'noop'
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref)
    const remote = snap.exists() ? asProgress(snap.data()) : null
    const next = planProgressWrite(local, remote)
    if (!next) return 'noop'
    tx.set(ref, { ...next, [SYNCED_AT]: serverTimestamp() })
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

import { reviewTiers, validSelectedTiers } from './tiers.ts'
import { cloudFirestore } from './cloud-handle.ts'
import { accountDeckId, commitActivity, commitCard, commitProgress, commitSettings, ensureExtraDeck, pullCloud, PULL_OVERLAP_MS, type PullOptions } from './cloud-push.ts'
import {
  getActiveDeck,
  recordAssignedDeck,
  recordCloudDeckId,
  acknowledgePending,
  applyStagedProgress,
  acknowledgeRevision,
  mergeDeckIntoDb,
  mergeProgressIntoDb,
  readCloudSnapshot,
  readPullCursor,
  recordPullCursor,
  insertMissingSeeds,
  type CloudSnapshot,
} from './db.ts'
import { docsToFiles } from './firestore-docs.ts'
import { cardContentProblem, clampSrs } from './limits.ts'
import { deckSyncs, hasDirty, listPushItems, runDirtyQueue, type NeedsFixing, type PushItem } from './record-sync.ts'
import { seedCards } from './seed.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import type { Card, CardContent, PublicSettings, PullCursor } from './types.ts'

function cardContent(card: Card): CardContent {
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

function publicSettings(settings: CloudSnapshot['settings']): PublicSettings {
  return {
    direction: settings.direction,
    sessionSize: settings.sessionSize,
    tier: settings.tier,
    ...(validSelectedTiers(settings.selectedTiers) ? { selectedTiers: reviewTiers(settings) } : {}),
    wordTypes: settings.wordTypes,
  }
}

async function pushLoaded(
  db: NonNullable<ReturnType<typeof cloudFirestore>>,
  uid: string,
  deckId: string,
  snapshot: CloudSnapshot,
  item: PushItem,
  extraDeckId?: string,
): Promise<'wrote' | 'noop'> {
  if (item.kind === 'activity') return commitActivity(db, uid, item.id, snapshot.activity[item.id])
  if (item.kind === 'settings') {
    return commitSettings(db, uid, publicSettings(snapshot.settings), snapshot.settings.settingsUpdatedAt, extraDeckId)
  }
  if (item.kind === 'progress') {
    const card = snapshot.cards.get(item.id)
    // Repairs a schedule saved before the caps existed, which the server would reject for good.
    return commitProgress(db, uid, item.id, card ? clampSrs(card.srs) : null, extraDeckId)
  }
  const card = snapshot.cards.get(item.id)
  const deletedAt = Number(snapshot.settings.deletedIds[item.id]) || 0
  return commitCard(db, deckId, item.id, card ? cardContent(card) : null, deletedAt)
}

export { sendFeedback } from './cloud-feedback.ts'

export const cloudTransport = true

/** A "light" pass (after a local change) skips the account pull if one finished this recently. */
export const PULL_INTERVAL_MS = 5 * 60 * 1000
/** Returning to the foreground or reconnecting pulls at most this often. Launch, sign-in and Sync now always pull. */
export const FOREGROUND_PULL_INTERVAL_MS = 10 * 60 * 1000
/** Between full pulls a deck reads only what changed since its cursor. */
export const FULL_PULL_INTERVAL_MS = 24 * 60 * 60 * 1000
/** A full pull after the first reads only this much review history; older events are already on the device. */
export const RECENT_ACTIVITY_MS = 30 * 24 * 60 * 60 * 1000
const lastPull = new Map<string, number>()
const ensuredDecks = new Set<string>()
/** `users/{uid}.deckId` cannot change (the rules refuse updates), so one read per session is enough. */
const accountDecks = new Map<string, string>()

/** Forget what the passes remember (tests, and account changes). */
export function resetSyncMemory(): void {
  lastPull.clear()
  ensuredDecks.clear()
  accountDecks.clear()
}

export { PULL_OVERLAP_MS }

/**
 * How the next pull reads, from the cursor the deck's last pull stored. The first pull reads
 * everything, including all review history. A daily full pull (or one while no pulled document has
 * a server write time yet) re-reads cards and progress so writes from older clients without that
 * time still arrive; of the activity it reads recent events plus any changed since the cursor, so an
 * old review another device uploaded late is not skipped. Otherwise only changes since the cursor
 * are read, reaching back the overlap until a pull has re-read that window once.
 */
export function pullPlan(cursor: PullCursor | null, now: number): { kind: 'first' | 'full' | 'changes'; options: PullOptions } {
  if (!cursor) return { kind: 'first', options: {} }
  // No pulled document had a server write time, so every stamped event is newer than the last pull.
  const since = cursor.at === null ? 0 : cursor.settled ? cursor.at : cursor.at - PULL_OVERLAP_MS
  if (cursor.at === null || now - cursor.fullAt >= FULL_PULL_INTERVAL_MS) {
    return { kind: 'full', options: { activityFrom: now - RECENT_ACTIVITY_MS, activitySince: since } }
  }
  return { kind: 'changes', options: { since } }
}

/** The cursor after a merged pull that started at device time `startedAt` and saw server write times up to `seen`. */
export function nextCursor(key: string, stored: PullCursor | null, plan: ReturnType<typeof pullPlan>, seen: number | null, startedAt: number): PullCursor {
  const fullAt = plan.kind === 'changes' ? stored!.fullAt : startedAt
  const at = stored?.at == null ? seen : seen === null ? stored.at : Math.max(stored.at, seen)
  if (!stored || at !== stored.at) return { key, at, movedAt: startedAt, settled: false, fullAt }
  // Every plan but a settled one reads the overlap window. Device time elapsed since the cursor moved
  // is server time elapsed too, so a write hidden from that pull has had the overlap to land.
  return { key, at, movedAt: stored.movedAt, settled: stored.settled || startedAt - stored.movedAt >= PULL_OVERLAP_MS, fullAt }
}

/** Firestore's daily read or write quota is used up; it resets at midnight Pacific time. */
export function quotaExhausted(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'resource-exhausted' || code === 'firestore/resource-exhausted'
}

export async function cloudSyncPass(control: { requestAgain: () => void; light?: boolean; foreground?: boolean; now?: () => number }): Promise<'synced' | 'pending' | 'idle' | 'local' | 'quota' | { state: 'rejected'; message: string; items: NeedsFixing[] }> {
  const lock = captureStudyLock()
  if (!lock.uid) return 'idle'
  const db = cloudFirestore()
  if (!db) return 'pending'
  const uid = lock.uid
  try {
    if (!studyLockCurrent(lock)) return 'idle'
    const active = await getActiveDeck()
    if (!deckSyncs(active)) return 'local'
    const original = active!.origin === 'original'
    if (!studyLockCurrent(lock)) return 'idle'
    const deckId = original ? accountDecks.get(uid) ?? await accountDeckId(db, uid) : active!.id
    if (original) accountDecks.set(uid, deckId)
    if (!studyLockCurrent(lock)) return 'idle'
    // Local records keep `deckId`; only Firestore paths use `cloudId`.
    let cloudId = original ? deckId : active!.cloudId ?? deckId
    if (original) await recordAssignedDeck(deckId)
    // Deck documents cannot be changed or deleted, so one successful check per session holds.
    else if (!ensuredDecks.has(`${uid}/${cloudId}`) && await ensureExtraDeck(db, uid, cloudId) === 'taken') {
      // Another account created this predictable starter ID first: sync under a fresh random one.
      const fresh = crypto.randomUUID()
      if (await ensureExtraDeck(db, uid, fresh) === 'taken') return 'pending'
      // Another tab may have fallen back first; adopt its ID so neither cloud deck is abandoned.
      const recorded = await recordCloudDeckId(deckId, fresh)
      if (!recorded) return 'idle'
      cloudId = recorded
    }
    if (!studyLockCurrent(lock)) return 'idle'
    if (!original) ensuredDecks.add(`${uid}/${cloudId}`)
    const scope = { lock, deckId }
    const now = control.now ?? Date.now
    const pullKey = `${uid}/${cloudId}`
    // After a local change (a light pass) only the dirty records are pushed (each push reads and merges the
    // record it writes) while a recent pull is fresh. Returning to the foreground and reconnecting pull at most
    // every FOREGROUND_PULL_INTERVAL_MS. Launch, sign-in and Sync now always pull.
    const interval = control.light ? PULL_INTERVAL_MS : control.foreground ? FOREGROUND_PULL_INTERVAL_MS : 0
    const skipPull = interval > 0 && now() - (lastPull.get(pullKey) ?? -Infinity) < interval
    if (!skipPull) {
      const stored = await readPullCursor(pullKey, scope)
      if (!studyLockCurrent(lock)) return 'idle'
      const startedAt = now()
      const plan = pullPlan(stored, startedAt)
      const docs = await pullCloud(db, uid, cloudId, !original, plan.options)
      if (!studyLockCurrent(lock)) return 'idle'
      const files = docsToFiles(docs, uid, 0)
      const deckMerge = await mergeDeckIntoDb(files.deck, undefined, scope)
      if (!studyLockCurrent(lock)) return 'idle'
      const progressMerge = await mergeProgressIntoDb(files.user, undefined, scope)
      if (!studyLockCurrent(lock)) return 'idle'
      if (original) await insertMissingSeeds(seedCards())
      if (!studyLockCurrent(lock)) return 'idle'
      if (original) await applyStagedProgress(scope)
      if (!studyLockCurrent(lock)) return 'idle'
      // Advance only past records this deck really merged; a skipped merge must be read again,
      // so it does not count as a fresh pull either.
      if (deckMerge.applied && progressMerge.applied) {
        await recordPullCursor(nextCursor(pullKey, stored, plan, docs.cursor ?? null, startedAt), scope)
        if (!studyLockCurrent(lock)) return 'idle'
        lastPull.set(pullKey, now())
      }
    }
    const snapshot = await readCloudSnapshot(scope)
    if (!studyLockCurrent(lock)) return 'idle'
    if (!snapshot) {
      // A different tab can change the selection without invalidating this tab's lock.
      // Re-read the binding so the foreground loop reports the selected deck's status.
      control.requestAgain()
      return 'idle'
    }
    const result = await runDirtyQueue(listPushItems(snapshot.settings.pending, deckId), {
      locked: () => {
        const live = captureStudyLock()
        return live.uid === uid && live.generation === lock.generation
      },
      push: (item) => pushLoaded(db, uid, cloudId, snapshot, item, original ? undefined : cloudId),
      ack: async (item) => {
        const applied = await acknowledgePending(item, { uid, generation: lock.generation, scope })
        if (!applied) throw new Error('acknowledgement refused')
      },
    })
    if (!studyLockCurrent(lock)) return 'idle'
    const after = await readCloudSnapshot(scope)
    if (!after) {
      control.requestAgain()
      return 'idle'
    }
    const dirty = hasDirty(after.settings.pending)
    if (result.rejected.length) {
      const items: NeedsFixing[] = result.rejected.map(({ item, code }) => {
        const card = item.kind === 'card' || item.kind === 'progress' ? snapshot.cards.get(item.id) : undefined
        const label = card ? card.de.slice(0, 40)
          : item.kind === 'settings' ? 'Deck settings'
          : item.kind === 'activity' ? `Review activity ${item.id}`
          : item.id
        return { item, code, label, problem: card && item.kind === 'card' ? cardContentProblem(card) : null }
      })
      const first = items[0]
      const more = items.length > 1 ? ` (+${items.length - 1} more)` : ''
      // Name the card and say what to fix; editing it queues it again.
      const message = first.problem
        ? `Saved on this device · “${first.label}” can’t sync: ${first.problem}. Edit it to fix${more}`
        : `Saved on this device · ${first.item.kind === 'settings' ? 'settings' : first.item.id} rejected (${first.code})${more}`
      return { state: 'rejected', message, items }
    }
    if (!result.clean || dirty) {
      if (result.clean && dirty && studyLockCurrent(lock)) control.requestAgain()
      return 'pending'
    }
    const newerChanges = await acknowledgeRevision(after.settings.localRevision, undefined, scope)
    if (!studyLockCurrent(lock)) return 'idle'
    if (newerChanges) {
      // Another deck can remain pending without being uploadable in this pass.
      // Retry only work in our scope, otherwise the foreground loop would spin.
      const latest = await readCloudSnapshot(scope)
      if (!latest || hasDirty(latest.settings.pending)) control.requestAgain()
      return 'pending'
    }
    return 'synced'
  } catch (error) {
    // Local study carries on; the pending records upload once the quota resets.
    return quotaExhausted(error) ? 'quota' : 'pending'
  }
}

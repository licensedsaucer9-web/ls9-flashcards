import { reviewTiers, validSelectedTiers } from './tiers.ts'
import { cloudFirestore } from './cloud-handle.ts'
import { accountDeckId, commitActivity, commitCard, commitProgress, commitSettings, ensureExtraDeck, pullCloud } from './cloud-push.ts'
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
  insertMissingSeeds,
  type CloudSnapshot,
} from './db.ts'
import { docsToFiles } from './firestore-docs.ts'
import { cardContentProblem, clampSrs } from './limits.ts'
import { deckSyncs, hasDirty, listPushItems, runDirtyQueue, type NeedsFixing, type PushItem } from './record-sync.ts'
import { seedCards } from './seed.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import type { Card, CardContent, PublicSettings } from './types.ts'

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

export const cloudTransport = true

/** A "light" pass (after a local change) skips the full-account pull if one finished this recently. */
export const PULL_INTERVAL_MS = 5 * 60 * 1000
const lastPull = new Map<string, number>()
const ensuredDecks = new Set<string>()

/** Forget what the light passes remember (tests, and account changes). */
export function resetSyncMemory(): void {
  lastPull.clear()
  ensuredDecks.clear()
}

export async function cloudSyncPass(control: { requestAgain: () => void; light?: boolean; now?: () => number }): Promise<'synced' | 'pending' | 'idle' | 'local' | { state: 'rejected'; message: string; items: NeedsFixing[] }> {
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
    const deckId = original ? await accountDeckId(db, uid) : active!.id
    if (!studyLockCurrent(lock)) return 'idle'
    // Local records keep `deckId`; only Firestore paths use `cloudId`.
    let cloudId = original ? deckId : active!.cloudId ?? deckId
    if (original) await recordAssignedDeck(deckId)
    else if (!(control.light && ensuredDecks.has(`${uid}/${cloudId}`)) && await ensureExtraDeck(db, uid, cloudId) === 'taken') {
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
    // Every card, progress record and review event is read by a full pull, so after a local change (a light pass)
    // only the dirty records are pushed (each push reads and merges the record it writes) while a recent pull is fresh.
    // Launch, return to foreground, reconnecting and Sync now always pull.
    const skipPull = control.light === true && now() - (lastPull.get(pullKey) ?? -Infinity) < PULL_INTERVAL_MS
    if (!skipPull) {
      const docs = await pullCloud(db, uid, cloudId, !original)
      if (!studyLockCurrent(lock)) return 'idle'
      const files = docsToFiles(docs, uid, 0)
      await mergeDeckIntoDb(files.deck, undefined, scope)
      if (!studyLockCurrent(lock)) return 'idle'
      await mergeProgressIntoDb(files.user, undefined, scope)
      if (!studyLockCurrent(lock)) return 'idle'
      if (original) await insertMissingSeeds(seedCards())
      if (!studyLockCurrent(lock)) return 'idle'
      if (original) await applyStagedProgress(scope)
      if (!studyLockCurrent(lock)) return 'idle'
      lastPull.set(pullKey, now())
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
  } catch {
    return 'pending'
  }
}

import { cloudFirestore } from './cloud-handle.ts'
import { accountDeckId, commitCard, commitProgress, commitSettings, pullCloud } from './cloud-push.ts'
import {
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
import { hasDirty, listPushItems, runDirtyQueue, type PushItem } from './record-sync.ts'
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
    wordTypes: settings.wordTypes,
  }
}

async function pushLoaded(
  db: NonNullable<ReturnType<typeof cloudFirestore>>,
  uid: string,
  deckId: string,
  snapshot: CloudSnapshot,
  item: PushItem,
): Promise<'wrote' | 'noop'> {
  if (item.kind === 'settings') {
    return commitSettings(db, uid, publicSettings(snapshot.settings), snapshot.settings.settingsUpdatedAt)
  }
  if (item.kind === 'progress') {
    const card = snapshot.cards.get(item.id)
    return commitProgress(db, uid, item.id, card ? card.srs : null)
  }
  const card = snapshot.cards.get(item.id)
  const deletedAt = Number(snapshot.settings.deletedIds[item.id]) || 0
  return commitCard(db, deckId, item.id, card ? cardContent(card) : null, deletedAt)
}

export const cloudTransport = true

export async function cloudSyncPass(control: { requestAgain: () => void }): Promise<'synced' | 'pending' | 'idle' | { state: 'rejected'; message: string }> {
  const lock = captureStudyLock()
  if (!lock.uid) return 'idle'
  const db = cloudFirestore()
  if (!db) return 'pending'
  const uid = lock.uid
  try {
    if (!studyLockCurrent(lock)) return 'idle'
    const deckId = await accountDeckId(db, uid)
    if (!studyLockCurrent(lock)) return 'idle'
    const docs = await pullCloud(db, uid, deckId)
    if (!studyLockCurrent(lock)) return 'idle'
    const files = docsToFiles(docs, uid, 0)
    await mergeDeckIntoDb(files.deck)
    if (!studyLockCurrent(lock)) return 'idle'
    await mergeProgressIntoDb(files.user)
    if (!studyLockCurrent(lock)) return 'idle'
    await insertMissingSeeds(seedCards())
    if (!studyLockCurrent(lock)) return 'idle'
    await applyStagedProgress()
    if (!studyLockCurrent(lock)) return 'idle'
    const snapshot = await readCloudSnapshot()
    if (!snapshot || !studyLockCurrent(lock)) return 'idle'
    const result = await runDirtyQueue(listPushItems(snapshot.settings.pending), {
      locked: () => {
        const live = captureStudyLock()
        return live.uid === uid && live.generation === lock.generation
      },
      push: (item) => pushLoaded(db, uid, deckId, snapshot, item),
      ack: async (item) => {
        const applied = await acknowledgePending(item, { uid, generation: lock.generation })
        if (!applied) throw new Error('acknowledgement refused')
      },
    })
    if (!studyLockCurrent(lock)) return 'idle'
    const after = await readCloudSnapshot()
    if (!after) return 'idle'
    const dirty = hasDirty(after.settings.pending)
    if (result.rejected.length) {
      const first = result.rejected[0]
      const record = first.item.kind === 'settings' ? 'settings' : first.item.id
      return { state: 'rejected', message: `Saved on this device · ${record} rejected (${first.code})` }
    }
    if (!result.clean || dirty) {
      if (result.clean && dirty && studyLockCurrent(lock)) control.requestAgain()
      return 'pending'
    }
    const newerChanges = await acknowledgeRevision(after.settings.localRevision)
    if (!studyLockCurrent(lock)) return 'idle'
    if (newerChanges) {
      control.requestAgain()
      return 'pending'
    }
    return 'synced'
  } catch {
    return 'pending'
  }
}

import { cardToDoc, docsToFiles } from '../src/firestore-docs.ts'
import {
  WRITE_CHUNK,
  ackAllowed,
  deckSyncs,
  applyAck,
  chunkItems,
  contentChanged,
  emptyPending,
  hasDirty,
  isDirty,
  listPushItems,
  normalizePending,
  planCardWrite,
  planProgressWrite,
  planSettingsWrite,
  progressChanged,
  reconcileStagedProgress,
  runDirtyQueue,
} from '../src/record-sync.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function content(over = {}) {
  return {
    id: 'card-1',
    de: 'Hund',
    en: 'dog',
    article: 'der',
    example_de: 'Der Hund.',
    example_en: 'The dog.',
    tags: ['a1'],
    created_at: 1,
    updated_at: 2,
    ...over,
  }
}

function srs(over = {}) {
  return { ease: 2.5, interval: 1, reps: 1, due: 50, updated_at: 50, ...over }
}

const live = cardToDoc(content(), 0)
assert(planCardWrite('card-1', content(), 0, live) === null, 'an unchanged card does not write')

const older = planCardWrite('card-1', content({ de: 'Katze', en: 'cat', updated_at: 1 }), 0, live)
assert(older === null, 'an older local edit leaves the newer server card')

const newer = planCardWrite('card-1', content({ de: 'Katze', en: 'cat', updated_at: 9 }), 0, live)
assert(newer && newer.de === 'Katze' && newer.updated_at === 9, 'a newer local edit is uploaded')
assert(newer && !('ease' in newer), 'a content edit does not carry a schedule')

const tie = planCardWrite('card-1', content({ de: 'neu', updated_at: 2 }), 0, cardToDoc(content({ de: 'alt', updated_at: 2 }), 0))
assert(tie && tie.de === 'neu', 'an equal content clock keeps the local card')

const seedRemote = cardToDoc(content({ id: 'seed-01', updated_at: 0, created_at: 0 }), 40)
seedRemote.deletedAt = 40
const revived = planCardWrite('seed-01', content({ id: 'seed-01', updated_at: 0, created_at: 0 }), 0, seedRemote)
assert(revived === null, 'a stale seed does not overwrite a remote tombstone')

const localTomb = planCardWrite('seed-02', null, 80, cardToDoc(content({ id: 'seed-02' }), 10))
assert(localTomb && localTomb.deletedAt === 80, 'a newer local seed tombstone is uploaded')
assert(localTomb.de === 'Hund', 'a tombstone keeps the server vocabulary when only the time changes')

const remoteTombstone = cardToDoc(content({ id: 'custom-1', de: 'alt', updated_at: 40 }), 100)
remoteTombstone.deletedAt = 100
const editedCustom = content({ id: 'custom-1', de: 'neu', en: 'new', updated_at: 200 })
const restored = planCardWrite('custom-1', editedCustom, 0, remoteTombstone)
assert(restored && restored.de === 'neu' && restored.updated_at === 200 && restored.deletedAt === 0, 'a newer custom edit clears a remote tombstone')
const pulled = docsToFiles(
  {
    cards: [{ id: 'custom-1', data: restored }],
    progress: [],
    settings: { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 0 },
  },
  'joakim',
  0,
)
assert(pulled.deck.cards.some((card) => card.id === 'custom-1' && card.de === 'neu'), 'the next pull keeps the restored custom card')
assert(pulled.deck.deleted_ids['custom-1'] === undefined, 'the restored custom card is not a tombstone')

const withHistory = planCardWrite('custom-1', editedCustom, 100, remoteTombstone)
assert(withHistory && withHistory.de === 'neu' && withHistory.deletedAt === 0, 'a historical local tombstone does not stay on a newer custom edit')

const olderCustom = planCardWrite('custom-1', content({ id: 'custom-1', de: 'stale', updated_at: 50 }), 0, remoteTombstone)
assert(olderCustom === null, 'an older custom edit does not clear a newer tombstone')

const tiedCustom = planCardWrite('custom-1', content({ id: 'custom-1', de: 'gleich', updated_at: 100 }), 100, remoteTombstone)
assert(tiedCustom === null, 'a custom edit at the tombstone time stays deleted')

const customTomb = planCardWrite('custom-1', null, 300, cardToDoc(content({ id: 'custom-1', updated_at: 200 }), 0))
assert(customTomb && customTomb.deletedAt === 300, 'a newer custom deletion is uploaded')

const progressSame = planProgressWrite(srs(), {
  ease: 2.5, interval: 1, reps: 1, due: 50, updated_at: 50,
})
assert(progressSame === null, 'an unchanged schedule does not write')

const progressTie = planProgressWrite(srs({ ease: 2.2, updated_at: 50 }), {
  ease: 2.6, interval: 1, reps: 1, due: 50, updated_at: 50,
})
assert(progressTie === null, 'an equal progress clock keeps the remote schedule and does not write')

const progressNewer = planProgressWrite(srs({ ease: 2.2, updated_at: 90 }), {
  ease: 2.6, interval: 1, reps: 1, due: 50, updated_at: 50,
})
assert(progressNewer && progressNewer.ease === 2.2 && !('direction' in progressNewer), 'a newer review does not carry settings')

const settingsTie = planSettingsWrite(
  { direction: 'en-de', sessionSize: 10, tier: 2 },
  15,
  { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 15 },
)
assert(settingsTie && settingsTie.direction === 'en-de', 'an equal settings clock keeps the local settings')

const missingClock = planSettingsWrite(
  { direction: 'en-de', sessionSize: 10, tier: 2 },
  0,
  { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 15 },
)
assert(missingClock === null, 'a zero settings clock loses to a real remote clock')

const bothMissing = planSettingsWrite(
  { direction: 'en-de', sessionSize: 10, tier: 2 },
  0,
  { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 0 },
)
assert(bothMissing && bothMissing.direction === 'en-de', 'a zero settings clock is not epoch, so a tie keeps local')

const unchangedAll = planSettingsWrite(
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: [] },
  15,
  { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 15 },
)
assert(unchangedAll === null, 'a missing word-type filter already means All and does not write')

const uploadTypes = planSettingsWrite(
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['verb', 'noun', 'noun', 'adverb'] },
  20,
  { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 15 },
)
assert(uploadTypes && uploadTypes.wordTypes.join() === 'noun,verb', 'a newer type filter is stored sorted, without unknown values')
assert(uploadTypes.settingsUpdatedAt === 20, 'the type filter uses the settings clock')

const keepRemoteTypes = planSettingsWrite(
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['noun'] },
  10,
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['verb'], settingsUpdatedAt: 15 },
)
assert(keepRemoteTypes === null, 'an older type filter does not replace a newer one')

const clearTypes = planSettingsWrite(
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: [] },
  30,
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['adj'], settingsUpdatedAt: 15 },
)
assert(clearTypes && clearTypes.wordTypes === undefined, 'All removes the stored type filter')

const sameTypes = planSettingsWrite(
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['noun', 'verb'] },
  15,
  { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['verb', 'noun'], settingsUpdatedAt: 15 },
)
assert(sameTypes === null, 'type order does not cause a settings write')

const kept = applyAck({ revision: 6, acked: 0 }, 5)
assert(kept.acked === 5 && isDirty(kept), 'acking the sent revision leaves a later edit dirty')
const done = applyAck({ revision: 5, acked: 0 }, 5)
assert(!isDirty(done), 'acking the current revision clears that record')
assert(applyAck({ revision: 5, acked: 0 }, 9).acked === 0, 'a revision this record does not have is not acknowledged')

assert(!ackAllowed({ uid: 'alice', generation: 1 }, { uid: 'bob', generation: 1 }), 'another account cannot take the acknowledgement')
assert(!ackAllowed({ uid: 'alice', generation: 1 }, { uid: 'alice', generation: 2 }), 'a newer sign-in cannot take the old acknowledgement')
assert(ackAllowed({ uid: 'alice', generation: 2 }, { uid: 'alice', generation: 2 }), 'the same account session can acknowledge')

const ids = Array.from({ length: 514 }, (_, index) => `n${String(index).padStart(3, '0')}`)
const groups = chunkItems(ids)
assert(groups.length > 1, '514 cards take more than one chunk')
assert(groups.every((group) => group.length < 500), 'no chunk reaches 500 writes')
assert(groups[0].length === WRITE_CHUNK && groups[0].length + groups[1].length === 514, 'the first chunk is 499 and the rest follow')

const pending = emptyPending()
pending.cards['b'] = { revision: 2, acked: 0 }
pending.cards['a'] = { revision: 2, acked: 2 }
pending.tombstones['b'] = { revision: 3, acked: 0 }
pending.progress['p'] = { revision: 4, acked: 0 }
pending.settings = { revision: 1, acked: 0 }
const items = listPushItems(pending)
assert(items[0].kind === 'card' && items[0].id === 'b' && items[0].contentRevision === 2 && items[0].tombstoneRevision === 3, 'a card and its tombstone upload once')
assert(items.some((item) => item.kind === 'progress' && item.id === 'p'), 'a dirty schedule is included')
assert(items.at(-1).kind === 'settings', 'settings ride along after the cards')
assert(!items.some((item) => item.kind === 'card' && item.id === 'a'), 'an acknowledged card is not uploaded again')

const round = normalizePending(pending)
assert(hasDirty(round), 'dirty markers survive normalization')
assert(!hasDirty(normalizePending({ cards: { a: { revision: 1, acked: 1 } } })), 'garbage and clean markers are not dirty')

const previous = { ...content(), srs: srs() }
assert(!contentChanged(previous, { ...previous, srs: srs({ due: 90, updated_at: 90 }) }), 'a review is not a content edit')
assert(progressChanged(previous, { ...previous, srs: srs({ due: 90, updated_at: 90 }) }), 'a review dirties progress')
assert(contentChanged(previous, { ...previous, de: 'Katze', updated_at: 9 }), 'a vocabulary edit dirties the card')
assert(!progressChanged(previous, { ...previous, de: 'Katze', updated_at: 9 }), 'a vocabulary edit does not dirty progress')

const guestSchedule = srs({ ease: 3, updated_at: 0 })
const accountSchedule = srs({ ease: 2, updated_at: 0 })
assert(reconcileStagedProgress(guestSchedule, accountSchedule).ease === 2, 'a clockless staged copy keeps the account schedule')
assert(reconcileStagedProgress(srs({ ease: 3, updated_at: 9 }), accountSchedule).ease === 3, 'a newer staged review is kept')

const acked = []
let attempts = 0
const retry = await runDirtyQueue(
  [{ kind: 'progress', id: 'p', revision: 4 }],
  {
    locked: () => true,
    push: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return 'wrote'
    },
    ack: async (item) => {
      acked.push(item.revision)
    },
  },
)
assert(!retry.clean && acked.length === 0, 'a failed upload acknowledges nothing')

acked.length = 0
const second = await runDirtyQueue(
  [
    { kind: 'progress', id: 'p', revision: 4 },
    { kind: 'settings', revision: 1 },
  ],
  {
    locked: () => true,
    push: async (item) => {
      if (item.kind === 'settings') throw new Error('expired')
      return 'wrote'
    },
    ack: async (item) => {
      acked.push(item.kind)
    },
  },
)
assert(!second.clean && acked.join() === 'progress', 'a later failure keeps the earlier acknowledgement')

acked.length = 0
const rejected = await runDirtyQueue(
  [
    { kind: 'card', id: 'bad', contentRevision: 1, tombstoneRevision: 0 },
    { kind: 'card', id: 'good', contentRevision: 1, tombstoneRevision: 0 },
  ],
  {
    locked: () => true,
    push: async (item) => {
      if (item.kind === 'card' && item.id === 'bad') throw { code: 'firestore/permission-denied' }
      return 'wrote'
    },
    ack: async (item) => {
      acked.push(item.id)
    },
  },
)
assert(!rejected.clean && rejected.rejected[0].item.id === 'bad' && acked.join() === 'good', 'a rejected record remains dirty while later records upload')

let switched = false
let foreign = 0
const moved = await runDirtyQueue(
  [{ kind: 'card', id: 'a', contentRevision: 1, tombstoneRevision: 0 }],
  {
    locked: () => !switched,
    push: async () => {
      switched = true
      return 'wrote'
    },
    ack: async () => {
      foreign += 1
    },
  },
)
assert(!moved.clean && foreign === 0, 'a uid change before the acknowledgement writes nothing onto the new account')

console.log('record sync ok')

const activityPending = normalizePending({ activity: {
  clean: { revision: 3, acked: 3 }, dirty: { revision: 5, acked: 3 },
} })
assert(!activityPending.activity.clean, 'acknowledged activity marks are pruned on load')
assert(activityPending.activity.dirty.revision === 5, 'dirty activity marks survive normalization')

assert(deckSyncs({ origin: 'original' }), 'the original deck syncs to the cloud deck')
assert(deckSyncs({ origin: 'local' }), 'a created deck syncs cards')
assert(!deckSyncs(undefined), 'a missing active deck does not sync')

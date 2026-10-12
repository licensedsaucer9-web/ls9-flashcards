// Firestore sync against the emulator. Run via `npm run test:rules`, not `npm test`.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { assertFails, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { initializeApp } from 'firebase/app'
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  initializeFirestore,
  memoryLocalCache,
  setDoc,
  terminate,
} from 'firebase/firestore'
import { commitActivity, pullCloud, commitCard, commitProgress, commitSettings } from '../src/cloud-push.ts'
import { applyAck, chunkItems, isDirty, runDirtyQueue } from '../src/record-sync.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function serverUpdated(path) {
  const host = process.env.FIRESTORE_EMULATOR_HOST
  const rest = await fetch(
    `http://${host}/v1/projects/demo-german-flashcards/databases/(default)/documents/${path}`,
    { headers: { Authorization: 'Bearer owner' } },
  )
  const body = await rest.json()
  return body.updateTime || ''
}

function orTimeout(promise, ms = 8000) {
  promise.catch(() => {})
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('offline')), ms)),
  ])
}

function deniedCode(err) {
  return /permission-denied|unauthenticated/.test(String(err?.code || err?.message || err))
}

const ALICE = 'alice'
const BOB = 'bob'

function content(id, over = {}) {
  return {
    id,
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
  return { ease: 2.5, interval: 1, reps: 1, due: 1_700_000_000_000, updated_at: 1_700_000_000_000, ...over }
}

function cardDoc(id, over = {}) {
  return {
    de: 'Hund',
    en: 'dog',
    article: 'der',
    example_de: 'Der Hund.',
    example_en: 'The dog.',
    tags: ['a1'],
    created_at: 1,
    updated_at: 2,
    deletedAt: 0,
    ...over,
    ...(id ? {} : {}),
  }
}

const stores = []

const env = await initializeTestEnvironment({
  projectId: 'demo-german-flashcards',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
})

function db(uid, port, label = '') {
  const app = initializeApp(
    { apiKey: 'demo-key', projectId: 'demo-german-flashcards', appId: 'demo-app' },
    `${uid || 'signed-out'}-${port || 'live'}-${label}`,
  )
  const store = initializeFirestore(app, { localCache: memoryLocalCache() })
  const [host, portText] = String(process.env.FIRESTORE_EMULATOR_HOST).split(':')
  connectFirestoreEmulator(
    store,
    host,
    port || Number(portText),
    uid ? { mockUserToken: { sub: uid, user_id: uid } } : undefined,
  )
  stores.push(store)
  return store
}

try {
  await env.clearFirestore()
  const alice = db(ALICE)
  const bob = db(BOB)
  await setDoc(doc(alice, 'users', ALICE), { deckId: ALICE, schemaVersion: 1, migrationStatus: 'new' })
  await setDoc(doc(alice, 'decks', ALICE), { memberUids: [ALICE] })
  await setDoc(doc(bob, 'users', BOB), { deckId: BOB, schemaVersion: 1, migrationStatus: 'new' })
  await setDoc(doc(bob, 'decks', BOB), { memberUids: [BOB] })

  const aliceSecond = db(ALICE, undefined, 'second-device')
  const event = { at: 1790856000000, timeZone: 'Europe/Oslo' }
  const eventId = randomUUID()
  await Promise.all(Array.from({ length: 10 }, (_, i) => commitActivity(i % 2 ? alice : aliceSecond, ALICE, randomUUID(), event)))
  await Promise.all([commitActivity(alice, ALICE, eventId, event), commitActivity(aliceSecond, ALICE, eventId, event)])
  assert((await pullCloud(alice, ALICE, ALICE)).activity.length === 11, 'concurrent devices retain every unique grade, with a duplicate counted once')
  const eventAt = await serverUpdated(`users/${ALICE}/activity/${eventId}`)
  assert(await commitActivity(aliceSecond, ALICE, eventId, event) === 'noop', 'activity retry is a no-op')
  assert(await serverUpdated(`users/${ALICE}/activity/${eventId}`) === eventAt, 'activity retry makes no server write')
  let collision = false
  try { await commitActivity(alice, ALICE, eventId, { ...event, at: event.at + 1 }) } catch { collision = true }
  assert(collision, 'an ID collision cannot overwrite activity')
  await assertFails(commitActivity(bob, ALICE, randomUUID(), event))

  const grade = { kind: 'progress', id: 'card-grade', revision: 4 }
  const gradeAcks = []
  // disableNetwork does not stop emulator transactions in this SDK, so the
  // offline client is pointed at a closed port. The in-memory cache has no
  // second queue: the transaction rejects and nothing is acknowledged.
  const offlineDb = db(ALICE, 1)
  const offlineEventId = randomUUID()
  const activityItem = { kind: 'activity', id: offlineEventId, revision: 5 }
  let activityAcks = 0
  const activityOffline = await runDirtyQueue([activityItem], {
    locked: () => true,
    push: () => orTimeout(commitActivity(offlineDb, ALICE, offlineEventId, event)),
    ack: async () => { activityAcks++ },
  })
  assert(!activityOffline.clean && activityAcks === 0, 'offline activity remains pending')
  const activityRetry = await runDirtyQueue([activityItem], {
    locked: () => true,
    push: () => commitActivity(aliceSecond, ALICE, offlineEventId, event),
    ack: async () => { activityAcks++ },
  })
  assert(activityRetry.clean && activityAcks === 1, 'reconnected activity is acknowledged once')
  const offline = await runDirtyQueue([grade], {
    locked: () => true,
    push: () => orTimeout(commitProgress(offlineDb, ALICE, 'card-grade', srs())),
    ack: async (item) => {
      gradeAcks.push(item.revision)
    },
  })
  assert(!offline.clean && gradeAcks.length === 0, 'an offline grade is not acknowledged and is not Synced')
  assert(!(await getDoc(doc(alice, 'users', ALICE, 'progress', 'card-grade'))).exists(), 'the offline grade did not land')

  const reopened = await runDirtyQueue([grade], {
    locked: () => true,
    push: () => commitProgress(alice, ALICE, 'card-grade', srs()),
    ack: async (item) => {
      gradeAcks.push(item.revision)
    },
  })
  assert(reopened.clean && gradeAcks.join() === '4', 'reopening pushes the same unacknowledged grade')
  const graded = await getDoc(doc(alice, 'users', ALICE, 'progress', 'card-grade'))
  assert(graded.exists() && graded.data().reps === 1, 'the grade is stored for that account')
  const gradedAt = await serverUpdated(`users/${ALICE}/progress/card-grade`)
  const again = await commitProgress(alice, ALICE, 'card-grade', srs())
  const gradedAgain = await serverUpdated(`users/${ALICE}/progress/card-grade`)
  assert(again === 'noop' && gradedAgain === gradedAt && gradedAt !== '', 'a no-op merge does not write')

  const dropped = await orTimeout(commitProgress(offlineDb, ALICE, 'card-retry', srs({ reps: 2 }))).then(
    () => false,
    () => true,
  )
  assert(dropped, 'a lost connection fails the upload')
  assert((await commitProgress(alice, ALICE, 'card-retry', srs({ reps: 2 }))) === 'wrote', 'reconnecting retries the upload')

  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'decks', 'shared'), { memberUids: [ALICE, BOB] })
  })
  assert((await commitCard(alice, 'shared', 'card-a', content('card-a', { de: 'A', en: 'a' }), 0)) === 'wrote', 'alice writes her card')
  assert((await commitCard(bob, 'shared', 'card-b', content('card-b', { de: 'B', en: 'b' }), 0)) === 'wrote', 'bob writes a different card')
  const seenByBob = await getDoc(doc(bob, 'decks', 'shared', 'cards', 'card-a'))
  const seenByAlice = await getDoc(doc(alice, 'decks', 'shared', 'cards', 'card-b'))
  assert(seenByBob.data().de === 'A' && seenByAlice.data().de === 'B', 'two devices keep both cards')

  await commitProgress(alice, ALICE, 'card-a', srs({ reps: 3 }))
  const leaked = await assertFails(getDoc(doc(bob, 'users', ALICE, 'progress', 'card-a')))
  assert(deniedCode(leaked), 'bob cannot read alice progress')

  await setDoc(doc(alice, 'decks', ALICE, 'cards', 'card-conflict'), cardDoc('card-conflict', { de: 'alt', updated_at: 500 }))
  const stale = await commitCard(alice, ALICE, 'card-conflict', content('card-conflict', { de: 'neu', updated_at: 100 }), 0)
  const conflict = await getDoc(doc(alice, 'decks', ALICE, 'cards', 'card-conflict'))
  assert(stale === 'noop' && conflict.data().de === 'alt', 'the newer server card wins a conflict')
  const won = await commitCard(alice, ALICE, 'card-conflict', content('card-conflict', { de: 'neu', updated_at: 900 }), 0)
  const afterWin = await getDoc(doc(alice, 'decks', ALICE, 'cards', 'card-conflict'))
  assert(won === 'wrote' && afterWin.data().de === 'neu', 'the newer local card wins a conflict')

  await setDoc(doc(alice, 'decks', ALICE, 'cards', 'seed-01'), cardDoc('seed-01', {
    de: 'Hund',
    updated_at: 0,
    created_at: 0,
    deletedAt: 50,
  }))
  const tombstone = await commitCard(
    alice,
    ALICE,
    'seed-01',
    content('seed-01', { updated_at: 0, created_at: 0 }),
    0,
  )
  const seed = await getDoc(doc(alice, 'decks', ALICE, 'cards', 'seed-01'))
  assert(tombstone === 'noop' && seed.data().deletedAt === 50, 'a deleted seed stays deleted when a stale device reconnects')

  let ackedRevision = 0
  const during = await runDirtyQueue(
    [{ kind: 'card', id: 'card-during', contentRevision: 5, tombstoneRevision: 0 }],
    {
      locked: () => true,
      push: () => commitCard(alice, ALICE, 'card-during', content('card-during', { de: 'before', updated_at: 5 }), 0),
      ack: async (item) => {
        ackedRevision = item.contentRevision
        const mark = applyAck({ revision: 6, acked: 0 }, item.contentRevision)
        assert(isDirty(mark) && mark.acked === 5, 'the edit made during the upload stays dirty')
      },
    },
  )
  const duringDoc = await getDoc(doc(alice, 'decks', ALICE, 'cards', 'card-during'))
  assert(during.clean && ackedRevision === 5 && duringDoc.data().de === 'before', 'the acknowledgement is the revision that was sent')

  const partialAcks = []
  const partial = await runDirtyQueue(
    [
      { kind: 'progress', id: 'card-ok', revision: 1 },
      { kind: 'progress', id: 'card-fail', revision: 2 },
    ],
    {
      locked: () => true,
      push: async (item) => {
        if (item.kind === 'progress' && item.id === 'card-fail') {
          return orTimeout(commitProgress(offlineDb, ALICE, item.id, srs({ reps: item.revision })))
        }
        return commitProgress(alice, ALICE, item.id, srs({ reps: item.revision }))
      },
      ack: async (item) => {
        partialAcks.push(item.id)
      },
    },
  )
  assert(!partial.clean && partialAcks.join() === 'card-ok', 'a partial failure keeps the first acknowledgement and is not Synced')
  assert((await getDoc(doc(alice, 'users', ALICE, 'progress', 'card-ok'))).exists(), 'the first record was committed')
  assert(!(await getDoc(doc(alice, 'users', ALICE, 'progress', 'card-fail'))).exists(), 'the failed record was not committed')

  const rejectedAcks = []
  const denied = await runDirtyQueue(
    [
      { kind: 'card', id: 'card-invalid', contentRevision: 1, tombstoneRevision: 0 },
      { kind: 'card', id: 'card-valid', contentRevision: 1, tombstoneRevision: 0 },
    ],
    {
      locked: () => true,
      push: (item) => commitCard(
        alice,
        ALICE,
        item.id,
        content(item.id, { example_de: item.id === 'card-invalid' ? 'x'.repeat(1001) : 'valid' }),
        0,
      ),
      ack: async (item) => {
        rejectedAcks.push(item.id)
      },
    },
  )
  assert(!denied.clean && denied.rejected.length === 1 && denied.rejected[0].code === 'permission-denied', 'rules rejection keeps the queue pending')
  assert(rejectedAcks.join() === 'card-valid', 'a valid record behind a rejected card is acknowledged')
  assert((await getDoc(doc(alice, 'decks', ALICE, 'cards', 'card-valid'))).exists(), 'the valid later card reached the server')

  const expiredAcks = []
  const expired = await runDirtyQueue(
    [{ kind: 'settings', revision: 3 }],
    {
      locked: () => true,
      push: () => commitSettings(db(null), ALICE, { direction: 'de-en', sessionSize: 20, tier: 1 }, 3),
      ack: async () => {
        expiredAcks.push('acked')
      },
    },
  )
  assert(!expired.clean && expiredAcks.length === 0, 'an expired sign-in does not acknowledge')

  const imported = Array.from({ length: 514 }, (_, index) => {
    const id = `n${String(index).padStart(3, '0')}`
    return {
      item: { kind: 'card', id, contentRevision: 1, tombstoneRevision: 0 },
      body: content(id, { de: `w${index}`, en: `e${index}`, updated_at: 8 }),
    }
  })
  const uploaded = await runDirtyQueue(
    imported.map((row) => row.item),
    {
      locked: () => true,
      push: (item) => {
        const row = imported.find((candidate) => candidate.item.id === item.id)
        return commitCard(alice, ALICE, item.id, row.body, 0)
      },
      ack: async () => {},
    },
  )
  assert(
    uploaded.clean && uploaded.chunkSizes.length > 1 && uploaded.chunkSizes.every((size) => size < 500),
    'a 514-card import is chunked under 500 writes',
  )
  assert(chunkItems(imported).length === uploaded.chunkSizes.length, 'the upload uses the shared chunk size')
  const sample = await getDoc(doc(alice, 'decks', ALICE, 'cards', 'n513'))
  const first = await getDoc(doc(alice, 'decks', ALICE, 'cards', 'n000'))
  assert(sample.exists() && first.exists() && sample.data().de === 'w513', 'both chunks were written')

  await commitSettings(alice, ALICE, { direction: 'en-de', sessionSize: 10, tier: 2 }, 100)
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const timeZone of ['Not/AZone', 'UTC+1']) {
      await setDoc(doc(ctx.firestore(), 'users', ALICE, 'activity', randomUUID()), { ...event, timeZone })
    }
  })
  const warnings = []
  const warn = console.warn
  let pulled
  try {
    console.warn = message => warnings.push(message)
    pulled = await pullCloud(alice, ALICE, ALICE)
  } finally { console.warn = warn }
  assert(warnings.length === 1 && warnings[0] === 'Skipped 2 invalid cloud review activity events', 'pull reports aggregate skipped count')
  assert(pulled.activity.length === 12, 'pull retains valid events beside corrupt rows')
  assert(pulled.cards.some(row => row.id === 'n513') && pulled.progress.some(row => row.id === 'card-grade')
    && pulled.settings.direction === 'en-de', 'invalid activity cannot block other account data')
  console.log('cloud sync emulator ok')
} finally {
  await Promise.all(stores.map((store) => terminate(store).catch(() => {})))
  await env.cleanup()
}

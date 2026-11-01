// Account deletion against the emulator: rules and the client-side deletion flow,
// including an interrupted run and a run stopped by the daily budget. Run via `npm run test:rules`.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { initializeApp } from 'firebase/app'
import {
  collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, initializeFirestore,
  memoryLocalCache, query, setDoc, terminate, where, writeBatch,
} from 'firebase/firestore'
import {
  DAILY_DELETE_BUDGET, DELETE_BATCH, deleteAccountData, quotaDay, readDeletionMarker,
  remainingBudget, startDeletionMarker, writeDeletionMarker, clearDeletionMarker,
} from '../src/account-deletion.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function denied(promise, label) {
  const err = await assertFails(promise)
  assert(/permission-denied/.test(String(err?.code || err?.message || err)), `${label}: expected permission-denied, got ${err?.code || err}`)
}

const ALICE = 'alice'
const BOB = 'bob'
const EXTRA = randomUUID()
const BOB_EXTRA = randomUUID()
const CARDS = 1200
const stores = []

const env = await initializeTestEnvironment({
  projectId: 'demo-german-flashcards',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
})

function client(uid, label = '') {
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-german-flashcards', appId: 'demo-app' }, `${uid || 'signed-out'}-deletion-${label}`)
  const store = initializeFirestore(app, { localCache: memoryLocalCache() })
  const [host, port] = String(process.env.FIRESTORE_EMULATOR_HOST).split(':')
  connectFirestoreEmulator(store, host, Number(port), uid ? { mockUserToken: { sub: uid, user_id: uid } } : undefined)
  stores.push(store)
  return store
}

function rulesDb(uid) {
  return (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore()
}

const card = (id) => ({ de: `Wort ${id}`, en: 'word', article: 'none', example_de: '', example_en: '', tags: [], created_at: 1, updated_at: 2, deletedAt: 0 })
const progress = { ease: 2.5, interval: 1, reps: 1, due: 1_700_000_000_000, updated_at: 1_700_000_000_000 }
const settings = { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 10 }
const event = { at: 1790856000000, timeZone: 'Europe/Oslo' }

async function seed() {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore()
    const writes = []
    const put = (path, data) => writes.push([path, data])
    for (const uid of [ALICE, BOB]) {
      put(['users', uid], { deckId: uid, schemaVersion: 1, migrationStatus: 'new' })
      put(['decks', uid], { memberUids: [uid] })
      put(['users', uid, 'settings', 'current'], settings)
      for (let i = 0; i < 30; i += 1) put(['users', uid, 'progress', `seed-${i}`], progress)
      for (let i = 0; i < 20; i += 1) put(['users', uid, 'activity', randomUUID()], event)
    }
    for (let i = 0; i < CARDS; i += 1) put(['decks', ALICE, 'cards', `seed-${i}`], card(i))
    for (let i = 0; i < 3; i += 1) put(['decks', BOB, 'cards', `seed-${i}`], card(i))
    put(['decks', EXTRA], { ownerUid: ALICE, memberUids: [ALICE] })
    for (let i = 0; i < 5; i += 1) put(['decks', EXTRA, 'cards', `fr-${i}`], card(i))
    for (let i = 0; i < 3; i += 1) put(['users', ALICE, 'decks', EXTRA, 'progress', `fr-${i}`], progress)
    put(['users', ALICE, 'decks', EXTRA, 'settings', 'current'], settings)
    // Progress left under a deck whose document is already gone is still found through the device's deck list.
    put(['users', ALICE, 'decks', 'orphan-deck', 'progress', 'x-1'], progress)
    put(['decks', BOB_EXTRA], { ownerUid: BOB, memberUids: [BOB] })
    put(['decks', BOB_EXTRA, 'cards', 'es-1'], card(1))
    // A shared deck Alice is only a member of keeps its vocabulary for the others.
    put(['decks', 'legacy'], { memberUids: [ALICE, BOB] })
    put(['decks', 'legacy', 'cards', 'seed-1'], card(1))
    put(['feedback', 'f1'], { message: 'hello', createdAt: new Date(), appVersion: '1.5.0', uid: ALICE })
    put(['feedback', 'f2'], { message: 'anon', createdAt: new Date(), appVersion: '1.5.0' })
    for (let i = 0; i < writes.length; i += 400) {
      const batch = writeBatch(admin)
      for (const [path, data] of writes.slice(i, i + 400)) batch.set(doc(admin, ...path), data)
      await batch.commit()
    }
  })
}

async function count(...path) {
  let size = 0
  await env.withSecurityRulesDisabled(async (ctx) => {
    size = (await getDocs(collection(ctx.firestore(), ...path))).size
  })
  return size
}

async function exists(...path) {
  let found = false
  await env.withSecurityRulesDisabled(async (ctx) => {
    found = (await getDoc(doc(ctx.firestore(), ...path))).exists()
  })
  return found
}

async function aliceLeft() {
  return (await count('users', ALICE, 'activity')) + (await count('users', ALICE, 'progress'))
    + (await count('decks', ALICE, 'cards')) + (await count('decks', EXTRA, 'cards'))
    + (await count('users', ALICE, 'decks', EXTRA, 'progress')) + (await count('users', ALICE, 'decks', 'orphan-deck', 'progress'))
    + Number(await exists('users', ALICE)) + Number(await exists('decks', ALICE)) + Number(await exists('decks', EXTRA))
    + Number(await exists('users', ALICE, 'settings', 'current')) + Number(await exists('users', ALICE, 'decks', EXTRA, 'settings', 'current'))
}

async function othersIntact() {
  assert(await exists('users', BOB) && await exists('decks', BOB) && await exists('decks', BOB_EXTRA), 'Bob keeps his account and decks')
  assert(await count('users', BOB, 'progress') === 30 && await count('users', BOB, 'activity') === 20, 'Bob keeps progress and activity')
  assert(await count('decks', BOB, 'cards') === 3 && await count('decks', BOB_EXTRA, 'cards') === 1, 'Bob keeps cards')
  assert(await exists('decks', 'legacy') && await count('decks', 'legacy', 'cards') === 1, 'a shared deck keeps its document and cards')
  assert(await count('feedback') === 2, 'feedback is kept, including entries that named the account')
}

try {
  // Rules: owners delete only their own documents.
  await seed()
  const userPaths = [
    ['users', ALICE, 'activity'], ['users', ALICE, 'progress'], ['users', ALICE, 'decks', EXTRA, 'progress'],
  ]
  for (const path of userPaths) {
    const first = (await getDocs(collection(rulesDb(ALICE), ...path))).docs[0].id
    await denied(deleteDoc(doc(rulesDb(BOB), ...path, first)), `cross-account delete ${path.join('/')}`)
    await denied(deleteDoc(doc(rulesDb(null), ...path, first)), `signed-out delete ${path.join('/')}`)
    await assertSucceeds(deleteDoc(doc(rulesDb(ALICE), ...path, first)))
  }
  for (const path of [['users', ALICE, 'settings', 'current'], ['users', ALICE, 'decks', EXTRA, 'settings', 'current']]) {
    await denied(deleteDoc(doc(rulesDb(BOB), ...path)), `cross-account delete ${path.join('/')}`)
  }
  await denied(deleteDoc(doc(rulesDb(BOB), 'users', ALICE)), 'cross-account account delete')
  await denied(deleteDoc(doc(rulesDb(BOB), 'decks', ALICE, 'cards', 'seed-1')), 'outsider personal-deck card delete')
  await denied(deleteDoc(doc(rulesDb(BOB), 'decks', ALICE)), 'outsider personal-deck delete')
  await denied(deleteDoc(doc(rulesDb(BOB), 'decks', EXTRA, 'cards', 'fr-1')), 'outsider extra-deck card delete')
  await denied(deleteDoc(doc(rulesDb(BOB), 'decks', EXTRA)), 'outsider extra-deck delete')
  await denied(deleteDoc(doc(rulesDb(ALICE), 'decks', 'legacy', 'cards', 'seed-1')), 'member deletes a shared-deck card')
  await denied(deleteDoc(doc(rulesDb(ALICE), 'decks', 'legacy')), 'member deletes a shared deck')
  await denied(deleteDoc(doc(rulesDb(ALICE), 'decks', BOB_EXTRA)), 'deletes another owner\'s deck')
  await denied(deleteDoc(doc(rulesDb(ALICE), 'feedback', 'f1')), 'feedback delete')
  await assertSucceeds(deleteDoc(doc(rulesDb(ALICE), 'decks', ALICE, 'cards', 'seed-1')))
  await assertSucceeds(deleteDoc(doc(rulesDb(ALICE), 'decks', EXTRA, 'cards', 'fr-1')))
  const owned = await assertSucceeds(getDocs(query(collection(rulesDb(ALICE), 'decks'), where('ownerUid', '==', ALICE))))
  assert(owned.size === 1 && owned.docs[0].id === EXTRA, `owner lists only decks they created, got ${owned.size}`)
  await denied(getDocs(collection(rulesDb(ALICE), 'decks')), 'unfiltered deck list')
  await denied(getDocs(query(collection(rulesDb(ALICE), 'decks'), where('ownerUid', '==', BOB))), 'list another owner\'s decks')
  await denied(getDocs(query(collection(rulesDb(null), 'decks'), where('ownerUid', '==', ALICE))), 'signed-out deck list')

  // Budget and marker bookkeeping.
  const day0 = Date.UTC(2026, 10, 1, 12)
  assert(quotaDay(Date.UTC(2026, 10, 2, 6)) === '2026-11-01', 'the quota day is the Pacific calendar day')
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  const marker = startDeletionMarker(ALICE, day0, null)
  assert(remainingBudget({ ...marker, deletedToday: 9000 }, day0).remaining === DAILY_DELETE_BUDGET - 9000, 'same day spends the same budget')
  assert(remainingBudget({ ...marker, deletedToday: 9000 }, day0 + 86_400_000).remaining === DAILY_DELETE_BUDGET, 'a new Pacific day resets the budget')
  writeDeletionMarker(storage, { ...marker, deletedToday: 7 })
  assert(readDeletionMarker(storage).deletedToday === 7 && readDeletionMarker(storage).uid === ALICE, 'the marker survives a reload')
  assert(startDeletionMarker(ALICE, day0 + 5, readDeletionMarker(storage)).deletedToday === 7, 'resuming keeps the marker')
  assert(startDeletionMarker(BOB, day0, readDeletionMarker(storage)).uid === BOB, 'another account starts its own marker')
  clearDeletionMarker(storage)
  assert(readDeletionMarker(storage) === null, 'marker cleared')

  // The flow: full batches, an interrupted run, a budget stop, then the resumed run finishes.
  await seed()
  const alice = client(ALICE)
  const batches = []
  let crashed = false
  try {
    await deleteAccountData(alice, ALICE, { budget: DAILY_DELETE_BUDGET, knownDeckIds: [EXTRA, 'orphan-deck'], onBatch: (n) => {
      batches.push(n)
      if (batches.length === 2) throw new Error('tab closed')
    } })
  } catch (error) {
    crashed = /tab closed/.test(error.message)
  }
  assert(crashed, 'the interrupted run reports its failure')
  assert(await exists('users', ALICE), 'an interrupted run keeps users/{uid}')

  const stopped = await deleteAccountData(alice, ALICE, { budget: 300, knownDeckIds: [EXTRA, 'orphan-deck'] })
  assert(stopped.state === 'budget' && stopped.deleted === 300, `a spent budget stops the run, got ${JSON.stringify(stopped)}`)
  assert(await exists('users', ALICE) && await exists('decks', ALICE), 'a budget stop keeps the account and its deck documents')

  const sizes = []
  const done = await deleteAccountData(alice, ALICE, { budget: DAILY_DELETE_BUDGET, knownDeckIds: [EXTRA, 'orphan-deck'], onBatch: (n) => sizes.push(n) })
  assert(done.state === 'done', 'the resumed run finishes')
  assert(sizes.includes(DELETE_BATCH), `a full ${DELETE_BATCH}-delete card batch passes the rules (batches ${sizes.join(',')})`)
  assert(Math.max(...sizes) <= DELETE_BATCH, 'no batch exceeds the Firestore limit')
  assert(await aliceLeft() === 0, 'every Alice document is gone')
  await othersIntact()
  const again = await deleteAccountData(alice, ALICE, { budget: DAILY_DELETE_BUDGET, knownDeckIds: [EXTRA] })
  assert(again.state === 'done' && again.deleted === 0, 'running again on a deleted account changes nothing')
  const spent = await deleteAccountData(alice, ALICE, { budget: 0 })
  assert(spent.state === 'done', 'nothing left counts as done even without budget')

  // An outsider cannot use the flow against someone else's account.
  await seed()
  const bob = client(BOB)
  let refused = false
  try { await deleteAccountData(bob, ALICE, { budget: DAILY_DELETE_BUDGET }) } catch (error) { refused = /permission-denied/.test(String(error.code)) }
  assert(refused, 'deleting another account is refused')
  assert(await count('decks', ALICE, 'cards') === CARDS, 'the refused run deleted nothing')
  console.log('account deletion emulator ok')
} finally {
  await Promise.all(stores.map((store) => terminate(store).catch(() => {})))
  await env.cleanup()
}

// Firestore rules against the emulator. Run via `npm run test:rules`, not `npm test`.
import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function deniedCode(err) {
  return /permission-denied/.test(String(err?.code || err?.message || err))
}

async function denied(promise, label) {
  const err = await assertFails(promise)
  assert(deniedCode(err), `${label}: expected permission-denied, got ${err?.code || err}`)
}

const ALICE = 'alice'
const BOB = 'bob'
const CARA = 'cara'
const SEED = 'seed-01'
const CUSTOM = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function account(uid) {
  return { deckId: uid, schemaVersion: 1, migrationStatus: 'new' }
}

function settings(over = {}) {
  return { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 10, ...over }
}

function progress(over = {}) {
  return { ease: 2.5, interval: 1, reps: 1, due: 1_700_000_000_000, updated_at: 1_700_000_000_000, ...over }
}

function card(over = {}) {
  const data = {
    de: 'Hund',
    en: 'dog',
    article: 'der',
    example_de: 'Der Hund.',
    example_en: 'The dog.',
    tags: ['a1'],
    created_at: 1,
    updated_at: 2,
    deletedAt: 0,
    rank: 102,
    tier: 1,
    ...over,
  }
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) delete data[key]
  }
  return data
}

const env = await initializeTestEnvironment({
  projectId: 'demo-german-flashcards',
  firestore: {
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
  },
})

function db(uid) {
  const ctx = uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()
  return ctx.firestore()
}

try {
  await env.clearFirestore()

  await denied(getDoc(doc(db(null), 'users', ALICE)), 'signed-out user read')
  await denied(getDocs(collection(db(null), 'users')), 'signed-out user list')
  await denied(getDoc(doc(db(null), 'decks', ALICE, 'cards', SEED)), 'signed-out card read')
  await denied(getDoc(doc(db(ALICE), 'other', 'thing')), 'default deny')

  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE), account(ALICE)))
  const own = await assertSucceeds(getDoc(doc(db(ALICE), 'users', ALICE)))
  assert(own.data().deckId === ALICE, 'owner can read the account just created')
  await denied(getDoc(doc(db(BOB), 'users', ALICE)), 'cross-user account read')
  await denied(getDocs(collection(db(ALICE), 'users')), 'list users')
  await denied(setDoc(doc(db(ALICE), 'users', BOB), account(BOB)), 'create someone else\'s account')
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE), { ...account(ALICE), deckId: BOB }),
    'forged deckId',
  )
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE), { ...account(ALICE), migrationStatus: 'complete' }),
    'forged migration on create',
  )
  await denied(updateDoc(doc(db(ALICE), 'users', ALICE), { deckId: BOB }), 'change deckId')
  await denied(
    updateDoc(doc(db(ALICE), 'users', ALICE), { migrationStatus: 'complete' }),
    'mark migration complete',
  )
  await denied(deleteDoc(doc(db(ALICE), 'users', ALICE)), 'delete account')

  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ sessionSize: 0 })))
  await assertSucceeds(getDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current')))
  await denied(getDoc(doc(db(BOB), 'users', ALICE, 'settings', 'current')), 'cross-user settings read')
  await denied(setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'other'), settings()), 'settings doc other than current')
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ direction: 'fr-de' })),
    'unknown direction',
  )

  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE, 'progress', SEED), progress()))
  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE, 'progress', CUSTOM), progress({ ease: 1.3, interval: 0, reps: 0 })))
  const progressRows = await assertSucceeds(getDocs(collection(db(ALICE), 'users', ALICE, 'progress')))
  assert(progressRows.size === 2, `owner can list progress, got ${progressRows.size}`)
  await denied(getDoc(doc(db(BOB), 'users', ALICE, 'progress', SEED)), 'cross-user progress read')
  await denied(getDocs(collection(db(BOB), 'users', ALICE, 'progress')), 'cross-user progress list')
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE, 'progress', SEED), progress({ interval: 1.5 })),
    'fractional interval',
  )
  await denied(deleteDoc(doc(db(ALICE), 'users', ALICE, 'progress', SEED)), 'delete progress')

  await denied(setDoc(doc(db(ALICE), 'decks', BOB), { memberUids: [ALICE] }), 'create a deck whose id is not the uid')
  await denied(setDoc(doc(db(ALICE), 'decks', ALICE), { memberUids: [ALICE, BOB] }), 'create a deck with an extra member')
  await assertSucceeds(setDoc(doc(db(ALICE), 'decks', ALICE), { memberUids: [ALICE] }))
  await denied(setDoc(doc(db(ALICE), 'decks', ALICE), { memberUids: [ALICE] }), 'second personal-deck write')
  await denied(updateDoc(doc(db(ALICE), 'decks', ALICE), { memberUids: [ALICE, BOB] }), 'membership change')
  const ownDeck = await assertSucceeds(getDoc(doc(db(ALICE), 'decks', ALICE)))
  assert(ownDeck.data().memberUids.join() === ALICE, 'the personal deck still has one member')
  await denied(getDocs(collection(db(ALICE), 'decks')), 'list decks')

  await env.clearFirestore()
  const left = env.authenticatedContext(ALICE).firestore()
  const right = env.authenticatedContext(ALICE).firestore()
  const payload = { memberUids: [ALICE] }
  const raced = await Promise.allSettled([
    setDoc(doc(left, 'decks', ALICE), payload),
    setDoc(doc(right, 'decks', ALICE), payload),
  ])
  const won = raced.filter((result) => result.status === 'fulfilled')
  assert(won.length === 1, `concurrent personal-deck create succeeded ${won.length} times`)
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore(), 'decks', ALICE))
    assert(snap.exists() && snap.data().memberUids.join() === ALICE, 'the raced create left a single personal deck')
  })

  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const admin = ctx.firestore()
    await setDoc(doc(admin, 'decks', 'legacy'), { memberUids: [ALICE, BOB] })
    await setDoc(doc(admin, 'decks', 'legacy', 'cards', SEED), card())
    await setDoc(doc(admin, 'users', ALICE, 'settings', 'current'), settings())
    await setDoc(doc(admin, 'users', ALICE, 'progress', SEED), progress())
    await setDoc(doc(admin, 'users', BOB, 'settings', 'current'), settings({ direction: 'en-de' }))
    await setDoc(doc(admin, 'users', BOB, 'progress', SEED), progress({ reps: 4 }))
  })

  const sharedCards = await assertSucceeds(getDocs(collection(db(ALICE), 'decks', 'legacy', 'cards')))
  assert(sharedCards.size === 1, 'a member can list shared vocabulary')
  await assertSucceeds(getDoc(doc(db(BOB), 'decks', 'legacy', 'cards', SEED)))
  await assertSucceeds(setDoc(doc(db(BOB), 'decks', 'legacy', 'cards', CUSTOM), card({ rank: undefined, tier: undefined, tags: [] })))
  await assertSucceeds(getDoc(doc(db(ALICE), 'decks', 'legacy', 'cards', CUSTOM)))
  await assertSucceeds(setDoc(doc(db(ALICE), 'decks', 'legacy', 'cards', SEED), card({ deletedAt: 60 })))
  const tombstone = await assertSucceeds(getDoc(doc(db(BOB), 'decks', 'legacy', 'cards', SEED)))
  assert(tombstone.data().deletedAt === 60, 'a member can write a deletion timestamp')
  await denied(deleteDoc(doc(db(ALICE), 'decks', 'legacy', 'cards', SEED)), 'delete a card document')
  await denied(getDoc(doc(db(CARA), 'decks', 'legacy', 'cards', SEED)), 'outsider card read')
  await denied(getDocs(collection(db(CARA), 'decks', 'legacy', 'cards')), 'outsider card list')
  await denied(setDoc(doc(db(CARA), 'decks', 'legacy', 'cards', 'seed-02'), card()), 'outsider card write')
  await denied(getDoc(doc(db(ALICE), 'users', BOB, 'progress', SEED)), 'shared-deck member reads the other progress')
  await denied(getDoc(doc(db(ALICE), 'users', BOB, 'settings', 'current')), 'shared-deck member reads the other settings')
  await denied(getDocs(collection(db(BOB), 'users', ALICE, 'progress')), 'shared-deck member lists the other progress')
  const ownProgress = await assertSucceeds(getDoc(doc(db(ALICE), 'users', ALICE, 'progress', SEED)))
  assert(ownProgress.data().reps === 1, 'a member still reads their own progress')
  await denied(
    setDoc(doc(db(ALICE), 'decks', 'legacy', 'cards', 'bad.id'), card()),
    'card id outside the existing id style',
  )
  await denied(
    setDoc(doc(db(ALICE), 'decks', 'legacy', 'cards', SEED), card({ de: 'x'.repeat(201) })),
    'overlong vocabulary',
  )
  await denied(
    setDoc(doc(db(ALICE), 'decks', 'legacy', 'cards', 'seed-02'), card({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) })),
    'too many tags',
  )

  console.log('firestore rules ok')
} finally {
  await env.cleanup()
}

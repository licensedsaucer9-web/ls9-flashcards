// Firestore rules against the emulator. Run via `npm run test:rules`, not `npm test`.
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright-core'
import { canonicalReviewTimeZone, validReviewEvent } from '../src/streak.ts'
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

  const progressDeckId = randomUUID()
  for (const [kind, id, valid, invalid] of [
    ['progress', SEED, progress(), progress({ reps: -1 })],
    ['settings', 'current', settings({ direction: 'en-de' }), settings({ direction: 'fr-en' })],
  ]) {
    const ref = uid => doc(db(uid), 'users', ALICE, 'decks', progressDeckId, kind, id)
    await denied(getDoc(ref(null)), 'signed-out extra-deck read')
    await denied(setDoc(ref(null), valid), 'signed-out extra-deck write')
    await denied(setDoc(ref(BOB), valid), 'cross-account extra-deck write')
    await assertSucceeds(setDoc(ref(ALICE), valid))
    await assertSucceeds(getDoc(ref(ALICE)))
    if (kind === 'progress') await assertSucceeds(getDocs(collection(db(ALICE), 'users', ALICE, 'decks', progressDeckId, kind)))
    await denied(getDoc(ref(BOB)), 'cross-account extra-deck read')
    await denied(getDocs(collection(db(BOB), 'users', ALICE, 'decks', progressDeckId, kind)), 'cross-account extra-deck list')
    await denied(setDoc(ref(ALICE), invalid), 'invalid extra-deck shape')
    await denied(deleteDoc(ref(ALICE)), 'extra-deck delete')
    await assertSucceeds(setDoc(ref(ALICE), valid))
  }
  await denied(setDoc(doc(db(ALICE), 'users', ALICE, 'decks', progressDeckId, 'settings', 'other'), settings()), 'extra settings singleton')
  const eventId = randomUUID()
  const event = { at: 1790856000000, timeZone: 'Europe/Oslo' }
  const eventRef = (uid, id = eventId) => doc(db(uid), 'users', ALICE, 'activity', id)
  await denied(getDoc(eventRef(null)), 'signed-out activity read')
  await denied(setDoc(eventRef(null), event), 'signed-out activity create')
  await denied(setDoc(eventRef(BOB), event), 'cross-account activity create')
  await assertSucceeds(setDoc(eventRef(ALICE), event))
  await assertSucceeds(getDoc(eventRef(ALICE)))
  await assertSucceeds(getDocs(collection(db(ALICE), 'users', ALICE, 'activity')))
  await denied(getDoc(eventRef(BOB)), 'cross-account activity read')
  await denied(getDocs(collection(db(BOB), 'users', ALICE, 'activity')), 'cross-account activity list')
  await denied(updateDoc(eventRef(ALICE), { at: event.at + 1 }), 'immutable activity update')
  await denied(deleteDoc(eventRef(null)), 'signed-out activity delete')
  await denied(deleteDoc(eventRef(BOB)), 'cross-account activity delete')
  await assertSucceeds(deleteDoc(eventRef(ALICE)))
  for (const timeZone of ['UTC', 'Etc/UTC', 'Etc/GMT+1', 'America/Argentina/Buenos_Aires']) {
    await assertSucceeds(setDoc(eventRef(ALICE, randomUUID()), { ...event, timeZone }))
  }
  // Use Chromium's actual device zone, including its raw-offset responses.
  for (const [TZ, expected] of [['GMT', 'UTC'], ['GMT+1', 'Etc/GMT-1'], ['GMT-5', 'Etc/GMT+5']]) {
    const browser = await chromium.launch({
      executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: { ...process.env, TZ },
    })
    try {
      const page = await browser.newPage()
      const raw = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
      const timeZone = canonicalReviewTimeZone(raw)
      assert(timeZone === expected, `Chromium TZ=${TZ}: canonical zone`)
      const id = randomUUID()
      const data = { ...event, timeZone }
      assert(validReviewEvent(id, data), `Chromium TZ=${TZ}: valid client event`)
      await assertSucceeds(setDoc(eventRef(ALICE, id), data))
    } finally { await browser.close() }
  }
  for (const timeZone of ['Factory', 'UTC+1', '+01:00', 'Europe/', 'Europe/Oslo:bad']) {
    await denied(setDoc(eventRef(ALICE, randomUUID()), { ...event, timeZone }), 'invalid timezone format')
  }
  await denied(setDoc(eventRef(ALICE, 'bad-id'), event), 'activity UUID required')
  for (const data of [{ ...event, at: -1 }, { ...event, at: 0.5 }, { ...event, at: 1e16 },
    { at: event.at }, { ...event, timeZone: '' }, { ...event, timeZone: 'x'.repeat(101) },
    { ...event, count: 100 }]) {
    await denied(setDoc(eventRef(ALICE, randomUUID()), data), 'invalid activity shape')
  }


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
  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings()))
  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ wordTypes: [] })))
  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ wordTypes: ['verb', 'noun'] })))
  await assertSucceeds(setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ wordTypes: ['noun', 'verb', 'adj'] })))
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ wordTypes: ['adverb'] })),
    'unknown word type',
  )
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ wordTypes: ['noun', 'nope'] })),
    'mixed unknown word type',
  )
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ wordTypes: 'noun' })),
    'word type must be a list',
  )
  await denied(
    setDoc(doc(db(ALICE), 'users', ALICE, 'settings', 'current'), settings({ wordTypes: ['noun', 'noun'] })),
    'duplicate word type',
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

  const extraId = () => randomUUID()
  const extraDeckId = CUSTOM
  const extraDeck = { ownerUid: ALICE, memberUids: [ALICE] }
  // A victim need not have signed in yet. Reject the squat before provisioning.
  for (const victim of [BOB, 'x'.repeat(128), 'A'.repeat(28)]) {
    await denied(setDoc(doc(db(ALICE), 'decks', victim), extraDeck), 'squat a future personal-deck UID')
    await assertSucceeds(setDoc(doc(db(victim), 'users', victim), account(victim)))
    await assertSucceeds(setDoc(doc(db(victim), 'decks', victim), { memberUids: [victim] }))
    const personal = await assertSucceeds(getDoc(doc(db(victim), 'decks', victim)))
    assert(personal.data().memberUids.join() === victim, 'victim provisions its own private deck')
    await denied(getDoc(doc(db(ALICE), 'decks', victim)), 'attacker cannot read the victim deck')
  }
  // Even a preexisting custom UUID UID with no deck must remain protected.
  const customUid = randomUUID()
  await assertSucceeds(setDoc(doc(db(customUid), 'users', customUid), account(customUid)))
  await denied(setDoc(doc(db(ALICE), 'decks', customUid), extraDeck), 'squat an existing custom UUID account')
  await assertSucceeds(setDoc(doc(db(customUid), 'decks', customUid), { memberUids: [customUid] }))
  // The extra-deck branch cannot replace the uid-named personal-deck shape.
  const uuidOwner = randomUUID()
  await denied(setDoc(doc(db(uuidOwner), 'decks', uuidOwner), { ownerUid: uuidOwner, memberUids: [uuidOwner] }),
    'extra-deck shape at own UUID UID')
  await assertSucceeds(setDoc(doc(db(uuidOwner), 'decks', uuidOwner), { memberUids: [uuidOwner] }))
  for (const [id, data] of [
    ['bad.id', extraDeck],
    ['alice-extra', extraDeck],
    ['x'.repeat(81), extraDeck],
    ['x'.repeat(129), extraDeck],
    ['x'.repeat(160), extraDeck],
    [CUSTOM.replace('-4', '-5'), extraDeck],
    [CUSTOM.toUpperCase(), extraDeck],
    [extraId(), { memberUids: [ALICE] }],
    [extraId(), { ...extraDeck, ownerUid: BOB }],
    [extraId(), { ...extraDeck, memberUids: [ALICE, BOB] }],
    [extraId(), { ...extraDeck, memberUids: [BOB] }],
    [extraId(), { ...extraDeck, memberUids: [] }],
    [extraId(), { ...extraDeck, memberUids: [ALICE, ALICE] }],
    [extraId(), { ...extraDeck, public: true }],
    [ALICE, extraDeck],
  ]) {
    await denied(setDoc(doc(db(ALICE), 'decks', id), data), `invalid extra deck: ${id}`)
  }
  await denied(setDoc(doc(db(null), 'decks', extraDeckId), extraDeck), 'signed-out extra-deck create')
  await assertSucceeds(setDoc(doc(db(ALICE), 'decks', extraDeckId), extraDeck))
  await assertSucceeds(setDoc(doc(db(ALICE), 'decks', randomUUID()), extraDeck))
  const extra = await assertSucceeds(getDoc(doc(db(ALICE), 'decks', extraDeckId)))
  assert(extra.data().ownerUid === ALICE && extra.data().memberUids.join() === ALICE,
    'extra deck has its creator as owner and sole member')
  await denied(getDocs(collection(db(ALICE), 'decks')), 'extra-deck owner cannot list decks')
  await denied(updateDoc(doc(db(ALICE), 'decks', extraDeckId), { ownerUid: BOB }), 'immutable extra-deck owner')
  for (const memberUids of [[ALICE, BOB], [BOB], []]) {
    await denied(updateDoc(doc(db(ALICE), 'decks', extraDeckId), { memberUids }), 'immutable extra-deck membership')
  }
  await denied(setDoc(doc(db(ALICE), 'decks', extraDeckId), extraDeck), 'second extra-deck write')
  await denied(deleteDoc(doc(db(ALICE), 'decks', extraDeckId)), 'extra-deck delete')
  await assertSucceeds(setDoc(doc(db(ALICE), 'decks', extraDeckId, 'cards', SEED), card()))
  await assertSucceeds(updateDoc(doc(db(ALICE), 'decks', extraDeckId, 'cards', SEED), { en: 'hound', updated_at: 3 }))
  await assertSucceeds(getDoc(doc(db(ALICE), 'decks', extraDeckId, 'cards', SEED)))
  const extraCards = await assertSucceeds(getDocs(collection(db(ALICE), 'decks', extraDeckId, 'cards')))
  assert(extraCards.size === 1, 'extra-deck owner can list cards')
  await denied(setDoc(doc(db(ALICE), 'decks', extraDeckId, 'cards', 'bad.id'), card()), 'invalid extra-deck card id')
  await denied(updateDoc(doc(db(ALICE), 'decks', extraDeckId, 'cards', SEED), { de: 'x'.repeat(201) }), 'invalid extra-deck card content')
  await denied(deleteDoc(doc(db(ALICE), 'decks', extraDeckId, 'cards', SEED)), 'extra-deck card delete')
  for (const uid of [BOB, null]) {
    const label = uid ? 'outsider' : 'signed-out'
    await denied(getDoc(doc(db(uid), 'decks', extraDeckId)), `${label} extra-deck read`)
    await denied(updateDoc(doc(db(uid), 'decks', extraDeckId), { memberUids: [ALICE, BOB] }), `${label} extra-deck membership write`)
    await denied(deleteDoc(doc(db(uid), 'decks', extraDeckId)), `${label} extra-deck delete`)
    await denied(getDoc(doc(db(uid), 'decks', extraDeckId, 'cards', SEED)), `${label} extra-deck card read`)
    await denied(getDocs(collection(db(uid), 'decks', extraDeckId, 'cards')), `${label} extra-deck card list`)
    await denied(setDoc(doc(db(uid), 'decks', extraDeckId, 'cards', CUSTOM), card()), `${label} extra-deck card create`)
    await denied(updateDoc(doc(db(uid), 'decks', extraDeckId, 'cards', SEED), { en: 'stolen' }), `${label} extra-deck card update`)
    await denied(deleteDoc(doc(db(uid), 'decks', extraDeckId, 'cards', SEED)), `${label} extra-deck card delete`)
  }

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

  for (const article of ['le', 'la', 'l_m', 'l_f', 'el', 'el_f', 'los', 'las', 'les_m', 'les_f']) {
    const path = ['decks', 'legacy', 'cards', `seed-language-${article}`]
    await assertSucceeds(setDoc(doc(db(ALICE), ...path), card({ article })))
    await denied(getDoc(doc(db(CARA), ...path)), 'language articles retain membership privacy')
  }
  await denied(setDoc(doc(db(ALICE), 'decks', 'legacy', 'cards', 'bad-article'), card({ article: 'invalid' })), 'unknown article')
  console.log('firestore rules ok')
} finally {
  await env.cleanup()
}

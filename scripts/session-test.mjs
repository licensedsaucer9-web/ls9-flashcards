import assert from 'node:assert/strict'
import { selectReviewCandidates, sessionCount } from '../src/session.ts'

const now = 1_700_000_000_000
const card = (id, due, tier = 1, tags = ['verb']) => ({
  id, de: id, en: id, article: 'none', tags, tier,
  example_de: '', example_en: '', created_at: 0, updated_at: 0,
  srs: { ease: 2.5, interval: 4, reps: 3, due },
})
const future = [
  card('later', now + 300), card('soonest', now + 100), card('next', now + 200),
  card('outside-tier', now - 100, 2), card('outside-type', now - 100, 1, ['noun']),
]
const original = structuredClone(future)
const ahead = selectReviewCandidates(future, 1, ['verb'], now)
assert.equal(ahead.dueCount, 0, 'review-ahead candidates are not counted as due')
assert.deepEqual(ahead.cards.map((c) => c.id), ['soonest', 'next', 'later'],
  'caught-up sessions choose soonest due first and respect tier/type scope')
assert.deepEqual(ahead.cards.slice(0, sessionCount(ahead.cards.length, 2)).map((c) => c.id), ['soonest', 'next'])
assert.equal(sessionCount(ahead.cards.length, 0), 3, 'All includes every future candidate')
assert.equal(sessionCount(ahead.cards.length, 20), 3, 'a cap cannot pad a short queue')
assert.deepEqual(future, original, 'selection must not reorder cards or reschedule them')

const due = selectReviewCandidates([...future, card('due-now', now), card('overdue', now - 1)], 1, ['verb'], now)
assert.equal(due.dueCount, 2)
assert.deepEqual(due.cards.map((c) => c.id), ['overdue', 'due-now'],
  'the due boundary is inclusive and future cards never pad a due session')
assert.equal(sessionCount(due.cards.length, 0), 2, 'All is still due-only when due cards exist')

assert.deepEqual(selectReviewCandidates([card('untyped', now + 1, 1, []), card('noun', now + 2, 1, ['noun'])], 1, [], now).cards.map((c) => c.id), ['untyped', 'noun'],
  'All word types includes untyped cards in a caught-up session')
assert.equal(selectReviewCandidates([card('both', now + 1, 1, ['noun', 'verb'])], 1, ['noun', 'verb'], now).cards.length, 1,
  'a card matching multiple types appears once')
assert.equal(selectReviewCandidates([card('lower', now + 1, 1), card('upper', now + 2, 2)], 2, [], now).cards.length, 2,
  'higher tiers remain cumulative for future cards too')
assert.equal(selectReviewCandidates([card('outside', now + 1, 3)], 1, [], now).cards.length, 0)
assert.equal(selectReviewCandidates(future, 1, ['adj'], now).cards.length, 0, 'no matching word type is an empty queue')
assert.deepEqual(selectReviewCandidates([], 3, [], now), { cards: [], dueCount: 0 })
assert.equal(sessionCount(0, 0), 0)
assert.deepEqual(selectReviewCandidates([card('z', now + 1), card('a', now + 1)], 1, [], now).cards.map((c) => c.id), ['a', 'z'],
  'equal timestamps keep the existing German-word tie-break')

console.log('session-test: due-only and earliest-due fallback, tier/type scope, caps, All, empty, immutability: ok')

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalReviewTimeZone, deviceTimeZone, REVIEW_TIME_ZONE_PATTERN, validReviewEvent, filterReviewEvents, calculateStreak, calendarDay, mergeReviewActivity, parseReviewActivity, streakLabel, streakTimeZone } from '../src/streak.ts'
import { filesToDocs, docsToFiles } from '../src/firestore-docs.ts'
import { parseUserFile } from '../src/merge.ts'
import { emptyPending, listPushItems, hasDirty, applyAck } from '../src/record-sync.ts'

const time = (day) => Date.parse(`2026-10-${String(day).padStart(2, '0')}T12:00:00Z`)
const reviews = (day, count, zone = 'Europe/Oslo') => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  [randomUUID(), { at: time(day) + i, timeZone: zone }]))
const status = (activity, day) => calculateStreak(activity, time(day) + 10000)
assert.deepEqual(status({}, 5), { state: 'off', today: 0, days: 0, repair: 0, timeZone: deviceTimeZone() })
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
assert.equal(rules.match(/timeZone\.matches\('([^']+)'\)/)?.[1], REVIEW_TIME_ZONE_PATTERN, 'client and rules use the same timezone pattern')
for (const [raw, canonical] of [['+00:00', 'UTC'], ['-00:00', 'UTC'], ['GMT', 'UTC'], ['UTC', 'UTC'],
  ['+01:00', 'Etc/GMT-1'], ['-05:00', 'Etc/GMT+5'], ['+14:00', 'Etc/GMT-14'],
  ['Europe/Oslo', 'Europe/Oslo'], ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires']]) {
  assert.equal(canonicalReviewTimeZone(raw), canonical)
  assert.equal(streakTimeZone({}, raw), canonical, 'canonicalized before the first event freezes the zone')
  assert.equal(validReviewEvent(randomUUID(), { at: time(1), timeZone: canonical }), true)
  assert.equal(calendarDay(Date.parse('2026-10-01T23:30:00Z'), canonical), calendarDay(Date.parse('2026-10-01T23:30:00Z'), raw), 'canonicalization preserves calendar boundaries')
}
for (const zone of ['GMT', '+00:00', '+01:00', '-05:00', 'Factory', 'UTC+1', 'Europe/', 'Europe/Oslo:bad']) {
  assert.equal(validReviewEvent(randomUUID(), { at: time(1), timeZone: zone }), false, 'Intl acceptance alone is insufficient')
}
for (const zone of ['+05:30', '+25:00', 'Not/AZone']) {
  assert.throws(() => canonicalReviewTimeZone(zone), undefined, 'unsupported zones must not silently change to UTC')
}
for (const count of [9, 10, 11]) {
  const state = status(reviews(1, count), 1)
  assert.equal(state.state, count < 10 ? 'off' : 'on')
  assert.equal(state.days, count < 10 ? 0 : 1)
  assert.equal(state.today, Math.min(10, count))
}
assert.equal(status(reviews(1, 9), 9).repair, 0, 'no debt before activation')
const start = reviews(1, 10)
assert.equal(status(start, 2).state, 'off', 'today has not ended')
assert.equal(status(start, 2).days, 1)
assert.equal(status(start, 4).repair, 20)
assert.equal(status({ ...start, ...reviews(4, 30) }, 4).days, 4)
assert.equal(status({ ...start, ...reviews(4, 30) }, 4).state, 'on')
assert.equal(status({ ...start, ...reviews(2, 7) }, 3).repair, 3)
assert.equal(status({ ...start, ...reviews(2, 7), ...reviews(3, 13) }, 3).state, 'on')
const partial = { ...start, ...reviews(4, 15) }
assert.equal(status(partial, 4).repair, 15)
assert.equal(status({ ...partial, ...reviews(5, 15) }, 5).repair, 10)
assert.equal(status({ ...start, ...reviews(4, 6) }, 5).repair, 24)
assert.equal(status(reviews(1, 100), 4).repair, 20, 'surplus is not banked for future days')
assert.equal(status({ ...start, ...reviews(4, 29) }, 4).repair, 1)
assert.match(streakLabel(status({ ...start, ...reviews(4, 29) }, 4)), /💀 1 review to repair · 10\/10 today/)
assert.match(streakLabel(status(start, 2)), /🌙 1-day streak · 0\/10 today/)
assert.match(streakLabel(status(start, 1)), /🔥 1-day streak/)

// Local-midnight boundaries and both Oslo DST transitions.
assert.equal(calendarDay(Date.parse('2026-03-29T22:00:00Z'), 'Europe/Oslo') - calendarDay(Date.parse('2026-03-28T23:00:00Z'), 'Europe/Oslo'), 1)
assert.equal(calendarDay(Date.parse('2026-10-25T23:00:00Z'), 'Europe/Oslo') - calendarDay(Date.parse('2026-10-24T22:00:00Z'), 'Europe/Oslo'), 1)
const midnight = Object.fromEntries(Array.from({ length: 10 }, () => [randomUUID(), { at: Date.parse('2026-10-01T21:59:59Z'), timeZone: 'Europe/Oslo' }]))
assert.equal(calculateStreak(midnight, Date.parse('2026-10-01T22:00:00Z')).state, 'off')
assert.equal(calculateStreak(midnight, Date.parse('2026-10-02T22:00:00Z')).repair, 10)
assert.equal(status(reviews(7, 10), 6).today, 0, 'future-dated activity is not counted early')

// Concurrent devices contribute a union, and retries/copies are idempotent.
const left = reviews(1, 6), right = reviews(1, 4)
const merged = mergeReviewActivity(left, right)
assert.equal(status(merged, 1).state, 'on')
assert.deepEqual(mergeReviewActivity(merged, left), merged)
assert.deepEqual(mergeReviewActivity(left, right), mergeReviewActivity(right, left))
const [id, event] = Object.entries(left)[0]
assert.throws(() => mergeReviewActivity(left, { [id]: { ...event, at: event.at + 1 } }), /Conflicting/)
assert.throws(() => parseReviewActivity({ invalid: event }), /Invalid/)
assert.throws(() => parseReviewActivity({ [id]: { ...event, timeZone: 'Not/AZone' } }), /Invalid/)
assert.throws(() => parseReviewActivity({ [id]: { ...event, extra: true } }), /Invalid/)
assert.equal(streakTimeZone({ ...reviews(2, 10, 'America/New_York'), ...start }), 'Europe/Oslo', 'travel preserves the first study zone')
const tie = {
  '00000000-0000-4000-8000-000000000002': { at: time(1), timeZone: 'UTC' },
  '00000000-0000-4000-8000-000000000001': { at: time(1), timeZone: 'Europe/Oslo' },
}
assert.equal(streakTimeZone(tie), 'Europe/Oslo', 'concurrent first studies converge with a deterministic tie-break')

const file = { version: 2, kind: 'user', user: 'test', updated_at: 0,
  settings: { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: [] }, progress: {}, activity: merged }
const deck = { version: 2, kind: 'deck', cards: [], deleted_ids: {}, updated_at: 0 }
assert.deepEqual(parseUserFile(file).activity, merged)
assert.deepEqual(docsToFiles(filesToDocs(deck, file), 'test', 0).user.activity, merged)
const pending = { ...emptyPending(), activity: { [id]: { revision: 2, acked: 0 } } }
assert.equal(hasDirty(pending), true)
assert.deepEqual(listPushItems(pending), [{ kind: 'activity', id, revision: 2 }])
pending.activity[id] = applyAck(pending.activity[id], 2)
assert.equal(hasDirty(pending), false)
console.log('streak: daily targets, partial repair, no banking, midnight/DST, immutable merge, time zone, serialization and pending credit: ok')

const goodId = randomUUID()
const filtered = filterReviewEvents([
  { id: goodId, data: { at: time(1), timeZone: 'Europe/Oslo' } },
  ...['Not/AZone', 'UTC+1'].map(timeZone => ({ id: randomUUID(), data: { at: time(1), timeZone } })),
  { id: 'bad-id', data: { at: time(1), timeZone: 'UTC' } },
  { id: randomUUID(), data: { at: -1, timeZone: 'UTC' } },
])
assert.equal(filtered.skipped, 4)
assert.deepEqual(filtered.activity, [{ id: goodId, data: { at: time(1), timeZone: 'Europe/Oslo' } }])

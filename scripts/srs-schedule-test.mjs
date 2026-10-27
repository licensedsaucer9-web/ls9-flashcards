// Scheduler progression (#132): Easy streaks grow multiplicatively to the ceiling, Good/Hard grow
// less, lapses keep part of the interval, and stored schedules from older builds carry on as is.
import assert from 'node:assert/strict'
import { MAX_EASE, MAX_INTERVAL_DAYS } from '../src/limits.ts'
import { MAX_SCHEDULE_DAYS, newSrs, review } from '../src/srs.ts'

const day = 86400000
const t0 = 1_700_000_000_000
const onTime = (srs, grade) => review(srs, grade, srs.due)

// 1. Consecutive Easy grades: every interval longer than the last, growing by at least the
// Easy bonus, until the practical ceiling, where it then stays.
let srs = newSrs(t0)
const easy = []
while (easy.at(-1) !== MAX_SCHEDULE_DAYS) {
  srs = onTime(srs, 'easy')
  easy.push(srs.interval)
  assert.ok(easy.length < 20, `Easy streak never reached the ceiling: ${easy}`)
}
assert.deepEqual(easy.slice(0, 2), [4, 15], 'first Easy is 4 days and the next grows from it')
for (let i = 1; i < easy.length; i++) {
  assert.ok(easy[i] > easy[i - 1], `Easy ${i + 1} (${easy[i]}) must exceed Easy ${i} (${easy[i - 1]})`)
  if (easy[i] < MAX_SCHEDULE_DAYS) assert.ok(easy[i] >= easy[i - 1] * 1.3 * 2.5, `Easy ${i + 1} grows multiplicatively: ${easy}`)
}
srs = onTime(srs, 'easy')
assert.equal(srs.interval, MAX_SCHEDULE_DAYS, 'Easy at the ceiling holds it')
assert.ok(srs.ease <= MAX_EASE)

// 2. Consecutive Good grades also keep increasing, more slowly than Easy.
srs = newSrs(t0)
const good = []
for (let i = 0; i < 12; i++) good.push((srs = onTime(srs, 'good')).interval)
assert.deepEqual(good.slice(0, 3), [1, 6, 15], 'Good keeps the SM-2 ladder: 1, 6, then interval × ease')
for (let i = 1; i < good.length; i++) assert.ok(good[i] > good[i - 1] || good[i] === MAX_SCHEDULE_DAYS, `Good grows: ${good}`)
for (let i = 1; i < 4; i++) assert.ok(easy[i] > good[i], `Easy outgrows Good at step ${i + 1}`)

// 3. From the same state Easy > Good > Hard ≥ the current interval > Wrong gender > Again.
for (const state of [
  { ease: 2.5, interval: 1, reps: 1 },
  { ease: 2.5, interval: 6, reps: 2 },
  { ease: 1.3, interval: 10, reps: 4 },
  { ease: 3.4, interval: 120, reps: 7 },
  { ease: 2.1, interval: 900, reps: 12 },
]) {
  const s = { ...state, due: t0 }
  const [a, g, h, gd, e] = ['again', 'wrong_gender', 'hard', 'good', 'easy'].map(grade => review(s, grade, t0))
  const label = JSON.stringify(state)
  assert.ok(e.interval > gd.interval, `Easy > Good ${label}`)
  assert.ok(gd.interval > h.interval, `Good > Hard ${label}`)
  assert.ok(h.interval >= s.interval && h.interval <= Math.round(s.interval * 1.2) + 1, `Hard holds or grows slightly ${label}`)
  assert.ok(g.interval < s.interval && g.interval >= a.interval, `Wrong gender shrinks, milder than Again ${label}`)
  assert.ok(a.interval < s.interval, `Again shrinks ${label}`)
  for (const lapse of [a, g]) assert.ok(lapse.reps === 0 && lapse.due === t0, `a lapse requeues now ${label}`)
  assert.ok(g.ease > a.ease && a.ease < s.ease || a.ease === 1.3, `lapses lower ease ${label}`)
  assert.ok(h.ease < s.ease || h.ease === 1.3, `Hard lowers ease ${label}`)
}

// 4. A lapse after a long Easy streak keeps a quarter of the interval; Good resumes from there
// and growth starts again, instead of climbing back from one day.
srs = { ease: 3.4, interval: 600, reps: 6, due: t0 }
const lapsed = review(srs, 'again', t0)
assert.deepEqual({ ...lapsed, ease: +lapsed.ease.toFixed(2) }, { ease: 3.2, interval: 150, reps: 0, due: t0 })
const relearnHard = review(lapsed, 'hard', t0 + 60_000)
assert.equal(relearnHard.interval, 75, 'Hard while relearning halves the kept interval')
let relearned = review(lapsed, 'good', t0 + 60_000)
assert.equal(relearned.interval, 150, 'Good while relearning resumes the kept interval')
assert.equal(relearned.reps, 1)
relearned = onTime(relearned, 'good')
assert.equal(relearned.interval, Math.round(150 * lapsed.ease), 'the next Good grows from there')
assert.equal(review(lapsed, 'easy', t0 + 60_000).interval, Math.round(150 * 1.3), 'Easy while relearning adds the bonus')
// Repeated lapses wear the kept interval down to zero, a fresh start.
let worn = srs
for (let i = 0; i < 6; i++) worn = review(worn, 'again', t0)
assert.equal(worn.interval, 0)
assert.equal(review(worn, 'good', t0).interval, 1)
const genderSlip = review(srs, 'wrong_gender', t0)
assert.equal(genderSlip.interval, 300, 'a gender slip keeps half the interval')

// 5. Reviewing early never lengthens an interval, for any passing grade.
for (const grade of ['hard', 'good', 'easy']) {
  const s = { ease: 2.5, interval: 30, reps: 4, due: t0 + 10 * day }
  const r = review(s, grade, t0)
  assert.ok(r.interval <= 30, `early ${grade} does not lengthen`)
  assert.equal(r.due, t0 + r.interval * day)
}
// A requeued lapse is due now, so reviewing it later in the session is not early.
assert.equal(review({ ease: 2.5, interval: 30, reps: 0, due: t0 }, 'good', t0 + 1000).interval, 30)

// 6. Caps: an interval stored past the ceiling (by an older build) is held, not shortened, by a
// passing grade; one past the server cap is clamped to it.
assert.equal(review({ ease: 2.5, interval: 5000, reps: 9, due: t0 }, 'easy', t0).interval, 5000)
assert.equal(review({ ease: 2.5, interval: 5000, reps: 9, due: t0 }, 'hard', t0).interval, 5000)
assert.equal(review({ ease: 2.5, interval: 3000, reps: 9, due: t0 }, 'good', t0).interval, MAX_SCHEDULE_DAYS)
const over = review({ ease: 12, interval: 90000, reps: 9, due: t0 }, 'easy', t0)
assert.deepEqual([over.interval, over.ease], [MAX_INTERVAL_DAYS, MAX_EASE])

// 7. Real-looking states written by the previous scheduler. The stored fields are unchanged, so
// none becomes due early and the next on-time Good continues from its interval.
const old = [
  { ease: 2.5, interval: 0, reps: 0, due: t0 - 3 * day }, // new, never studied
  { ease: 2.3, interval: 0, reps: 0, due: t0 - day }, // old-build Again: reset to zero
  { ease: 2.35, interval: 1, reps: 1, due: t0 + day }, // first Hard
  { ease: 2.5, interval: 6, reps: 2, due: t0 + 6 * day }, // Good, Good
  { ease: 2.65, interval: 4, reps: 1, due: t0 + 2 * day }, // first Easy
  { ease: 2.8, interval: 8, reps: 2, due: t0 + 8 * day }, // Easy, Easy
  { ease: 2.95, interval: 31, reps: 3, due: t0 + 20 * day },
  { ease: 1.3, interval: 14, reps: 9, due: t0 + 5 * day }, // ease floor after many Hard
  { ease: 3.4, interval: 2334, reps: 7, due: t0 + 900 * day },
  { ease: 10, interval: 36500, reps: 30, due: t0 + 36000 * day }, // saturated by the old caps
]
for (const s of old) {
  const label = JSON.stringify(s)
  if (s.interval > 0) assert.ok(s.due > t0, `fixture is not due yet ${label}`)
  const g = onTime(s, 'good')
  assert.ok(g.interval >= Math.max(1, s.interval), `on-time Good keeps progress ${label}`)
  assert.ok(g.interval <= Math.max(6, Math.round(s.interval * s.ease) + 1), `on-time Good is not a sharp jump ${label}`)
  assert.ok(review(s, 'good', t0).interval <= Math.max(1, s.interval), `early Good does not lengthen ${label}`)
  assert.ok(g.interval <= MAX_INTERVAL_DAYS && g.ease <= MAX_EASE)
}

// 8. A long simulated history of mixed grades stays within the server's limits, keeps due in
// step with interval (lapses requeue now), and keeps the Easy > Good > Hard order at every step.
let seed = 132
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
const grades = ['again', 'wrong_gender', 'hard', 'good', 'good', 'good', 'easy', 'easy']
for (let card = 0; card < 50; card++) {
  srs = newSrs(t0)
  let now = t0
  for (let i = 0; i < 400; i++) {
    now = random() < 0.2 ? Math.max(now, srs.due - day) : Math.max(now, srs.due) + Math.floor(random() * 3 * day)
    const peek = ['hard', 'good', 'easy'].map(grade => review(srs, grade, now).interval)
    if (now >= srs.due) assert.ok(peek[0] <= peek[1] && peek[1] <= peek[2], `order at ${JSON.stringify(srs)}`)
    const grade = grades[Math.floor(random() * grades.length)]
    srs = review(srs, grade, now)
    assert.ok(Number.isInteger(srs.interval) && srs.interval >= 0 && srs.interval <= MAX_SCHEDULE_DAYS)
    assert.ok(srs.ease >= 1.3 && srs.ease <= MAX_EASE)
    assert.ok(Number.isInteger(srs.reps) && srs.reps >= 0)
    assert.equal(srs.due, grade === 'again' || grade === 'wrong_gender' ? now : now + srs.interval * day)
  }
}

console.log(`srs-schedule-test: ok (Easy streak ${easy.join(' → ')} days)`)

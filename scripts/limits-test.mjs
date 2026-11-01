// Client limits match firestore.rules; schedules stay within them; the editor/CSV refuse what the server would reject.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { importCsv } from '../src/csv.ts'
import {
  cardContentProblem, clampSrs, MAX_EASE, MAX_EXAMPLE_LENGTH, MAX_INTERVAL_DAYS, MAX_RANK, MAX_REPS, MAX_SESSION_SIZE, MAX_TAGS, MAX_TERM_LENGTH,
} from '../src/limits.ts'
import { MAX_SCHEDULE_DAYS, newSrs, review } from '../src/srs.ts'
import { feedbackFields, feedbackProblem, MAX_FEEDBACK_APP_VERSION, MAX_FEEDBACK_EMAIL, MAX_FEEDBACK_MESSAGE } from '../src/feedback.ts'

// 1. The constants are the rules' numbers, so they cannot drift apart unnoticed.
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
const number = pattern => Number(rules.match(pattern)?.[1])
assert.equal(number(/text\(data\.de, (\d+)\)/), MAX_TERM_LENGTH)
assert.equal(number(/text\(data\.en, (\d+)\)/), MAX_TERM_LENGTH)
assert.equal(number(/text\(data\.example_de, (\d+)\)/), MAX_EXAMPLE_LENGTH)
assert.equal(number(/text\(data\.example_en, (\d+)\)/), MAX_EXAMPLE_LENGTH)
assert.equal(number(/tags\.size\(\) <= (\d+)/), MAX_TAGS)
assert.equal(number(/interval <= (\d+)/), MAX_INTERVAL_DAYS)
assert.equal(number(/ease <= (\d+)/), MAX_EASE)
assert.equal(number(/reps <= (\d+)/), MAX_REPS)
assert.equal(number(/rank <= (\d+)/), MAX_RANK)
assert.equal(number(/sessionSize <= (\d+)/), MAX_SESSION_SIZE)
assert.equal(number(/text\(data\.message, (\d+)\)/), MAX_FEEDBACK_MESSAGE)
assert.equal(number(/text\(data\.email, (\d+)\)/), MAX_FEEDBACK_EMAIL)
assert.equal(number(/text\(data\.appVersion, (\d+)\)/), MAX_FEEDBACK_APP_VERSION)

// 2. Schedules: grading never leaves the caps, even from a stored schedule already past them, and
// reviewing ahead of schedule never lengthens an interval.
const day = 86400000
let srs = { ...newSrs(0), reps: 3, interval: 400, ease: 2.5 }
for (let i = 0; i < 60; i++) srs = review(srs, 'easy', srs.due - day) // always early: nothing is due
assert.ok(srs.interval <= MAX_INTERVAL_DAYS && srs.ease <= MAX_EASE, 'early Easy grades stay within the caps')
assert.equal(srs.interval, 400, 'reviewing ahead never lengthens the interval')
srs = { ...newSrs(0), reps: 3, interval: 400, ease: 2.5 }
for (let i = 0; i < 60; i++) srs = review(srs, 'easy', srs.due) // always on time
assert.equal(srs.interval, MAX_SCHEDULE_DAYS, 'on-time Easy grades saturate at the practical ceiling, below the cap')
assert.ok(MAX_SCHEDULE_DAYS <= MAX_INTERVAL_DAYS)
assert.equal(srs.ease, MAX_EASE, 'ease saturates at the cap')
const legacy = review({ ease: 11.2, interval: 51809, reps: 9, due: 0 }, 'good', 1)
assert.ok(legacy.interval <= MAX_INTERVAL_DAYS && legacy.ease <= MAX_EASE, 'a schedule already past the caps is repaired by the next review')
assert.deepEqual(clampSrs({ ease: 2.5, interval: 5, reps: 1, due: 9 }), { ease: 2.5, interval: 5, reps: 1, due: 9 }, 'valid schedules are untouched')
assert.deepEqual(clampSrs({ ease: 99, interval: 1e9, reps: 1, due: 9 }), { ease: MAX_EASE, interval: MAX_INTERVAL_DAYS, reps: 1, due: 9 })
// Hard mode: a card missed twice comes back now (Again), not later (Hard lengthens a learned card's interval).
const missed = review({ ease: 2.5, interval: 100, reps: 5, due: 0 }, 'again', 1)
assert.ok(missed.due === 1 && missed.interval < 100, 'Again is due now and shortens the interval')
assert.ok(review({ ease: 2.5, interval: 100, reps: 5, due: 0 }, 'hard', 1).interval > 100, 'the old second-miss grade lengthened it')

// 3. Content limits.
const card = { de: 'Hund', en: 'dog', example_de: '', example_en: '', tags: [] }
assert.equal(cardContentProblem(card), null)
assert.equal(cardContentProblem({ ...card, de: 'd'.repeat(MAX_TERM_LENGTH) }), null, 'exactly at the limit is fine')
assert.match(cardContentProblem({ ...card, de: 'd'.repeat(MAX_TERM_LENGTH + 1) }), /first word.*200/)
assert.match(cardContentProblem({ ...card, en: 'e'.repeat(MAX_TERM_LENGTH + 1) }), /translation.*200/)
assert.match(cardContentProblem({ ...card, example_de: 'x'.repeat(MAX_EXAMPLE_LENGTH + 1) }), /example.*1000/)
assert.match(cardContentProblem({ ...card, tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`) }), /more than 12 tags/)

// 4. CSV import reports the line instead of creating a card that can never sync.
const long = 'x'.repeat(MAX_TERM_LENGTH + 1)
const result = importCsv(`front,back,example_de\nhund,dog,ok\n${long},dog,ok\nkatze,cat,${'y'.repeat(MAX_EXAMPLE_LENGTH + 1)}\nvogel,bird,ok`, [], 1000)
assert.deepEqual(result.imported.map(item => item.de), ['hund', 'vogel'], 'only rows within the limits import')
assert.equal(result.errors.length, 2)
assert.match(result.errors[0], /^Line 3: the first word or phrase is over 200 characters$/)
assert.match(result.errors[1], /^Line 4: an example is over 1000 characters$/)
// 5. Feedback: what the form allows is what the rules accept, measured after trimming.
assert.match(feedbackProblem('', ''), /Write a message/)
assert.match(feedbackProblem('   \n ', ''), /Write a message/, 'whitespace only is empty')
assert.equal(feedbackProblem(`  ${'m'.repeat(MAX_FEEDBACK_MESSAGE)}  `, ''), null, 'exactly at the limit after trimming is fine')
assert.match(feedbackProblem('m'.repeat(MAX_FEEDBACK_MESSAGE + 1), ''), /over 2000/)
assert.equal(feedbackProblem('Hi', ' me@example.com '), null)
for (const bad of ['me', 'me@', 'me@example', 'me @example.com', 'a@b@c.d']) assert.match(feedbackProblem('Hi', bad), /valid email/, bad)
assert.match(feedbackProblem('Hi', `${'e'.repeat(MAX_FEEDBACK_EMAIL)}@example.com`), /email is over 254/)
assert.deepEqual(feedbackFields({ message: ' Hi ', email: '  ', appVersion: '1.5.0' }, null), { message: 'Hi', appVersion: '1.5.0' }, 'blank email and signed-out uid are omitted')
assert.deepEqual(feedbackFields({ message: 'Hi', email: ' me@example.com ', appVersion: '1.5.0', includeAccount: true }, 'u1'), { message: 'Hi', email: 'me@example.com', appVersion: '1.5.0', uid: 'u1' })
console.log('limits: match the rules; schedules stay capped and early reviews do not lengthen; editor/CSV and feedback limits: ok')

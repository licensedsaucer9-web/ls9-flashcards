// A slow feedback write is waited for, not abandoned: a timeout must not report "not sent"
// while the queued addDoc still arrives later (and a retry would duplicate it).
import assert from 'node:assert/strict'
import { settleFeedbackWrite } from '../src/cloud-feedback.ts'
import { feedbackFields } from '../src/feedback.ts'

const later = (ms, fn) => new Promise((resolve, reject) => setTimeout(() => fn(resolve, reject), ms))

// Succeeds after the slow mark: onWaiting fires once, the result is still the real success.
let waiting = 0
let result = await settleFeedbackWrite(later(60, resolve => resolve()), () => { waiting++ }, 10)
assert.deepEqual(result, { ok: true }, 'a late success is reported as sent')
assert.equal(waiting, 1, 'the slow notice fires once')

// Fails after the slow mark: the late failure is reported, not dropped.
waiting = 0
result = await settleFeedbackWrite(later(60, (_, reject) => reject(Object.assign(new Error('no'), { code: 'permission-denied' }))), () => { waiting++ }, 10)
assert.equal(result.ok, false)
assert.match(result.message, /refused/)
assert.equal(waiting, 1)
result = await settleFeedbackWrite(later(30, (_, reject) => reject(new Error('unavailable'))), undefined, 10)
assert.match(result.message, /Could not send/)

// A quick write never shows the slow notice, and its timer does not outlive it.
waiting = 0
result = await settleFeedbackWrite(Promise.resolve(), () => { waiting++ }, 20)
assert.deepEqual(result, { ok: true })
await later(40, resolve => resolve())
assert.equal(waiting, 0)

// Anonymous by default: a signed-in uid is stored only when the user ticked the box.
const input = { message: ' Hi ', email: '', appVersion: '1.5.0' }
assert.deepEqual(feedbackFields(input, 'alice'), { message: 'Hi', appVersion: '1.5.0' }, 'no box, no uid')
assert.deepEqual(feedbackFields({ ...input, includeAccount: false }, 'alice'), { message: 'Hi', appVersion: '1.5.0' })
assert.deepEqual(feedbackFields({ ...input, includeAccount: true }, 'alice'), { message: 'Hi', appVersion: '1.5.0', uid: 'alice' }, 'ticked box stores the uid')
assert.deepEqual(feedbackFields({ ...input, includeAccount: true }, null), { message: 'Hi', appVersion: '1.5.0' }, 'signed out never stores a uid')

console.log('feedback send: uid only when opted in; slow writes are awaited, late success and late failure are both reported: ok')

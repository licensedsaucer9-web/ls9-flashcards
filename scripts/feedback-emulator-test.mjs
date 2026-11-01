// Feedback rules and the client write against the emulator. Run via `npm run test:rules`, not `npm test`.
import { readFileSync } from 'node:fs'
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore'
import { writeFeedback } from '../src/cloud-feedback.ts'
import { MAX_FEEDBACK_EMAIL, MAX_FEEDBACK_MESSAGE } from '../src/feedback.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function denied(promise, label) {
  const err = await assertFails(promise)
  assert(/permission-denied/.test(String(err?.code || err?.message || err)), `${label}: expected permission-denied, got ${err?.code || err}`)
}

const env = await initializeTestEnvironment({
  projectId: 'demo-german-flashcards',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
})

function db(uid) {
  return (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore()
}

function entry(over = {}) {
  const data = { message: 'Love the app', createdAt: serverTimestamp(), appVersion: '1.5.0', ...over }
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key]
  return data
}

async function stored() {
  let docs = []
  await env.withSecurityRulesDisabled(async ctx => {
    docs = (await getDocs(collection(ctx.firestore(), 'feedback'))).docs.map(d => ({ id: d.id, ...d.data() }))
  })
  return docs
}

try {
  await env.clearFirestore()
  const feedback = uid => collection(db(uid), 'feedback')

  // Valid creates: anonymous, signed in with and without uid, optional email, limits exactly reached.
  await assertSucceeds(addDoc(feedback(null), entry()))
  await assertSucceeds(addDoc(feedback('alice'), entry({ uid: 'alice', email: 'alice@example.com' })))
  await assertSucceeds(addDoc(feedback('alice'), entry()))
  await assertSucceeds(addDoc(feedback(null), entry({ message: 'm'.repeat(MAX_FEEDBACK_MESSAGE), email: `${'e'.repeat(MAX_FEEDBACK_EMAIL - 12)}@example.com` })))

  // The app's own write path: signed out, signed in without the box (anonymous), and opted in.
  await assertSucceeds(writeFeedback(db(null), null, { message: '  From the app  ', email: ' ', appVersion: '1.5.0' }))
  await assertSucceeds(writeFeedback(db('bob'), 'bob', { message: 'Signed in, anonymous', email: '', appVersion: '1.5.0', includeAccount: false }))
  await assertSucceeds(writeFeedback(db('bob'), 'bob', { message: 'Signed in', email: 'bob@example.com', appVersion: '1.5.0', includeAccount: true }))
  const docs = await stored()
  assert(docs.length === 7, `expected 7 feedback docs, got ${docs.length}`)
  const app = docs.find(d => d.message === 'From the app')
  assert(app && !('email' in app) && !('uid' in app) && app.appVersion === '1.5.0' && app.createdAt instanceof Timestamp, 'signed-out app write is trimmed, omits email/uid and has a server time')
  const quiet = docs.find(d => d.message === 'Signed in, anonymous')
  assert(quiet && !('uid' in quiet) && !('email' in quiet), 'signed-in app write without the box omits uid')
  const bob = docs.find(d => d.message === 'Signed in')
  assert(bob?.uid === 'bob' && bob.email === 'bob@example.com', 'opted-in app write carries uid and email')

  // Denied shapes.
  await denied(addDoc(feedback(null), entry({ message: 'm'.repeat(MAX_FEEDBACK_MESSAGE + 1) })), 'oversized message')
  await denied(addDoc(feedback(null), entry({ message: '' })), 'empty message')
  await denied(addDoc(feedback(null), entry({ message: '   ' })), 'blank message')
  await denied(addDoc(feedback(null), entry({ message: 42 })), 'non-string message')
  await denied(addDoc(feedback(null), entry({ email: `${'e'.repeat(MAX_FEEDBACK_EMAIL)}@example.com` })), 'oversized email')
  await denied(addDoc(feedback(null), entry({ email: 'not an email' })), 'malformed email')
  await denied(addDoc(feedback(null), entry({ email: '' })), 'empty email instead of omitted')
  await denied(addDoc(feedback(null), entry({ appVersion: 'v'.repeat(101) })), 'oversized appVersion')
  await denied(addDoc(feedback(null), entry({ appVersion: undefined })), 'missing appVersion')
  await denied(addDoc(feedback(null), entry({ extra: true })), 'extra field')
  await denied(addDoc(feedback(null), entry({ createdAt: Timestamp.fromMillis(Date.now()) })), 'client-chosen createdAt')
  await denied(addDoc(feedback(null), entry({ createdAt: undefined })), 'missing createdAt')
  await denied(addDoc(feedback(null), entry({ uid: 'alice' })), 'anonymous with a uid')
  await denied(addDoc(feedback('alice'), entry({ uid: 'bob' })), 'wrong uid')
  await denied(writeFeedback(db('alice'), 'bob', { message: 'Spoof', email: '', appVersion: '1.5.0', includeAccount: true }), 'app write with wrong uid')

  // Nobody reads, changes or deletes feedback from a client, including its author.
  const [first] = await stored()
  const ref = uid => doc(db(uid), 'feedback', first.id)
  for (const uid of [null, 'alice', 'bob']) {
    await denied(getDoc(ref(uid)), `read by ${uid ?? 'anonymous'}`)
    await denied(getDocs(feedback(uid)), `list by ${uid ?? 'anonymous'}`)
    await denied(updateDoc(ref(uid), { message: 'edited' }), `update by ${uid ?? 'anonymous'}`)
    await denied(setDoc(ref(uid), entry()), `overwrite by ${uid ?? 'anonymous'}`)
    await denied(deleteDoc(ref(uid)), `delete by ${uid ?? 'anonymous'}`)
  }
  assert((await stored()).length === 7, 'denied writes stored nothing')
  console.log('feedback rules: create-only with exact shape, anonymous, signed-in with and without uid, client write path: ok')
} finally {
  await env.cleanup()
}

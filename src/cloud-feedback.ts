import { getAuth } from 'firebase/auth'
import { addDoc, collection, serverTimestamp, type Firestore } from 'firebase/firestore'
import { cloudFirestore } from './cloud-handle.ts'
import { feedbackFields, feedbackProblem, type FeedbackInput, type FeedbackResult } from './feedback.ts'

const SLOW_SEND_MS = 15000

/** Create one /feedback document. Rules allow create only; nobody can read it back from the app. */
export async function writeFeedback(db: Firestore, uid: string | null, input: FeedbackInput): Promise<void> {
  await addDoc(collection(db, 'feedback'), { ...feedbackFields(input, uid), createdAt: serverTimestamp() })
}

/**
 * Wait for the write itself, however long it takes. addDoc never answers while the
 * connection is down, but the SDK keeps the write queued and sends it on reconnect,
 * so giving up early would report "not sent" for a document that still arrives and
 * invite a duplicate retry. A slow write only calls onWaiting.
 */
export async function settleFeedbackWrite(write: Promise<void>, onWaiting?: () => void, slowMs = SLOW_SEND_MS): Promise<FeedbackResult> {
  const timer = setTimeout(() => onWaiting?.(), slowMs)
  try {
    await write
    return { ok: true }
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? '')
    if (code === 'permission-denied') return { ok: false, message: 'The server refused this feedback. Shorten it or check the email and try again.' }
    return { ok: false, message: 'Could not send feedback. Check your connection and try again.' }
  } finally {
    clearTimeout(timer)
  }
}

export async function sendFeedback(input: FeedbackInput, onWaiting?: () => void): Promise<FeedbackResult> {
  const problem = feedbackProblem(input.message, input.email)
  if (problem) return { ok: false, message: problem }
  const db = cloudFirestore()
  if (!db) return { ok: false, message: 'Feedback is not available right now. Try again later.' }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, message: 'You are offline. Your message is kept here; send it when you are back online.' }
  }
  let uid: string | null = null
  try {
    uid = getAuth(db.app).currentUser?.uid ?? null
  } catch {
    uid = null
  }
  return settleFeedbackWrite(writeFeedback(db, uid, input), onWaiting)
}

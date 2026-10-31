// Settings → Send feedback. Limits match the /feedback rules in firestore.rules;
// scripts/limits-test.mjs keeps the two in step.

export const MAX_FEEDBACK_MESSAGE = 2000
export const MAX_FEEDBACK_EMAIL = 254
export const MAX_FEEDBACK_APP_VERSION = 100

// Deliberately loose: one @, no spaces, a dot in the domain. Rules check the same.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface FeedbackInput {
  readonly message: string
  readonly email: string
  readonly appVersion: string
}

export interface FeedbackFields {
  message: string
  email?: string
  appVersion: string
  uid?: string
}

export type FeedbackResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** Why the draft cannot be sent yet, or null when it can. Counts what will be sent, after trimming. */
export function feedbackProblem(message: string, email: string): string | null {
  const text = message.trim()
  if (!text) return 'Write a message first.'
  if (text.length > MAX_FEEDBACK_MESSAGE) return `The message is over ${MAX_FEEDBACK_MESSAGE} characters.`
  const address = email.trim()
  if (address.length > MAX_FEEDBACK_EMAIL) return `The email is over ${MAX_FEEDBACK_EMAIL} characters.`
  if (address && !EMAIL.test(address)) return 'Enter a valid email or leave it blank.'
  return null
}

/** The stored fields apart from createdAt, which Firestore stamps. Blank email and signed-out uid are omitted. */
export function feedbackFields(input: FeedbackInput, uid: string | null): FeedbackFields {
  const email = input.email.trim()
  return {
    message: input.message.trim(),
    ...(email ? { email } : {}),
    appVersion: input.appVersion.slice(0, MAX_FEEDBACK_APP_VERSION),
    ...(uid ? { uid } : {}),
  }
}

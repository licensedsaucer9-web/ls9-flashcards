/**
 * An installed iPhone Home Screen app opens Google with a link and keeps no
 * popup window, so a return to this page is the only cancel signal. Mobile
 * Safari backgrounds this page while the Google sheet is open; treating that
 * return as cancellation drops a sign-in that is still finishing.
 */
export function cancelPopupWhenPageReturns(standalone: boolean): boolean {
  return standalone
}

/**
 * The account row was created in this sign-in, so the server has no cards and
 * no tombstones yet. The local seed can paint before the first cloud read.
 */
export function seedBeforeFirstSync(createdPersonalDeck: boolean): boolean {
  return createdPersonalDeck
}

/**
 * A cold phone often fails the first Firestore read after the Google sheet closes.
 * An exhausted daily quota is not retried: it lasts until the reset, and each retry spends more.
 */
export function retryableDeckOpen(code: string): boolean {
  return code === 'unavailable'
    || code === 'deadline-exceeded'
    || code === 'auth/network-request-failed'
    || code.endsWith('/unavailable')
    || code.endsWith('/deadline-exceeded')
}

export function quotaCode(code: string): boolean {
  return code === 'resource-exhausted' || code.endsWith('/resource-exhausted')
}

export const QUOTA_DECK_MESSAGE = 'Daily cloud limit reached, studying offline until it resets.'

export function deckOpenFailure(code: string): string {
  if (quotaCode(code)) return QUOTA_DECK_MESSAGE
  if (code === 'auth/web-storage-unsupported' || code === 'auth/popup-blocked') {
    return 'Open this page in Safari, then choose Continue with Google.'
  }
  return `Signed in, but the deck did not open (${code}). Try again.`
}

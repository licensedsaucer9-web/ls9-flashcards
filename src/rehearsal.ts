import { bridgeStoragePrefix } from './recovery-context.ts'

/** The isolated operator preview; ordinary builds retain their existing storage. */
export const rehearsalPreview = import.meta.env?.VITE_REHEARSAL_PREVIEW === 'true'

/** Old-scope recovery build. It keeps the original database names. */
export const recoveryBridge = import.meta.env?.VITE_RECOVERY_BRIDGE === 'true'

export const storagePrefix = recoveryBridge
  ? bridgeStoragePrefix(rehearsalPreview)
  : rehearsalPreview
    ? 'german-flashcards-rehearsal'
    : 'german-flashcards'

export function rehearsalNote(): string {
  if (!rehearsalPreview) return ''
  // Revision is provided by the local build command, not by user input.
  const revision = String(import.meta.env.VITE_REHEARSAL_REVISION || '').replace(/[^a-f0-9]/g, '').slice(0, 7)
  return `<span class="note" id="rehearsal-notice">Test rehearsal · flashcards-ls9-auth-test · ${revision}</span><br>`
}

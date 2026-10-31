/**
 * A stored account document keeps the deck it already names.
 * The personal deck is created only when that document is absent.
 */
export function planAccountProvision(
  existingDeckId: string | null,
  uid: string,
): { deckId: string; createPersonal: boolean } {
  if (existingDeckId) return { deckId: existingDeckId, createPersonal: false }
  return { deckId: uid, createPersonal: true }
}

/** A completed legacy assignment. Pending, missing, and personal accounts are not. */
export function completedLegacyAssignment(data: unknown, deckId: string): boolean {
  if (!data || typeof data !== 'object') return false
  const row = data as { deckId?: unknown; schemaVersion?: unknown; migrationStatus?: unknown }
  return row.deckId === deckId && row.schemaVersion === 1 && row.migrationStatus === 'complete'
}

export function legacyAssignmentRefusal(
  data: unknown,
  deckId: string,
): { code: string; message: string } | null {
  if (completedLegacyAssignment(data, deckId)) return null
  return {
    code: 'rehearsal/import-required',
    message: 'The test account needs a verified legacy import',
  }
}

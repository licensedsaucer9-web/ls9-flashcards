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

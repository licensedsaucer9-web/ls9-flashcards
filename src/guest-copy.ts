/** Word-list edits follow a personal deck. A shared deck includes them only after a second yes. */
export function includeGuestVocabulary(personal: boolean, sharedConfirmed: boolean): boolean {
  return personal || sharedConfirmed
}

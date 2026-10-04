import { doc, getDocFromServer, runTransaction, type Firestore, type Transaction } from 'firebase/firestore'
import { planAccountProvision } from './account-plan.ts'
import { newUserAccount } from './firestore-docs.ts'

type AccountSnap = { exists(): boolean; data(): unknown }

function existingDeckId(snap: AccountSnap): string | null {
  if (!snap.exists()) return null
  const data = snap.data() as { deckId?: unknown } | undefined
  if (!data || typeof data.deckId !== 'string' || data.deckId === '') {
    throw new Error('Account is missing a deck')
  }
  return data.deckId
}

function permissionDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = String(error.code)
  return code === 'permission-denied' || code.endsWith('/permission-denied')
}

async function readOrCreate(
  db: Firestore,
  uid: string,
  createDeck: boolean,
): Promise<string> {
  const userRef = doc(db, 'users', uid)
  const deckRef = doc(db, 'decks', uid)
  return runTransaction(db, async (tx: Transaction) => {
    const existing = existingDeckId(await tx.get(userRef))
    const plan = planAccountProvision(existing, uid)
    if (!plan.createPersonal) return plan.deckId
    if (createDeck) tx.set(deckRef, { memberUids: [uid] })
    tx.set(userRef, newUserAccount(uid))
    return plan.deckId
  })
}

/**
 * Open the account document. If it is missing, create `decks/{uid}` and
 * `users/{uid}` together. If it is already there, keep its deckId — including
 * a legacy deck written ahead of this login.
 */
export async function provisionAccount(
  db: Firestore,
  uid: string,
  options: { requiredLegacyDeckId?: string } = {},
): Promise<{ deckId: string; personal: boolean }> {
  if (options.requiredLegacyDeckId) {
    // The rehearsal cannot invent a personal deck before the Admin import.
    // Read online and perform no writes, including for a restored auth session.
    const snap = await getDocFromServer(doc(db, 'users', uid))
    const data = snap.data()
    if (!snap.exists() || data?.deckId !== options.requiredLegacyDeckId || data?.schemaVersion !== 1 || data?.migrationStatus !== 'complete') {
      throw Object.assign(new Error('The test account needs a verified legacy import'), { code: 'rehearsal/import-required' })
    }
    return { deckId: data.deckId, personal: false }
  }
  try {
    const deckId = await readOrCreate(db, uid, true)
    return { deckId, personal: deckId === uid }
  } catch (error) {
    // Creating the personal deck is an update when that deck document already
    // exists, and the rules reject updates. Create the account row only.
    if (!permissionDenied(error)) throw error
    const deckId = await readOrCreate(db, uid, false)
    return { deckId, personal: deckId === uid }
  }
}

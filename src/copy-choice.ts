import { storagePrefix } from './rehearsal.ts'

const KEY = `${storagePrefix}.copy-choice`

export type CopyDecision = 'skip' | 'progress' | 'vocabulary'

type Store = Pick<Storage, 'getItem' | 'setItem'>

function isDecision(value: unknown): value is CopyDecision {
  return value === 'skip' || value === 'progress' || value === 'vocabulary'
}

function readAll(storage: Store): Record<string, Record<string, CopyDecision>> {
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, Record<string, CopyDecision>> = {}
    for (const [uid, sources] of Object.entries(parsed)) {
      if (!sources || typeof sources !== 'object' || Array.isArray(sources)) continue
      const mine: Record<string, CopyDecision> = {}
      for (const [source, decision] of Object.entries(sources)) {
        if (isDecision(decision)) mine[source] = decision
      }
      if (Object.keys(mine).length) out[uid] = mine
    }
    return out
  } catch {
    return {}
  }
}

/** This account already answered for this device database. */
export function copyAlreadyDecided(storage: Store, uid: string, source: string): boolean {
  return isDecision(readAll(storage)[uid]?.[source])
}

export function rememberCopyDecision(
  storage: Store,
  uid: string,
  source: string,
  decision: CopyDecision,
): void {
  const all = readAll(storage)
  all[uid] = { ...all[uid], [source]: decision }
  storage.setItem(KEY, JSON.stringify(all))
}

/**
 * A stored answer is not applied again. Replaying it would write the old
 * device database over the account after the session is restored.
 */
export function sessionCopyMode(alreadyDecided: boolean, chosen: CopyDecision | null): CopyDecision {
  if (alreadyDecided) return 'skip'
  return chosen ?? 'skip'
}

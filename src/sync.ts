import { captureStudyLock, studyLockCurrent, type StudyLock } from './study-lock.ts'
import type { NeedsFixing } from './record-sync.ts'
import { cloudSyncPass, cloudTransport } from './sync-backend.ts'

export type SyncStatus = {
  state: 'off' | 'idle' | 'waiting' | 'syncing' | 'ok' | 'error'
  message: string
  at: number | null
  /** Records the server refused in the last pass that reached the queue. */
  needsFixing: NeedsFixing[]
}

let status: SyncStatus = { state: 'off', message: '', at: null, needsFixing: [] }
/** The account and deck binding the needs-fixing list was built against. */
let needsFixingLock: StudyLock | null = null
let timer = 0
let activeSync: Promise<void> | null = null
let syncAgain = false
/**
 * The strongest pull a caller asked for since the last pass began: 'always' (launch, sign-in, Sync now),
 * 'foreground' (return to the app, reconnect; throttled) or 'light' (after a local change).
 */
let requested: 'light' | 'foreground' | 'always' = 'light'
const strength = { light: 0, foreground: 1, always: 2 } as const
const listeners = new Set<() => void>()

export function getSyncStatus(): SyncStatus {
  if (!cloudTransport) return { state: 'off', message: '', at: null, needsFixing: [] }
  // Sign-out or an account switch may not start a pass; never show another binding's list.
  if (status.needsFixing.length && !(needsFixingLock && studyLockCurrent(needsFixingLock))) return { ...status, needsFixing: [] }
  return status
}

export function onSyncStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch }
  for (const fn of listeners) fn()
}

export const QUOTA_MESSAGE = 'Daily cloud limit reached, studying offline until it resets'

async function syncPass(pull: 'light' | 'foreground' | 'always'): Promise<void> {
  const lock = captureStudyLock()
  if (!cloudTransport || !lock.uid) {
    setStatus({ state: 'idle', message: 'Saved on this device', at: null, needsFixing: [] })
    return
  }
  // Drop a list left over from another account or deck before this pass reports.
  setStatus({ state: 'syncing', message: 'Syncing', at: null, needsFixing: getSyncStatus().needsFixing })
  const outcome = await cloudSyncPass({
    light: pull === 'light',
    foreground: pull === 'foreground',
    requestAgain: () => {
      syncAgain = true
    },
  })
  if (!studyLockCurrent(lock)) {
    // The study database changed mid-pass (for example a deck switch); run again against the new binding.
    syncAgain = true
    setStatus({ state: 'waiting', message: 'Saved on this device', at: null })
    return
  }
  // A pass that stopped early ('pending') keeps the last list; it may not have retried those records.
  if (typeof outcome === 'object') {
    needsFixingLock = lock
    setStatus({ state: 'error', message: outcome.message, at: null, needsFixing: outcome.items })
  } else if (outcome === 'synced') setStatus({ state: 'ok', message: 'Synced', at: Date.now(), needsFixing: [] })
  else if (outcome === 'local') setStatus({ state: 'idle', message: 'On this device', at: null, needsFixing: [] })
  else if (outcome === 'quota') setStatus({ state: 'waiting', message: QUOTA_MESSAGE, at: null })
  else setStatus({ state: 'waiting', message: 'Saved on this device', at: null })
}

/** Drop one listed record once it has been dealt with locally, without waiting for a pass. */
export function forgetNeedsFixing(entry: NeedsFixing): void {
  setStatus({ needsFixing: status.needsFixing.filter((other) => other !== entry) })
}

/** All foreground triggers share one serialized pull/merge/push loop. */
export function syncNow(options: { light?: boolean; foreground?: boolean } = {}): Promise<void> {
  window.clearTimeout(timer)
  const pull = options.light ? 'light' : options.foreground ? 'foreground' : 'always'
  if (strength[pull] > strength[requested]) requested = pull
  if (activeSync) {
    syncAgain = true
    return activeSync
  }
  activeSync = (async () => {
    do {
      syncAgain = false
      const pull = requested
      requested = 'light'
      await syncPass(pull)
    } while (syncAgain)
  })().finally(() => {
    activeSync = null
  })
  return activeSync
}

/** Refresh selection status even when no cloud pass is currently running. */
export function deckSelectionChanged(syncs: boolean): void {
  // The list belongs to the previous deck; the next pass rebuilds it.
  status = { ...status, needsFixing: [] }
  if (syncs) {
    schedulePush()
  } else {
    pauseSync()
    setStatus({ state: 'idle', message: 'On this device', at: null })
  }
}

/** The data write already recorded a pending revision before this is called. */
export function schedulePush(): void {
  if (!cloudTransport) return
  setStatus({ state: 'waiting', message: 'Saved on this device', at: null })
  window.clearTimeout(timer)
  if (document.visibilityState === 'hidden') return
  timer = window.setTimeout(() => {
    void syncNow({ light: true }).catch(() => {
      /* The pending revision and status remain for the next foreground retry. */
    })
  }, 1200)
}

export function pauseSync(): void {
  window.clearTimeout(timer)
}

export async function bootSync(): Promise<void> {
  if (!cloudTransport || !captureStudyLock().uid) return
  try {
    await syncNow()
  } catch {
    /* Keep locally committed changes pending until the next foreground retry. */
  }
}

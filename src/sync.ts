import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import { cloudSyncPass, cloudTransport } from './sync-backend.ts'

export type SyncStatus = {
  state: 'off' | 'idle' | 'waiting' | 'syncing' | 'ok' | 'error'
  message: string
  at: number | null
}

let status: SyncStatus = { state: 'off', message: '', at: null }
let timer = 0
let activeSync: Promise<void> | null = null
let syncAgain = false
const listeners = new Set<() => void>()

export function getSyncStatus(): SyncStatus {
  if (!cloudTransport) return { state: 'off', message: '', at: null }
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

async function syncPass(): Promise<void> {
  const lock = captureStudyLock()
  if (!cloudTransport || !lock.uid) {
    setStatus({ state: 'idle', message: 'Saved on this device', at: null })
    return
  }
  setStatus({ state: 'syncing', message: 'Syncing', at: null })
  const outcome = await cloudSyncPass({
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
  if (typeof outcome === 'object') setStatus({ state: 'error', message: outcome.message, at: null })
  else if (outcome === 'synced') setStatus({ state: 'ok', message: 'Synced', at: Date.now() })
  else if (outcome === 'local') setStatus({ state: 'idle', message: 'On this device', at: null })
  else setStatus({ state: 'waiting', message: 'Saved on this device', at: null })
}

/** All foreground triggers share one serialized pull/merge/push loop. */
export function syncNow(): Promise<void> {
  window.clearTimeout(timer)
  if (activeSync) {
    syncAgain = true
    return activeSync
  }
  activeSync = (async () => {
    do {
      syncAgain = false
      await syncPass()
    } while (syncAgain)
  })().finally(() => {
    activeSync = null
  })
  return activeSync
}

/** Refresh selection status even when no cloud pass is currently running. */
export function deckSelectionChanged(syncs: boolean): void {
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
    void syncNow().catch(() => {
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

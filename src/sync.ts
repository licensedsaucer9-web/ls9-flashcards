import type { Snapshot } from './types.ts'
import { acknowledgeRevision, mergeRemoteIntoDb, readLocalState } from './db.ts'
import {
  fetchRemote,
  GithubError,
  isGithubConfigured,
  loadGithubConfig,
  putRemote,
  saveKnownSha,
} from './github.ts'

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
  if (!isGithubConfigured()) return { state: 'off', message: '', at: null }
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

export async function snapshotFromDb(): Promise<Snapshot> {
  return (await readLocalState()).snapshot
}

async function syncPass(): Promise<void> {
  const cfg = loadGithubConfig()
  if (!isGithubConfigured(cfg)) {
    setStatus({ state: 'off', message: '', at: null })
    return
  }
  setStatus({ state: 'syncing', message: 'Checking GitHub…' })
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await fetchRemote(cfg)
      let snapshot: Snapshot
      let includedRevision: number
      let pending: boolean
      let sha: string | null
      if (remote.kind === 'file') {
        const applied = await mergeRemoteIntoDb(remote.snapshot)
        snapshot = applied.snapshot
        includedRevision = applied.revision
        pending = applied.pending
        sha = remote.sha
        saveKnownSha(sha)
      } else {
        const local = await readLocalState()
        snapshot = local.snapshot
        includedRevision = local.settings.localRevision
        pending = includedRevision > local.settings.acknowledgedRevision
        sha = null
      }

      if (remote.kind === 'missing' && snapshot.cards.length === 0) {
        setStatus({ state: 'idle', message: 'Saved on this device · no cards to back up', at: null })
        return
      }
      if (!pending && remote.kind === 'file') {
        setStatus({ state: 'ok', message: 'Backed up on GitHub', at: Date.now() })
        return
      }

      setStatus({ state: 'syncing', message: 'Backing up to GitHub…' })
      try {
        const nextSha = await putRemote(cfg, snapshot, sha)
        saveKnownSha(nextSha)
      } catch (error) {
        if (error instanceof GithubError && error.message === 'conflict' && attempt < 3) continue
        throw error
      }
      if (await acknowledgeRevision(includedRevision)) {
        syncAgain = true
        setStatus({ state: 'waiting', message: 'Saved on this device · waiting to back up newer changes', at: null })
      } else {
        setStatus({ state: 'ok', message: 'Backed up on GitHub', at: Date.now() })
      }
      return
    }
  } catch (error) {
    const local = await readLocalState()
    const pending = local.settings.localRevision > local.settings.acknowledgedRevision
    const detail = error instanceof Error ? error.message : 'Sync failed'
    setStatus({
      state: 'error',
      message: pending ? `Saved on this device · waiting to back up (${detail})` : detail,
      at: Date.now(),
    })
    throw error
  }
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

/** The data write already recorded a pending revision before this is called. */
export function schedulePush(): void {
  if (!isGithubConfigured()) return
  setStatus({ state: 'waiting', message: 'Saved on this device · waiting to back up', at: null })
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
  if (!isGithubConfigured()) {
    setStatus({ state: 'off', message: '', at: null })
    return
  }
  const local = await readLocalState()
  if (local.settings.localRevision > local.settings.acknowledgedRevision) {
    setStatus({ state: 'waiting', message: 'Saved on this device · waiting to back up', at: null })
  }
  try {
    await syncNow()
  } catch {
    /* Keep locally committed changes pending until the next foreground retry. */
  }
}

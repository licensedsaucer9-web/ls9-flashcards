import type { Snapshot } from './types.ts'
import { getAllCards, getSettings, putSettings, replaceAllCards } from './db.ts'
import { mergeSnapshots } from './merge.ts'
import {
  fetchRemote,
  GithubError,
  isGithubConfigured,
  loadGithubConfig,
  loadKnownSha,
  putRemote,
  saveKnownSha,
} from './github.ts'

export type SyncStatus = {
  state: 'off' | 'idle' | 'syncing' | 'ok' | 'error'
  message: string
  at: number | null
}

let status: SyncStatus = { state: 'off', message: '', at: null }
let dirty = false
let applying = false
let timer = 0
const listeners = new Set<() => void>()

export function getSyncStatus(): SyncStatus {
  if (!isGithubConfigured()) return { state: 'off', message: '', at: null }
  return status
}

export function onSyncStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) fn()
}

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch }
  emit()
}

export async function snapshotFromDb(): Promise<Snapshot> {
  const settings = await getSettings()
  return {
    version: 1,
    updated_at: Date.now(),
    settings: { direction: settings.direction, sessionSize: settings.sessionSize },
    cards: await getAllCards(),
    deleted_ids: settings.deletedIds,
  }
}

async function applySnapshot(snap: Snapshot): Promise<void> {
  applying = true
  try {
    await replaceAllCards(snap.cards)
    const cur = await getSettings()
    await putSettings({
      ...cur,
      direction: snap.settings.direction,
      sessionSize: snap.settings.sessionSize,
      deletedIds: snap.deleted_ids,
    })
  } finally {
    applying = false
  }
}

export async function pullFromGithub(): Promise<'missing' | 'applied' | 'skipped'> {
  const cfg = loadGithubConfig()
  if (!isGithubConfigured(cfg)) return 'skipped'
  setStatus({ state: 'syncing', message: 'Pulling…' })
  const remote = await fetchRemote(cfg)
  if (remote.kind === 'missing') {
    setStatus({ state: 'idle', message: 'No remote file yet' })
    return 'missing'
  }
  const hadDirty = dirty
  const local = await snapshotFromDb()
  const merged = mergeSnapshots(local, remote.snapshot)
  await applySnapshot(merged)
  saveKnownSha(remote.sha)
  if (hadDirty) {
    dirty = true
    setStatus({ state: 'ok', message: 'Merged', at: Date.now() })
    schedulePush()
  } else {
    dirty = false
    setStatus({ state: 'ok', message: 'Synced', at: Date.now() })
  }
  return 'applied'
}

export async function pushToGithub(opts?: { keepalive?: boolean }): Promise<void> {
  const cfg = loadGithubConfig()
  if (!isGithubConfigured(cfg) || applying) return
  setStatus({ state: 'syncing', message: 'Saving…' })
  const local = await snapshotFromDb()
  let sha = loadKnownSha()
  try {
    const next = await putRemote(cfg, local, sha, opts)
    saveKnownSha(next)
    dirty = false
    setStatus({ state: 'ok', message: 'Synced', at: Date.now() })
  } catch (err) {
    if (err instanceof GithubError && err.message === 'conflict') {
      const remote = await fetchRemote(cfg)
      if (remote.kind === 'missing') {
        const next = await putRemote(cfg, local, null, opts)
        saveKnownSha(next)
        dirty = false
        setStatus({ state: 'ok', message: 'Synced', at: Date.now() })
        return
      }
      const merged = mergeSnapshots(local, remote.snapshot)
      const next = await putRemote(cfg, merged, remote.sha, opts)
      saveKnownSha(next)
      await applySnapshot(merged)
      dirty = false
      setStatus({ state: 'ok', message: 'Synced', at: Date.now() })
      return
    }
    const message = err instanceof Error ? err.message : 'Sync failed'
    setStatus({ state: 'error', message, at: Date.now() })
    throw err
  }
}

export async function syncNow(): Promise<void> {
  const cfg = loadGithubConfig()
  if (!isGithubConfigured(cfg)) {
    setStatus({ state: 'off', message: '', at: null })
    return
  }
  try {
    const remote = await fetchRemote(cfg)
    if (remote.kind === 'missing') {
      await pushToGithub()
      return
    }
    const local = await snapshotFromDb()
    const merged = mergeSnapshots(local, remote.snapshot)
    await applySnapshot(merged)
    const next = await putRemote(cfg, merged, remote.sha)
    saveKnownSha(next)
    dirty = false
    setStatus({ state: 'ok', message: 'Synced', at: Date.now() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed'
    setStatus({ state: 'error', message, at: Date.now() })
    throw err
  }
}

export function schedulePush(): void {
  if (applying || !isGithubConfigured()) return
  dirty = true
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    void pushToGithub().catch(() => {
      /* status already set */
    })
  }, 1200)
}

export async function flushPush(): Promise<void> {
  window.clearTimeout(timer)
  if (dirty && isGithubConfigured()) {
    try {
      await pushToGithub({ keepalive: true })
    } catch {
      /* status already set */
    }
  }
}

export async function bootSync(): Promise<void> {
  if (!isGithubConfigured()) {
    setStatus({ state: 'off', message: '', at: null })
    return
  }
  try {
    const result = await pullFromGithub()
    if (result === 'missing') {
      const snap = await snapshotFromDb()
      if (snap.cards.length === 0) return
      await pushToGithub()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed'
    setStatus({ state: 'error', message, at: Date.now() })
  }
}



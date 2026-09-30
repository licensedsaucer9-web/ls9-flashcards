import type { DeckFile, UserFile } from './types.ts'
import { acknowledgeRevision, mergeDeckIntoDb, mergeProgressIntoDb, readLocalState } from './db.ts'
import type { MergeResult } from './db.ts'
import { legacyToFiles, mergeProgress } from './merge.ts'
import { captureStudyLock, hasStudyBinding, studyLockCurrent } from './study-lock.ts'
import { activeUserSlug, listUsers, registerRemoteUsers } from './user.ts'
import { cloudSyncPass, cloudTransport } from './sync-backend.ts'
import {
  fetchDeck,
  fetchUserFile,
  GithubError,
  isGithubConfigured,
  listRemoteUsers,
  loadGithubConfig,
  putDeck,
  putUserFile,
  saveKnownSha,
  userPath,
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
  if (!cloudTransport && !isGithubConfigured()) return { state: 'off', message: '', at: null }
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

/** Object keys in a fixed order, so a payload compare is not fooled by key order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
}

function samePayload(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b)
}

type Effective = {
  /** The deck as it should exist remotely, or null when there is nothing to merge. */
  deck: DeckFile | null
  deckSha: string | null
  /** True when the remote deck was a pre-multi-user snapshot that still has to be rewritten. */
  deckNeedsPush: boolean
  user: UserFile | null
  userSha: string | null
}

async function readRemote(slug: string): Promise<Effective> {
  const cfg = loadGithubConfig()
  const deckRemote = await fetchDeck(cfg)
  const userRemote = await fetchUserFile(cfg, slug)

  let deck: DeckFile | null = null
  let deckSha: string | null = null
  let deckNeedsPush = false
  let legacy: ReturnType<typeof legacyToFiles> | null = null

  if (deckRemote.kind === 'file') {
    deckSha = deckRemote.sha
    saveKnownSha(cfg.path, deckRemote.sha)
    if (deckRemote.value.kind === 'legacy') {
      // The one and only copy of this progress is in the v1 file, so it is
      // credited to whoever opens it and written out under their name.
      legacy = legacyToFiles(deckRemote.value.snapshot, slug)
      deck = legacy.deck
      deckNeedsPush = true
    } else {
      deck = deckRemote.value.file
    }
  }

  let user: UserFile | null = null
  let userSha: string | null = null
  if (userRemote.kind === 'file') {
    userSha = userRemote.sha
    saveKnownSha(userPath(cfg, slug), userRemote.sha)
    user = userRemote.value
    if (legacy) {
      // The per-user file is newer; keep progress that only the snapshot has.
      user = { ...user, progress: mergeProgress(legacy.user.progress, user.progress) }
    }
  } else if (legacy) {
    user = legacy.user
  }

  return { deck, deckSha, deckNeedsPush, user, userSha }
}

async function applyRemote(effective: Effective, slug: string): Promise<MergeResult | null> {
  let applied: MergeResult | null = null
  if (effective.deck) applied = await mergeDeckIntoDb(effective.deck, slug)
  if (effective.user) applied = await mergeProgressIntoDb(effective.user, slug)
  return applied
}

async function syncPass(): Promise<void> {
  if (cloudTransport) {
    const lock = captureStudyLock()
    if (!lock.uid) {
      setStatus({ state: 'idle', message: 'Saved on this device', at: null })
      return
    }
    setStatus({ state: 'syncing', message: 'Syncing', at: null })
    const outcome = await cloudSyncPass({
      requestAgain: () => {
        syncAgain = true
      },
    })
    if (!studyLockCurrent(lock)) return
    if (outcome === 'synced') setStatus({ state: 'ok', message: 'Synced', at: Date.now() })
    else setStatus({ state: 'waiting', message: 'Saved on this device', at: null })
    return
  }
  const cfg = loadGithubConfig()
  if (!isGithubConfigured(cfg)) {
    setStatus({ state: 'off', message: '', at: null })
    return
  }
  const slug = activeUserSlug()
  const lock = captureStudyLock()
  setStatus({ state: 'syncing', message: 'Checking GitHub…' })
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!studyLockCurrent(lock)) return
      const effective = await readRemote(slug)
      if (!studyLockCurrent(lock)) return
      const applied = await applyRemote(effective, slug)
      if (!studyLockCurrent(lock)) return
      const local = await readLocalState(slug)
      if (!studyLockCurrent(lock)) return
      const desiredDeck = local.snapshot.deck
      const desiredUser = local.snapshot.user

      if (effective.deck === null && desiredDeck.cards.length === 0) {
        setStatus({ state: 'idle', message: 'Saved on this device · no cards to back up', at: null })
        return
      }

      const pushDeck = effective.deckNeedsPush || effective.deck === null || !samePayload(desiredDeck, effective.deck)
      const pushUser = effective.user === null || !samePayload(desiredUser, effective.user)
      if (!pushDeck && !pushUser) {
        const revision = applied?.revision ?? local.settings.localRevision
        if (revision > local.settings.acknowledgedRevision) {
          // Nothing to write, but a local edit is still unaccounted for.
          if (!studyLockCurrent(lock)) return
          await acknowledgeRevision(revision, slug)
        }
        if (!studyLockCurrent(lock)) return
        setStatus({ state: 'ok', message: 'Backed up on GitHub', at: Date.now() })
        return
      }

      setStatus({ state: 'syncing', message: 'Backing up to GitHub…' })
      let deckSha = effective.deckSha
      let userSha = effective.userSha
      try {
        if (!studyLockCurrent(lock)) return
        if (pushDeck) {
          deckSha = await putDeck(cfg, desiredDeck, deckSha)
          saveKnownSha(cfg.path, deckSha)
        }
        if (pushUser) {
          userSha = await putUserFile(cfg, slug, desiredUser, userSha)
          saveKnownSha(userPath(cfg, slug), userSha)
        }
      } catch (error) {
        if (error instanceof GithubError && error.message === 'conflict' && attempt < 3) continue
        throw error
      }
      if (!studyLockCurrent(lock)) return
      if (await acknowledgeRevision(local.settings.localRevision, slug)) {
        syncAgain = true
        setStatus({ state: 'waiting', message: 'Saved on this device · waiting to back up newer changes', at: null })
      } else {
        setStatus({ state: 'ok', message: 'Backed up on GitHub', at: Date.now() })
      }
      return
    }
  } catch (error) {
    const local = await readLocalState(slug)
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
  if (!cloudTransport && !isGithubConfigured()) return
  const waiting = cloudTransport ? 'Saved on this device' : 'Saved on this device · waiting to back up'
  setStatus({ state: 'waiting', message: waiting, at: null })
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

/** Pull the list of profiles that have a progress file so switching works on a new device. */
export async function discoverRemoteUsers(): Promise<number> {
  if (hasStudyBinding()) return 0
  const cfg = loadGithubConfig()
  if (!isGithubConfigured(cfg)) return 0
  try {
    const before = listUsers().length
    const found = await listRemoteUsers(cfg)
    if (found.length) registerRemoteUsers(found)
    return Math.max(0, listUsers().length - before)
  } catch {
    /* Discovery is a convenience; a failure must not break syncing. */
    return 0
  }
}

export async function bootSync(): Promise<void> {
  if (cloudTransport) {
    if (!captureStudyLock().uid) return
    try {
      await syncNow()
    } catch {
      /* Keep locally committed changes pending until the next foreground retry. */
    }
    return
  }
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

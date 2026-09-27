import type { GithubConfig } from './types.ts'
import type { UserProfile } from './user.ts'
import { parseRemoteDeck, parseUserFile } from './merge.ts'
import type { RemoteDeck } from './merge.ts'
import type { UserFile } from './types.ts'

const STORAGE_KEY = 'german-flashcards.github'
const SHA_KEY = 'german-flashcards.github.shas'
const USERS_DIR = 'users'

export const DEFAULT_OWNER = 'licensedsaucer9-web'
export const DEFAULT_REPO = 'german-flashcards-data'

export function defaultGithubConfig(): GithubConfig {
  return { token: '', owner: DEFAULT_OWNER, repo: DEFAULT_REPO, path: 'data.json', branch: 'main' }
}

export function sanitizeToken(raw: string): string {
  return raw
    .replace(/^(Bearer|token)\s+/i, '')
    .replace(/[\s ‌‍]/g, '')
}

export function loadGithubConfig(): GithubConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultGithubConfig()
    const o = JSON.parse(raw) as Partial<GithubConfig>
    return {
      token: sanitizeToken(String(o.token ?? '')),
      owner: String(o.owner ?? '').trim() || DEFAULT_OWNER,
      repo: String(o.repo ?? '').trim() || DEFAULT_REPO,
      path: String(o.path ?? 'data.json').trim() || 'data.json',
      branch: String(o.branch ?? 'main').trim() || 'main',
    }
  } catch {
    return defaultGithubConfig()
  }
}

export function saveGithubConfig(cfg: GithubConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cfg, token: sanitizeToken(cfg.token) }))
}

export function isGithubConfigured(cfg = loadGithubConfig()): boolean {
  return Boolean(cfg.token && cfg.owner && cfg.repo && cfg.path)
}

/** Where a user's progress lives, next to the shared deck file. */
export function userPath(cfg: GithubConfig, slug: string): string {
  const path = cfg.path.replace(/^\/+/, '')
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : `${path.slice(0, slash)}/`
  return `${dir}${USERS_DIR}/${slug}.json`
}

// --- known shas -----------------------------------------------------------
// One sha per path: the deck and each user file move independently.

function readShas(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SHA_KEY)
    const o = raw ? JSON.parse(raw) : null
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function loadKnownSha(path: string): string | null {
  return readShas()[path] ?? null
}

export function saveKnownSha(path: string, sha: string | null): void {
  const shas = readShas()
  if (sha) shas[path] = sha
  else delete shas[path]
  try {
    localStorage.setItem(SHA_KEY, JSON.stringify(shas))
  } catch {
    /* a full quota must not break syncing */
  }
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function decodeUtf8Base64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
  // A byte view, not an int view: TextDecoder reads view.byteLength bytes, so a
  // Uint32Array would decode four times the data and interleave NUL bytes.
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${sanitizeToken(token)}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function contentsUrl(cfg: GithubConfig, path: string): string {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path.replace(/^\/+/, '')}`,
  )
  url.searchParams.set('ref', cfg.branch)
  return url.toString()
}

export class GithubError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function getJson(cfg: GithubConfig, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(contentsUrl(cfg, path), { headers: headers(cfg.token), credentials: 'omit' })
  if (res.status === 404) return { status: 404, json: null }
  if (!res.ok) {
    const body = await res.text()
    throw new GithubError(res.status, githubMessage(res.status, body))
  }
  return { status: res.status, json: await res.json() }
}

export type RemoteFile<T> = { kind: 'missing' } | { kind: 'file'; sha: string; value: T }

/** The shared vocabulary, which may still be a v1 snapshot on first run after the upgrade. */
export async function fetchDeck(cfg: GithubConfig): Promise<RemoteFile<RemoteDeck>> {
  const { status, json } = await getJson(cfg, cfg.path)
  if (status === 404) return { kind: 'missing' }
  const j = json as { sha?: string; content?: string }
  if (!j.sha) throw new GithubError(500, 'GitHub file had no sha')
  if (!j.content) throw new GithubError(500, 'GitHub file had no content')
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8Base64(j.content))
  } catch {
    throw new GithubError(500, 'GitHub file is not valid JSON')
  }
  const value = parseRemoteDeck(parsed)
  if (!value) throw new GithubError(500, 'GitHub file is not a flashcard deck')
  return { kind: 'file', sha: j.sha, value }
}

export async function fetchUserFile(cfg: GithubConfig, slug: string): Promise<RemoteFile<UserFile>> {
  const { status, json } = await getJson(cfg, userPath(cfg, slug))
  if (status === 404) return { kind: 'missing' }
  const j = json as { sha?: string; content?: string }
  if (!j.sha) throw new GithubError(500, 'GitHub file had no sha')
  if (!j.content) throw new GithubError(500, 'GitHub file had no content')
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8Base64(j.content))
  } catch {
    throw new GithubError(500, 'GitHub user file is not valid JSON')
  }
  const value = parseUserFile(parsed)
  if (!value) throw new GithubError(500, 'GitHub user file is not a flashcard profile')
  return { kind: 'file', sha: j.sha, value }
}

async function putFile(cfg: GithubConfig, path: string, payload: unknown, sha: string | null, message: string): Promise<string> {
  const body = JSON.stringify({
    message,
    content: encodeUtf8Base64(`${JSON.stringify(payload)}\n`),
    branch: cfg.branch,
    ...(sha ? { sha } : {}),
  })
  const url = contentsUrl(cfg, path).split('?')[0]
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(cfg.token), 'Content-Type': 'application/json' },
    body,
    credentials: 'omit',
  })
  if (res.status === 409 || res.status === 422) throw new GithubError(res.status, 'conflict')
  if (!res.ok) throw new GithubError(res.status, githubMessage(res.status, await res.text()))
  const json = (await res.json()) as { content?: { sha?: string } }
  const next = json.content?.sha
  if (!next) throw new GithubError(500, 'GitHub did not return a file sha')
  return next
}

export function putDeck(cfg: GithubConfig, payload: unknown, sha: string | null): Promise<string> {
  return putFile(cfg, cfg.path, payload, sha, `deck ${new Date().toISOString()}`)
}

export function putUserFile(cfg: GithubConfig, slug: string, payload: unknown, sha: string | null): Promise<string> {
  return putFile(cfg, userPath(cfg, slug), payload, sha, `${slug} progress ${new Date().toISOString()}`)
}

/** Profiles that already have a progress file, so a new device can switch to them. */
export async function listRemoteUsers(cfg: GithubConfig): Promise<UserProfile[]> {
  const { status, json } = await getJson(cfg, USERS_DIR)
  if (status === 404) return []
  if (!Array.isArray(json)) return []
  return json
    .filter((e): e is { name: string; type: string } => Boolean(e) && typeof (e as { name?: unknown }).name === 'string')
    .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
    .map((e) => {
      const slug = e.name.slice(0, -'.json'.length)
      return { slug, name: slug, createdAt: 0 }
    })
}

function githubMessage(status: number, body: string): string {
  if (status === 401) {
    return 'GitHub token was rejected (401). Use a PAT starting with github_pat_ or ghp_, not your GitHub password. Paste the full token again.'
  }
  if (status === 403) return 'GitHub forbidden (token scope or rate limit)'
  if (status === 404) return 'Repo or path not found (use a private repo with Contents access)'
  try {
    const j = JSON.parse(body) as { message?: string }
    if (j.message) return j.message
  } catch {
    /* ignore */
  }
  return `GitHub error ${status}`
}

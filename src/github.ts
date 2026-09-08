import type { GithubConfig, Snapshot } from './types.ts'
import { parseSnapshot } from './merge.ts'

const STORAGE_KEY = 'german-flashcards.github'
const SHA_KEY = 'german-flashcards.github.sha'

export const DEFAULT_OWNER = 'licensedsaucer9-web'
export const DEFAULT_REPO = 'german-flashcards-data'

export function defaultGithubConfig(): GithubConfig {
  return { token: '', owner: DEFAULT_OWNER, repo: DEFAULT_REPO, path: 'data.json', branch: 'main' }
}

export function sanitizeToken(raw: string): string {
  return raw
    .replace(/^(Bearer|token)\s+/i, '')
    .replace(/[\s\u00a0\u200b\u200c\u200d]/g, '')
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

export function loadKnownSha(): string | null {
  return localStorage.getItem(SHA_KEY)
}

export function saveKnownSha(sha: string | null): void {
  if (sha) localStorage.setItem(SHA_KEY, sha)
  else localStorage.removeItem(SHA_KEY)
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function decodeUtf8Base64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
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

function contentsUrl(cfg: GithubConfig): string {
  const path = cfg.path.replace(/^\/+/, '')
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`,
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

export type RemoteFile =
  | { kind: 'missing' }
  | { kind: 'file'; sha: string; snapshot: Snapshot }

export async function fetchRemote(cfg: GithubConfig): Promise<RemoteFile> {
  const res = await fetch(contentsUrl(cfg), { headers: headers(cfg.token), credentials: 'omit' })
  if (res.status === 404) return { kind: 'missing' }
  if (!res.ok) {
    const body = await res.text()
    throw new GithubError(res.status, githubMessage(res.status, body))
  }
  const json = (await res.json()) as { sha: string; content?: string; encoding?: string }
  if (!json.content) throw new GithubError(500, 'GitHub file had no content')
  const text = decodeUtf8Base64(json.content)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new GithubError(500, 'GitHub file is not valid JSON')
  }
  const snapshot = parseSnapshot(parsed)
  if (!snapshot) throw new GithubError(500, 'GitHub file is not a flashcard snapshot')
  return { kind: 'file', sha: json.sha, snapshot }
}

export async function putRemote(
  cfg: GithubConfig,
  snapshot: Snapshot,
  sha: string | null,
  opts?: { keepalive?: boolean },
): Promise<string> {
  const body = JSON.stringify({
    message: `flashcards ${new Date(snapshot.updated_at).toISOString()}`,
    content: encodeUtf8Base64(`${JSON.stringify(snapshot)}\n`),
    branch: cfg.branch,
    ...(sha ? { sha } : {}),
  })
  const url = contentsUrl(cfg).split('?')[0]
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(cfg.token), 'Content-Type': 'application/json' },
    body,
    keepalive: opts?.keepalive ?? false,
    credentials: 'omit',
  })
  if (res.status === 409 || res.status === 422) {
    throw new GithubError(res.status, 'conflict')
  }
  if (!res.ok) {
    const text = await res.text()
    throw new GithubError(res.status, githubMessage(res.status, text))
  }
  const json = (await res.json()) as { content?: { sha?: string } }
  const next = json.content?.sha
  if (!next) throw new GithubError(500, 'GitHub did not return a file sha')
  return next
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

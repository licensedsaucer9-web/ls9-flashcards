import { storagePrefix } from './rehearsal.ts'

const ACTIVE_KEY = `${storagePrefix}.user`
const USERS_KEY = `${storagePrefix}.users`
const MIGRATED_KEY = `${storagePrefix}.migrated`

/** The database every pre-multi-user build used. Read once to seed the first user. */
export const LEGACY_DB_NAME = storagePrefix

export type UserProfile = {
  slug: string
  name: string
  createdAt: number
}

/** The account the existing single-user data is claimed by on first run. */
export const DEFAULT_USER: UserProfile = { slug: 'joakim', name: 'Joakim', createdAt: 0 }

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function readUsers(): UserProfile[] {
  try {
    const raw = localStorage.getItem(USERS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((u): u is UserProfile => Boolean(u) && typeof u.slug === 'string' && u.slug !== '')
      .map((u) => ({ slug: u.slug, name: String(u.name ?? u.slug), createdAt: Number(u.createdAt) || 0 }))
  } catch {
    return []
  }
}

function writeUsers(users: UserProfile[]): void {
  localStorage.setItem(USERS_KEY, JSON.stringify(users))
}

export function listUsers(): UserProfile[] {
  return readUsers().sort((a, b) => a.createdAt - b.createdAt || a.slug.localeCompare(b.slug))
}

/**
 * The user whose data this device is showing. On a first run there is no list yet,
 * so the default profile is registered and claims the pre-multi-user data. Registering
 * it matters: an unregistered slug can never be resolved, so the default profile would
 * be impossible to switch back to once another one was added.
 */
export function activeUser(): UserProfile {
  const users = readUsers()
  const wanted = localStorage.getItem(ACTIVE_KEY)
  const found = users.find((u) => u.slug === wanted)
  if (found) return found
  if (!users.length) return createUser(DEFAULT_USER.name, DEFAULT_USER.createdAt || Date.now())
  const first = users[0]
  localStorage.setItem(ACTIVE_KEY, first.slug)
  return first
}

export function activeUserSlug(): string {
  return activeUser().slug
}

/** Every user gets their own IndexedDB database, so profiles never share progress. */
export function dbNameForUser(slug: string): string {
  return `${LEGACY_DB_NAME}:${slug}`
}

/** Signed-in study. Distinct from `german-flashcards` and `german-flashcards:<slug>`. */
export function accountDatabaseName(uid: string): string {
  return `${LEGACY_DB_NAME}:account:${uid}`
}

/**
 * The database a signed-out device is already using. Does not register a profile.
 * A device with no profile list still uses the original database.
 */
export function currentLocalDatabaseName(): string {
  const users = readUsers()
  if (!users.length) return LEGACY_DB_NAME
  const wanted = localStorage.getItem(ACTIVE_KEY)
  const found = users.find((u) => u.slug === wanted) ?? users[0]
  return dbNameForUser(found.slug)
}

export function createUser(name: string, at = Date.now()): UserProfile {
  const clean = name.trim()
  const slug = slugify(clean)
  if (!slug) throw new Error('Name needs at least one letter or number')
  const users = readUsers()
  const existing = users.find((u) => u.slug === slug)
  if (existing) {
    setActiveUser(slug)
    return existing
  }
  const profile: UserProfile = { slug, name: clean, createdAt: at }
  writeUsers([...users, profile])
  setActiveUser(slug)
  return profile
}

export function setActiveUser(slug: string): void {
  localStorage.setItem(ACTIVE_KEY, slug)
}

/** Merge profiles discovered in the remote repo so a new device can switch to them. */
export function registerRemoteUsers(profiles: UserProfile[]): UserProfile[] {
  const users = readUsers()
  const known = new Set(users.map((u) => u.slug))
  const added = profiles.filter((p) => p.slug && !known.has(p.slug))
  if (added.length) writeUsers([...users, ...added])
  return listUsers()
}

export function hasMigrated(): boolean {
  return localStorage.getItem(MIGRATED_KEY) === '1'
}

export function markMigrated(): void {
  localStorage.setItem(MIGRATED_KEY, '1')
}

import { buildInfo } from './build-info.ts'

// Settings → Check for update. Compares the running bundle with the published
// release.json and, when they differ, drops only this app's service worker and
// Workbox caches before a hard reload. User data (localStorage, IndexedDB,
// Firestore state, auth) is never touched.

const BUST_PARAM = 'ls9-update'

export type UpdateCheck =
  | { readonly status: 'current'; readonly version: string; readonly sourceCommit: string }
  | { readonly status: 'available'; readonly version: string; readonly sourceCommit: string }
  | { readonly status: 'error'; readonly message: string }

function appBase(): URL {
  return new URL(import.meta.env.BASE_URL, location.href)
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const url = new URL('release.json', appBase())
  url.searchParams.set(BUST_PARAM, String(Date.now()))
  const unreadable: UpdateCheck = { status: 'error', message: 'Could not read the latest version information. Try again later.' }
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch {
    return { status: 'error', message: 'Could not check for updates. Check your connection and try again.' }
  }
  if (!response.ok) return { status: 'error', message: `Could not check for updates (server answered ${response.status}). Try again later.` }
  let release: unknown
  try {
    release = await response.json()
  } catch {
    return unreadable
  }
  const { version, sourceCommit } = (release ?? {}) as { version?: unknown; sourceCommit?: unknown }
  if (typeof version !== 'string' || typeof sourceCommit !== 'string' || !version || !sourceCommit) {
    return unreadable
  }
  const same = version === buildInfo.version && sourceCommit === buildInfo.sourceCommit
  return { status: same ? 'current' : 'available', version, sourceCommit }
}

// Workbox names its caches "workbox-<kind>-<scope>" (e.g. workbox-precache-v2-
// https://host/base/). Only caches for this app's scope are removed.
async function deleteAppCaches(scope: string): Promise<void> {
  if (!('caches' in window)) return
  const names = await caches.keys()
  await Promise.all(names.filter((name) => name.startsWith('workbox-') && name.endsWith(scope)).map((name) => caches.delete(name)))
}

export async function applyUpdate(): Promise<void> {
  let scope = appBase().href
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)
    if (registration) {
      scope = registration.scope
      await registration.update().catch(() => undefined)
      // Unregistering detaches the old worker from new navigations, so the
      // reload below fetches the new build; main.ts registers sw.js again.
      await registration.unregister().catch(() => false)
    }
  }
  await deleteAppCaches(scope).catch(() => undefined)
  const next = new URL(location.href)
  next.searchParams.set(BUST_PARAM, String(Date.now()))
  location.replace(next.href)
}

// Remove the cache-busting query after the reload so it does not linger in
// the address bar or in bookmarks.
export function clearUpdateParam(): void {
  const url = new URL(location.href)
  if (!url.searchParams.has(BUST_PARAM)) return
  url.searchParams.delete(BUST_PARAM)
  history.replaceState(history.state, '', url.href)
}

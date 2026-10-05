/**
 * Safari shares one origin's IndexedDB across site paths. An installed Home
 * Screen app runs only the pages inside its own manifest scope, in a separate
 * store from Safari. The new site scope cannot enter the old installation.
 */

export const LEGACY_ORIGIN = 'https://licensedsaucer9-web.github.io'
export const LEGACY_SCOPE = `${LEGACY_ORIGIN}/german-flashcards-site/`
export const NEW_SITE_SCOPE = `${LEGACY_ORIGIN}/ls9-flashcards-site/`
export const LEGACY_STORAGE_PREFIX = 'german-flashcards'

export type InstallKind = 'safari' | 'home-screen' | 'unknown'

export type RecoveryContext = {
  install: InstallKind
  origin: string
  scope: string | null
  reachable: boolean
}

export type PlannedRoute = 'existing-client' | 'bridge' | 'blocker'

export function plannedRoute(context: RecoveryContext): PlannedRoute {
  if (context.install === 'unknown' || context.origin !== LEGACY_ORIGIN) return 'blocker'
  if (context.install === 'safari') return 'existing-client'
  if (context.install === 'home-screen') return context.scope === LEGACY_SCOPE ? 'bridge' : 'blocker'
  return 'blocker'
}

/** The bridge must open the original database names. Rehearsal storage cannot. */
export function bridgeStoragePrefix(rehearsal: boolean): string {
  if (rehearsal) throw new Error('The recovery bridge cannot use rehearsal storage')
  return LEGACY_STORAGE_PREFIX
}

export type ReadinessRow = { context: RecoveryContext; proven: boolean }

export type PublicReadiness = {
  contexts: number
  existingClient: number
  bridge: number
  unreachable: number
  proven: number
  blockers: number
}

/** Counts only. Install names, scopes, and origins stay out of this object. */
export function publicReadiness(rows: ReadinessRow[]): PublicReadiness {
  const summary: PublicReadiness = {
    contexts: rows.length,
    existingClient: 0,
    bridge: 0,
    unreachable: 0,
    proven: 0,
    blockers: 0,
  }
  for (const row of rows) {
    const route = plannedRoute(row.context)
    if (route === 'existing-client') summary.existingClient += 1
    else if (route === 'bridge') summary.bridge += 1
    if (!row.context.reachable) summary.unreachable += 1
    if (row.context.reachable && row.proven && route !== 'blocker') summary.proven += 1
    else summary.blockers += 1
  }
  return summary
}

/**
 * Installation classes named by the public URL record. These rows keep an
 * unfinished route visible. They are not a census of active installations,
 * and they do not meet #34 until a private inventory and a saved same-context
 * read exist. Each row stays unreachable until that read is saved.
 */
export function unreachedInstallationClasses(): ReadinessRow[] {
  return [
    {
      context: { install: 'safari', origin: LEGACY_ORIGIN, scope: null, reachable: false },
      proven: false,
    },
    {
      context: { install: 'home-screen', origin: LEGACY_ORIGIN, scope: LEGACY_SCOPE, reachable: false },
      proven: false,
    },
  ]
}

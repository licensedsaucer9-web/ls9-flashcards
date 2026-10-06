import { createHash } from 'node:crypto'
import { same } from './migration-core.mjs'
import { publicReadiness, unreachedInstallationClasses } from '../src/recovery-context.ts'

export const PRODUCTION_PROJECT = 'flashcards-ls9-prod'
export const PUBLIC_BASE = '/ls9-flashcards-site/'
export const LEGACY_BASE = '/german-flashcards-site/'
export const LEGACY_SITE_REVISION = '1dbc26214bb3bfe1e132edc94688bd3137c1e996'
export const AUTHORIZED_HOSTS = ['licensedsaucer9-web.github.io', 'flashcards-ls9-prod.firebaseapp.com']

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Both Pages publish steps stay disabled. Enabling either one fails the preflight. */
export function publicationHeld(workflow) {
  const checkout = workflow.includes('name: Check out public site\n        if: ${{ false }}')
  const publish = workflow.includes('name: Publish tested files\n        if: ${{ false }}')
  return checkout && publish
}

export function rulesDeployPlan(projectId) {
  if (projectId !== PRODUCTION_PROJECT) throw new Error('Rules deployment is prepared only for flashcards-ls9-prod')
  return {
    command: 'npx firebase deploy --only firestore:rules --project flashcards-ls9-prod',
    executed: false,
  }
}

export function configurationFingerprint({ rulesText, firebaseJsonText, workflowText, sourceRevision, webProjectId }) {
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('source revision must be a full git commit')
  if (webProjectId !== PRODUCTION_PROJECT) throw new Error('Production preflight requires the production web project')
  if (!publicationHeld(workflowText)) throw new Error('Pages publication is enabled; preflight refuses to continue')
  return {
    sourceRevision,
    rulesSha256: sha256Text(rulesText),
    firebaseJsonSha256: sha256Text(firebaseJsonText),
    projectId: webProjectId,
    basePath: PUBLIC_BASE,
    legacyBase: LEGACY_BASE,
    authorizedHosts: [...AUTHORIZED_HOSTS],
    legacySiteRevision: LEGACY_SITE_REVISION,
    rulesDeploy: rulesDeployPlan(webProjectId),
    recheck: {
      reuse: 'Reuse this package only when the data-repo commit, this source revision, and the rules checksum are unchanged, and a fresh read-only server comparison matches the saved reviewed capture.',
      server: 'Compare the relevant document IDs, values, clocks, assignments, and memberships with that capture, or compare a canonical checksum of that state. Leave the capture time out of the checksum. Collection counts are an additional check and do not establish that the server is unchanged.',
      preserve: 'The importer retaining a newer server value does not show that the reviewed dry run still describes the target.',
      unavailable: 'An unavailable server comparison or checksum blocks reuse.',
      advance: 'A difference invalidates the reviewed dry run. Refresh the export, baseline, dry run, and preflight, and review that evidence before an authorized apply.',
    },
    preservation: {
      writePause: 'Pause legacy review, edit, and cloud writes before the authorized import. This preflight does not pause them.',
      legacySiteRevision: LEGACY_SITE_REVISION,
      rollback: 'Restore the recorded compatibility-site revision. After Firebase study exists, roll back with a Firebase-compatible client and keep that data.',
      backup: 'npm run migrate -- backup --project flashcards-ls9-prod --credential service-account-prod.json --out <private path outside Git>',
    },
  }
}

/**
 * Read account and deck documents only. A personal deck is a conflict: this
 * does not delete it. Returned fields are counts, never UIDs.
 */
export async function inspectAssignments(store, mapping) {
  if (mapping.projectId !== PRODUCTION_PROJECT) throw new Error('Production inspection requires flashcards-ls9-prod')
  let present = 0
  let missingAccounts = 0
  let conflicts = 0
  for (const uid of Object.values(mapping.profiles)) {
    const account = await store.get(`users/${uid}`)
    const personal = await store.get(`decks/${uid}`)
    if (!account) missingAccounts += 1
    else if (account.deckId !== mapping.deckId || account.schemaVersion !== 1) conflicts += 1
    else present += 1
    if (personal) conflicts += 1
  }
  const deck = await store.get(`decks/${mapping.deckId}`)
  let deckState = 'absent'
  if (deck) {
    const members = Array.isArray(deck.memberUids) ? [...deck.memberUids].sort() : []
    const expected = Object.values(mapping.profiles).sort()
    deckState = same(members, expected) ? 'matching' : 'conflict'
    if (deckState === 'conflict') conflicts += 1
  } else if (present > 0) conflicts += 1
  return {
    accounts: Object.keys(mapping.profiles).length,
    present,
    missingAccounts,
    conflicts,
    deckState,
  }
}

export function deviceRouteSummary() {
  const summary = publicReadiness(unreachedInstallationClasses())
  return { contexts: summary.contexts, proven: summary.proven, blockers: summary.blockers }
}

function serverFingerprintPresent(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function productionReadiness({ fingerprint, credentialPresent, mappingPresent, uidsConfirmed, inspection, backupVerified, serverFingerprint = null }) {
  const deviceRoutes = deviceRouteSummary()
  const blockers = []
  if (!credentialPresent) blockers.push('production-credential')
  if (!mappingPresent) blockers.push('production-mapping')
  if (!uidsConfirmed) blockers.push('production-uids')
  if (!inspection) blockers.push('production-inspection')
  else if (inspection.conflicts > 0 || inspection.missingAccounts > 0 || inspection.deckState !== 'matching') blockers.push('assignment-conflicts')
  if (!serverFingerprintPresent(serverFingerprint)) blockers.push('server-fingerprint')
  if (!backupVerified) blockers.push('production-backup')
  if (deviceRoutes.proven < deviceRoutes.contexts || deviceRoutes.blockers > 0) blockers.push('device-routes')
  return {
    ready: blockers.length === 0,
    blockers,
    projectId: fingerprint.projectId,
    sourceRevision: fingerprint.sourceRevision,
    rulesSha256: fingerprint.rulesSha256,
    publicationHeld: true,
    rulesDeployExecuted: fingerprint.rulesDeploy.executed,
    deviceRoutes,
  }
}

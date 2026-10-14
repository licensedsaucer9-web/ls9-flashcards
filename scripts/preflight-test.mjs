import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { publicationMode } from './release-core.mjs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateMapping } from '../src/migration-data.ts'
import {
  configurationFingerprint,
  inspectAssignments,
  productionReadiness,
  publicationHeld,
  rulesDeployPlan,
  sha256Text,
} from './preflight-core.mjs'

const revision = 'a'.repeat(40)
const rules = 'rules_version = "2";\n'
const firebaseJson = '{"firestore":{"rules":"firestore.rules"}}\n'
const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8')
publicationMode(workflow) // Reject partial/unguarded publication, including after the authorized cutover.
// Readiness preflight still requires held publication. Test that phase with a
// held fixture because the authorized master workflow now publishes.
const held = workflow.replaceAll("${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/master' }}", '${{ false }}')
assert.equal(publicationHeld(held), true, 'both Pages publish steps stay disabled')
assert.equal(publicationHeld(held.replace('name: Publish tested files\n        if: ${{ false }}', 'name: Publish tested files\n        if: ${{ true }}')), false)

const fingerprint = configurationFingerprint({
  rulesText: rules, firebaseJsonText: firebaseJson, workflowText: held, sourceRevision: revision, webProjectId: 'flashcards-ls9-prod',
})
assert.equal(fingerprint.rulesSha256, sha256Text(rules))
assert.equal(fingerprint.firebaseJsonSha256, sha256Text(firebaseJson))
assert.deepEqual(fingerprint.rulesDeploy, rulesDeployPlan('flashcards-ls9-prod'))
assert.equal(fingerprint.rulesDeploy.executed, false)
const recheck = JSON.stringify(fingerprint.recheck)
assert.match(fingerprint.recheck.reuse, /data-repo commit/)
assert.match(fingerprint.recheck.reuse, /source revision/)
assert.match(fingerprint.recheck.reuse, /rules checksum/)
assert.match(fingerprint.recheck.server, /document IDs/)
assert.match(fingerprint.recheck.server, /values/)
assert.match(fingerprint.recheck.server, /clocks/)
assert.match(fingerprint.recheck.server, /assignments/)
assert.match(fingerprint.recheck.server, /memberships/)
assert.match(fingerprint.recheck.server, /canonical checksum/)
assert.match(fingerprint.recheck.server, /additional check/)
assert.match(fingerprint.recheck.preserve, /newer server value/)
assert.match(fingerprint.recheck.unavailable, /unavailable/)
assert.match(fingerprint.recheck.unavailable, /blocks reuse/)
assert.match(fingerprint.recheck.advance, /invalidates the reviewed dry run/)
assert.equal(/server counts are unchanged/.test(recheck), false)
const runbook = readFileSync(new URL('../docs/firebase-setup.md', import.meta.url), 'utf8')
assert.equal(runbook.includes('server counts are unchanged'), false)
assert.match(runbook, /document IDs, values,\s+clocks, assignments, and memberships/)
assert.match(runbook, /canonical\s+checksum/)
assert.match(runbook, /additional check/)
assert.match(runbook, /newer server value/)
assert.match(runbook, /unavailable server comparison/)
assert.match(runbook, /invalidates the reviewed dry run/)
assert.throws(() => rulesDeployPlan('flashcards-ls9-auth-test'), /flashcards-ls9-prod/)
assert.throws(() => configurationFingerprint({
  rulesText: rules, firebaseJsonText: firebaseJson, workflowText: held.replace('if: ${{ false }}', 'if: ${{ true }}'),
  sourceRevision: revision, webProjectId: 'flashcards-ls9-prod',
}), /publication is enabled/)

const blocked = productionReadiness({
  fingerprint, credentialPresent: false, mappingPresent: false, uidsConfirmed: false, inspection: null, backupVerified: false,
})
assert.equal(blocked.ready, false)
assert.deepEqual(blocked.blockers, [
  'production-credential', 'production-mapping', 'production-uids', 'production-inspection', 'server-fingerprint', 'production-backup', 'device-routes',
])
assert.deepEqual(blocked.deviceRoutes, { contexts: 2, proven: 0, blockers: 2 })
const encoded = JSON.stringify(blocked)
assert.equal(encoded.includes('AIza'), false)
assert.equal(encoded.includes('/home/'), false)
assert.equal(encoded.includes('prodUserJoakim'), false)

const mapping = validateMapping({
  version: 1, projectId: 'flashcards-ls9-prod', deckId: 'legacy-german', profiles: { joakim: 'prodUserJoakim' },
})
function memoryStore(docs) {
  return {
    get: async (path) => docs[path] ?? null,
    atomic() { throw new Error('preflight inspection must not write') },
  }
}
const clean = await inspectAssignments(memoryStore({
  'users/prodUserJoakim': { deckId: 'legacy-german', schemaVersion: 1, migrationStatus: 'complete' },
  'decks/legacy-german': { memberUids: ['prodUserJoakim'] },
}), mapping)
assert.deepEqual(clean, { accounts: 1, present: 1, missingAccounts: 0, conflicts: 0, deckState: 'matching' })
assert.equal(JSON.stringify(clean).includes('prodUserJoakim'), false)

const personal = await inspectAssignments(memoryStore({
  'users/prodUserJoakim': { deckId: 'legacy-german', schemaVersion: 1, migrationStatus: 'complete' },
  'decks/prodUserJoakim': { memberUids: ['prodUserJoakim'] },
  'decks/legacy-german': { memberUids: ['prodUserJoakim'] },
}), mapping)
assert.equal(personal.conflicts, 1, 'an existing personal deck stays in place and blocks the import')

const missing = await inspectAssignments(memoryStore({}), mapping)
assert.equal(missing.missingAccounts, 1)
assert.equal(missing.deckState, 'absent')

const withoutFingerprint = productionReadiness({
  fingerprint, credentialPresent: true, mappingPresent: true, uidsConfirmed: true, inspection: clean, backupVerified: true,
})
assert.equal(withoutFingerprint.ready, false)
assert.equal(withoutFingerprint.blockers.includes('server-fingerprint'), true)
const ready = productionReadiness({
  fingerprint, credentialPresent: true, mappingPresent: true, uidsConfirmed: true, inspection: clean, backupVerified: true,
  serverFingerprint: 'b'.repeat(64),
})
assert.equal(ready.ready, false, 'unproven device routes keep the package blocked')
assert.deepEqual(ready.blockers, ['device-routes'])

const root = fileURLToPath(new URL('../', import.meta.url))
if (publicationMode(workflow) === 'master-only') {
  // A new readiness package must still refuse an already enabled publish
  // workflow. That expected refusal must not break the authorized release CI.
  const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.mjs', 'preflight'], {
    cwd: root, encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Pages publication is enabled/)
} else {
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.mjs', 'preflight'], {
    cwd: root, encoding: 'utf8',
  })
  const summary = JSON.parse(stdout)
  assert.equal(summary.ready, false)
  assert.equal(summary.blockers.includes('server-fingerprint'), true)
  assert.equal(summary.rulesDeployExecuted, false)
  assert.equal(summary.publicationHeld, true)
  assert.equal(summary.projectId, 'flashcards-ls9-prod')
  assert.equal(summary.rulesSha256, sha256Text(readFileSync(new URL('../firestore.rules', import.meta.url))))
  assert.equal(stdout.includes('AIza'), false)
  assert.equal(stdout.includes('service-account'), false)

  const directory = mkdtempSync(join(tmpdir(), 'preflight-'))
  const report = join(directory, 'preflight.json')
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.mjs', 'preflight', '--out', report], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const body = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(body.rulesDeploy.executed, false)
    assert.match(body.recheck.server, /canonical checksum/)
    assert.equal(body.readiness.blockers.includes('server-fingerprint'), true)
    assert.equal(body.rulesDeploy.command.includes('firebase deploy --only firestore:rules'), true)
    assert.equal(statSync(report).mode & 0o777, 0o600)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

console.log('preflight: fingerprint, publication guard, read-only conflicts, device-route blocker: ok')

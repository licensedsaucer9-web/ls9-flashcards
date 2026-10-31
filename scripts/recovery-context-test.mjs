import assert from 'node:assert/strict'
import { completedLegacyAssignment, legacyAssignmentRefusal } from '../src/account-plan.ts'
import {
  LEGACY_ORIGIN,
  LEGACY_SCOPE,
  LEGACY_STORAGE_PREFIX,
  NEW_SITE_SCOPE,
  plannedRoute,
  publicReadiness,
  unreachedInstallationClasses,
} from '../src/recovery-context.ts'
import { dbNameForUser, LEGACY_DB_NAME } from '../src/user.ts'

const safari = { install: 'safari', origin: LEGACY_ORIGIN, scope: NEW_SITE_SCOPE, reachable: true }
assert.equal(plannedRoute(safari), 'existing-client', 'same-origin Safari uses the existing recovery client')
assert.equal(plannedRoute({ install: 'home-screen', origin: LEGACY_ORIGIN, scope: LEGACY_SCOPE, reachable: true }), 'bridge')
assert.equal(plannedRoute({ install: 'home-screen', origin: LEGACY_ORIGIN, scope: NEW_SITE_SCOPE, reachable: true }), 'blocker',
  'a new Home Screen scope does not hold the old installation')
assert.equal(plannedRoute({ install: 'safari', origin: 'http://127.0.0.1:4173', scope: null, reachable: true }), 'blocker')
assert.equal(plannedRoute({ install: 'unknown', origin: LEGACY_ORIGIN, scope: LEGACY_SCOPE, reachable: true }), 'blocker')
assert.equal(plannedRoute({ install: 'home-screen', origin: LEGACY_ORIGIN, scope: null, reachable: true }), 'blocker')

assert.equal(LEGACY_DB_NAME, LEGACY_STORAGE_PREFIX, 'this test process is not a rehearsal build')
assert.equal(dbNameForUser('joakim'), `${LEGACY_STORAGE_PREFIX}:joakim`)

const published = publicReadiness(unreachedInstallationClasses())
assert.deepEqual(published, {
  contexts: 2,
  existingClient: 1,
  bridge: 1,
  unreachable: 2,
  proven: 0,
  blockers: 2,
})
const encoded = JSON.stringify(published)
assert.equal(encoded.includes('http') || encoded.includes('safari') || encoded.includes('home-screen') || encoded.includes('iphone'), false,
  'the published aggregate is counts only')

const provenSafari = publicReadiness([{ context: safari, proven: true }])
assert.deepEqual(provenSafari, { contexts: 1, existingClient: 1, bridge: 0, unreachable: 0, proven: 1, blockers: 0 })
const unprovenBridge = publicReadiness([{
  context: { install: 'home-screen', origin: LEGACY_ORIGIN, scope: LEGACY_SCOPE, reachable: true },
  proven: false,
}])
assert.equal(unprovenBridge.bridge, 1)
assert.equal(unprovenBridge.proven, 0)
assert.equal(unprovenBridge.blockers, 1, 'a route without a saved read stays a blocker')

const complete = { deckId: 'legacy-german', schemaVersion: 1, migrationStatus: 'complete' }
assert.equal(completedLegacyAssignment(complete, 'legacy-german'), true)
assert.equal(legacyAssignmentRefusal(complete, 'legacy-german'), null)
for (const row of [
  null,
  { deckId: 'legacy-german', schemaVersion: 1, migrationStatus: 'pending' },
  { deckId: 'legacy-german', schemaVersion: 1, migrationStatus: 'new' },
  { deckId: 'other', schemaVersion: 1, migrationStatus: 'complete' },
  { deckId: 'legacy-german', schemaVersion: 2, migrationStatus: 'complete' },
  { schemaVersion: 1, migrationStatus: 'complete' },
]) {
  assert.equal(completedLegacyAssignment(row, 'legacy-german'), false)
  assert.equal(legacyAssignmentRefusal(row, 'legacy-german')?.code, 'rehearsal/import-required')
}

console.log('recovery context: routes, unpublished aggregate, legacy-account guard: ok')

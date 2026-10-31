import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc } from 'firebase/firestore'
import { provisionAccount } from '../src/provision.ts'
import { adminStore } from './migration-admin.mjs'
import { prepareMigration, runMigration } from './migration-core.mjs'
import { mapping, snapshot, srs } from './migration-fixtures.mjs'
import { exportFirestore, snapshotDigest } from './migration-files.mjs'

const env = await initializeTestEnvironment({ projectId: mapping.projectId,
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } })
const store = await adminStore(mapping.projectId, { emulator: true })
const base = 'http://127.0.0.1:4177/'
process.env.VITE_SYNC_BACKEND = 'firebase'
process.env.VITE_FIREBASE_PROJECT_ID = mapping.projectId
let server
let browser
const privateDirectory = mkdtempSync(join(tmpdir(), 'migration-emulator-'))
try {
  server = await createServer({
    server: { host: '127.0.0.1', port: 4177, strictPort: true },
    // Every run starts cold, as CI does. The browser imports its fixture via
    // evaluate(), outside Vite's HTML scan; explicitly optimize its dependencies
    // so discovering them cannot trigger a reload during the account restore.
    cacheDir: join(privateDirectory, 'vite-cache'),
    optimizeDeps: { include: ['firebase/app', 'firebase/firestore'], noDiscovery: true },
  })
  await server.listen()
  await env.clearFirestore()
  const unimportedUid = 'uid-not-imported'
  const unimportedStore = env.authenticatedContext(unimportedUid).firestore()
  await assert.rejects(provisionAccount(unimportedStore, unimportedUid, { requiredLegacyDeckId: mapping.deckId }),
    (error) => error.code === 'rehearsal/import-required')
  assert.equal(await store.get(`users/${unimportedUid}`), null, 'rehearsal login before import cannot create an account')
  assert.equal(await store.get(`decks/${unimportedUid}`), null, 'rehearsal login before import cannot create a personal deck')
  const plan = prepareMigration(snapshot(), mapping)
  const source = snapshot()
  source.sha256 = snapshotDigest(source)
  const exportPath = join(privateDirectory, 'fixture-export.json')
  const mappingPath = join(privateDirectory, 'fixture-map.json')
  writeFileSync(exportPath, JSON.stringify(source), { mode: 0o600 })
  writeFileSync(mappingPath, JSON.stringify(mapping), { mode: 0o600 })
  const dryRun = await promisify(execFile)(process.execPath, ['--experimental-strip-types', 'scripts/migrate.mjs', 'import', '--export', exportPath, '--mapping', mappingPath, '--emulator'])
  const printed = dryRun.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert(printed.some((row) => row.path === 'users/uid-alice/progress/custom-1' && row.source.reps === 3 && row.before === null && row.after.reps === 3))
  assert.equal(await store.get('users/uid-alice'), null, 'the CLI dry-run prints differences and writes no account')
  assert.equal((await store.list('decks/legacy-deck/cards')).length, 0, 'the CLI dry-run writes no vocabulary')
  await runMigration(plan, store, { dryRun: false })
  assert.equal((await store.get('users/uid-alice')).migrationStatus, 'complete')
  const aliceStore = env.authenticatedContext('uid-alice').firestore()
  // Rehearsal opens only a complete legacy assignment, without provisioning writes.
  assert.deepEqual(await provisionAccount(aliceStore, 'uid-alice', { requiredLegacyDeckId: mapping.deckId }),
    { deckId: 'legacy-deck', personal: false, created: false })
  const completeAccount = await store.get('users/uid-alice')
  await store.atomic(['users/uid-alice'], () => [{ ...completeAccount, migrationStatus: 'pending' }])
  await assert.rejects(provisionAccount(aliceStore, 'uid-alice', { requiredLegacyDeckId: mapping.deckId }),
    (error) => error.code === 'rehearsal/import-required')
  assert.equal((await store.get('users/uid-alice')).migrationStatus, 'pending', 'rehearsal must not complete a pending import')
  assert.equal(await store.get('decks/uid-alice'), null, 'rehearsal must not create a personal deck')
  await store.atomic(['users/uid-alice'], () => [completeAccount])
  assert.equal(await store.get('decks/uid-alice'), null, 'import preassigns the shared deck, not a personal deck')
  const progressRef = 'users/uid-alice/progress/custom-1'
  const before = await store.get(progressRef)
  await runMigration(plan, store, { dryRun: false })
  assert.deepEqual(await store.get(progressRef), before)
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  async function cleanClient(uid) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    // A real loopback response lets Chromium classify the local address space.
    // The app entry does not run an unrelated OAuth flow in this test harness.
    await page.goto(`${base}scripts/migration-harness.html`)
    const result = await page.evaluate(async ({ uid, host }) => (await import('/scripts/migration-browser-fixture.ts')).openAccount(uid, host),
      { uid, host: process.env.FIRESTORE_EMULATOR_HOST })
    assert.equal(result, 'synced', `${uid} restores through the full #13 pull/merge/seed/push path`)
    return page
  }
  const alice = await cleanClient('uid-alice')
  const restored = await alice.evaluate(async () => {
    const db = await import('/src/db.ts')
    return { card: await db.getCard('custom-1'), deleted: await db.getCard('seed-02'), settings: await db.getSettings() }
  })
  assert.deepEqual(restored.card.srs, srs(), 'a clean second browser restores exact imported SRS')
  assert.equal(restored.deleted, undefined, 'the remote tombstone beats bundled seeding')
  assert.equal(restored.settings.direction, 'en-de')
  assert.equal(restored.settings.sessionSize, 10)
  assert.equal(restored.settings.tier, 2)
  const bob = await cleanClient('uid-bob')
  assert.equal(await bob.evaluate(async () => (await (await import('/src/db.ts')).getCard('custom-1')).srs.reps), 9)
  await assertFails(getDoc(doc(env.authenticatedContext('uid-bob').firestore(), progressRef)))

  const backupPath = join(privateDirectory, 'firestore-backup.json')
  const backup = await exportFirestore(store, backupPath)
  const backupBody = JSON.parse(readFileSync(backupPath, 'utf8'))
  assert.equal(backup.sha256, backupBody.sha256)
  assert.equal(backupBody.sha256, snapshotDigest(backupBody))
  assert.equal(backupBody.users['uid-alice'].progress['custom-1'].reps, 3)
  assert.equal(backupBody.decks[mapping.deckId].cards['seed-02'].deletedAt, 50)
  console.log('migration emulator/browser: import, clean-client #13 restore, private schedules, admin export: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  await store.close()
  await env.cleanup()
  rmSync(privateDirectory, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { assertFails } from '@firebase/rules-unit-testing'
import { doc, getDoc } from 'firebase/firestore'
import { adminStore } from './migration-admin.mjs'
import { prepareMigration, runMigration } from './migration-core.mjs'
import { mapping, snapshot, srs, card } from './migration-fixtures.mjs'
import { snapshotDigest } from './migration-files.mjs'

const env = await initializeTestEnvironment({ projectId: mapping.projectId,
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } })
const store = await adminStore(mapping.projectId, { emulator: true })
const base = 'http://127.0.0.1:4177/'
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4177', '--strictPort'], {
  stdio: 'ignore', env: { ...process.env, VITE_SYNC_BACKEND: 'firebase', VITE_FIREBASE_PROJECT_ID: mapping.projectId },
})
let browser
const privateDirectory = mkdtempSync(join(tmpdir(), 'migration-emulator-'))
try {
  await env.clearFirestore()
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
  assert.equal(await store.get('decks/uid-alice'), null, 'import preassigns the shared deck, not a personal deck')
  const progressRef = 'users/uid-alice/progress/custom-1'
  const before = await store.get(progressRef)
  await runMigration(plan, store, { dryRun: false })
  assert.deepEqual(await store.get(progressRef), before)
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(base)).ok) break } catch { /* server is starting */ }
    if (attempt === 100) throw new Error('Migration test Vite server did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
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

  // A legacy database from before per-record tracking: unsent changes must
  // acquire real Firestore markers while newer account reviews stay intact.
  const sourceCards = [card('custom-1', { srs: srs({ reps: 2, updated_at: 50 }) }),
    card('custom-offline', { de: 'offline', updated_at: 700, srs: srs({ reps: 7, updated_at: 700 }) })]
  const sourceSettings = { id: 'settings', direction: 'de-en', sessionSize: 30, tier: 3,
    deletedIds: { 'seed-01': 700 }, localRevision: 20, acknowledgedRevision: 19, settingsUpdatedAt: 700 }
  await alice.evaluate(async ({ cards, settings }) => {
    const users = await import('/src/user.ts')
    users.createUser('Alice')
    const opened = await new Promise((resolve, reject) => {
      const request = indexedDB.open(users.dbNameForUser('alice'), 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('cards', { keyPath: 'id' }); request.result.createObjectStore('settings', { keyPath: 'id' }) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = opened.transaction(['cards', 'settings'], 'readwrite')
    for (const card of cards) tx.objectStore('cards').put(card)
    tx.objectStore('settings').put(settings)
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
    opened.close()
    const panel = await import('/src/migration-panel.ts')
    document.body.innerHTML = panel.migrationPanelHtml()
    panel.bindMigrationPanel()
  }, { cards: sourceCards, settings: sourceSettings })
  await alice.locator('summary').click()
  await alice.locator('#migration-map').setInputFiles({ name: 'fixture-map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(mapping)) })
  await alice.waitForFunction(() => document.querySelector('#migration-profile').value === 'alice')
  assert(await alice.locator('#migration-copy').isDisabled(), 'explicit named-profile confirmation is required')
  await alice.locator('#migration-confirm').check()
  await alice.locator('#migration-copy').click()
  await alice.waitForFunction(() => document.querySelector('#migration-result').textContent.includes('cards and'), null, { timeout: 60000 })
  // Wait for the actual serialized sync promise. An async predicate passed to
  // waitForFunction is a truthy Promise before its status check has resolved.
  const synced = await alice.evaluate(async () => {
    const sync = await import('/src/sync.ts')
    await sync.syncNow()
    return sync.getSyncStatus().message
  })
  assert.equal(synced, 'Synced')
  assert.deepEqual(await store.get(progressRef), srs(), 'an older local schedule cannot replace the imported review')
  assert.equal((await store.get('users/uid-alice/progress/custom-offline')).reps, 7, 'the unsent local review reaches Firestore')
  assert.equal((await store.get('decks/legacy-deck/cards/seed-01')).deletedAt, 700)
  assert.equal((await store.get('users/uid-alice/settings/current')).tier, 3)
  const preserved = await alice.evaluate(async () => {
    const request = indexedDB.open('german-flashcards:alice', 1)
    const db = await new Promise((resolve) => { request.onsuccess = () => resolve(request.result) })
    const tx = db.transaction(['cards', 'settings'], 'readonly')
    const read = (request) => new Promise((resolve) => { request.onsuccess = () => resolve(request.result) })
    const [cards, settings] = await Promise.all([read(tx.objectStore('cards').getAll()), read(tx.objectStore('settings').get('settings'))])
    db.close()
    return { cards, settings }
  })
  assert.deepEqual(preserved.cards.sort((a, b) => a.id.localeCompare(b.id)), sourceCards.sort((a, b) => a.id.localeCompare(b.id)))
  assert.deepEqual(preserved.settings, sourceSettings, 'the legacy database, including unacknowledged revision, stays untouched')
  const repeat = await alice.evaluate(async ({ mapping }) => {
    const db = await import('/src/db.ts')
    const before = await db.getSettings()
    const result = await db.copyMappedLegacyProfile('alice', mapping, mapping.projectId, mapping.deckId)
    return { before, after: await db.getSettings(), result }
  }, { mapping })
  assert.equal(repeat.result.state, 'already copied')
  assert.deepEqual(repeat.after, repeat.before, 'repeat local recovery does not dirty acknowledged records')
  const secondAlice = await cleanClient('uid-alice')
  assert.equal(await secondAlice.evaluate(async () => (await (await import('/src/db.ts')).getCard('custom-offline')).srs.reps), 7)
  assert.equal(await secondAlice.evaluate(async () => (await import('/src/db.ts')).getCard('seed-01')), undefined)
  // A later importer run preserves the newer device review and settings.
  await runMigration(plan, store, { dryRun: false })
  assert.equal((await store.get('users/uid-alice/settings/current')).tier, 3)
  assert.equal((await store.get('decks/legacy-deck/cards/seed-01')).deletedAt, 700)
  const guards = await alice.evaluate(async ({ mapping }) => {
    const db = await import('/src/db.ts')
    const binding = await import('/src/study-lock.ts')
    const users = await import('/src/user.ts')
    const skipped = await db.copyMappedLegacyProfile('stranger', mapping, mapping.projectId, mapping.deckId)
    let wrong = false
    try { await db.copyMappedLegacyProfile('alice', mapping, mapping.projectId, 'wrong-deck') } catch { wrong = true }
    const before = await db.getSettings()
    const attempt = db.copyMappedLegacyProfile('alice', mapping, mapping.projectId, mapping.deckId)
    binding.bindStudyDatabase({ uid: 'uid-bob', dbName: users.accountDatabaseName('uid-bob') })
    let changed = false
    try { await attempt } catch { changed = true }
    binding.bindStudyDatabase({ uid: 'uid-alice', dbName: users.accountDatabaseName('uid-alice') })
    return { skipped, wrong, changed, before, after: await db.getSettings() }
  }, { mapping })
  assert.equal(guards.skipped.state, 'skipped')
  assert(guards.wrong && guards.changed, 'wrong decks and account changes refuse the copy')
  assert.deepEqual(guards.before, guards.after)
  console.log('migration emulator/browser: import, clean-client #13 restore, private schedules, confirmed device copy, durable markers, repeat, source preservation, account guards: ok')
} finally {
  if (browser) await browser.close()
  server.kill('SIGTERM')
  await store.close()
  await env.cleanup()
  rmSync(privateDirectory, { recursive: true, force: true })
}

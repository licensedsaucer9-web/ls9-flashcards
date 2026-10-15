import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeTestEnvironment } from '@firebase/rules-unit-testing'
import { collectionGroup, deleteDoc, doc, getDocs, setDoc } from 'firebase/firestore'
import { adminStore } from './migration-admin.mjs'
import { prepareMigration, runMigration, same } from './migration-core.mjs'
import { exportFirestore } from './migration-files.mjs'
import { mapping, snapshot } from './migration-fixtures.mjs'
import { readFirestoreBackup, runRestore } from './restore-core.mjs'

const projectId = 'demo-restore-rehearsal'
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? '', /:/, 'restore emulator test requires FIRESTORE_EMULATOR_HOST')
const directory = mkdtempSync(join(tmpdir(), 'flashcards-restore-emulator-'))
const envRules = await initializeTestEnvironment({ projectId, firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } })
const store = await adminStore(projectId, { emulator: true })
const operator = { ...process.env, GERMAN_FLASHCARDS_PRIVATE_DIR: directory }

function memoryStore() {
  const records = new Map()
  return { records, writes: 0,
    get: async (path) => structuredClone(records.get(path) ?? null),
    list: async (path) => [...records].filter(([key]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).indexOf('/') === -1)
      .map(([key, data]) => ({ id: key.split('/').at(-1), data: structuredClone(data) })),
    async atomic(paths, compute) {
      const before = paths.map((path) => structuredClone(records.get(path) ?? null))
      const after = compute(before)
      for (let index = 0; index < paths.length; index++) if (!same(before[index], after[index])) {
        records.set(paths[index], structuredClone(after[index]))
        this.writes++
      }
    },
  }
}

try {
  const source = memoryStore()
  const activityId = '00000000-0000-4000-8000-000000000058'
  const input = snapshot()
  input.users.alice.activity = { [activityId]: { at: 1790856000000, timeZone: 'Europe/Oslo' } }
  await runMigration(prepareMigration(input, mapping), source, { dryRun: false })
  const dumpPath = join(directory, 'backup.json')
  await exportFirestore(source, dumpPath)
  const plan = readFirestoreBackup(dumpPath)
  assert.equal(plan.counts.activity, 1)
  assert.equal(plan.items.find(item => item.path === `users/uid-alice/activity/${activityId}`).data.timeZone, 'Europe/Oslo')
  await envRules.clearFirestore()
  const restored = await runRestore(plan, store, { dryRun: false, projectId, reportPath: join(directory, 'emulator-apply.json') })
  assert.equal(restored.state, 'restored and verified')
  assert.equal(typeof restored.elapsedMs, 'number')
  assert(restored.elapsedMs >= 0 && restored.elapsedMs < 120000)
  for (const item of plan.items) assert(same(await store.get(item.path), item.data), item.path)
  const repeat = await runRestore(plan, store, { dryRun: false, projectId, reportPath: join(directory, 'emulator-repeat.json') })
  assert.equal(repeat.state, 'already restored')
  assert.equal((await store.list('decks/legacy-deck/cards')).length, plan.counts.cards)

  const progressPath = 'users/uid-alice/progress/custom-1'
  const current = await store.get(progressPath)
  await store.atomic([progressPath], () => [{ ...current, reps: current.reps + 1, updated_at: current.updated_at + 1 }])
  const kept = await store.get(progressPath)
  const refused = await runRestore(plan, store, { dryRun: false, projectId, reportPath: join(directory, 'emulator-newer.json') })
  assert.equal(refused.state, 'refused')
  assert.equal(refused.newer, 1)
  assert(same(await store.get(progressPath), kept), 'emulator restore left the newer review in place')

  await envRules.clearFirestore()
  const interrupted = await adminStore(projectId, { emulator: true })
  const atomic = interrupted.atomic.bind(interrupted)
  let calls = 0
  interrupted.atomic = async (...args) => { if (++calls === 2) throw new Error('interrupted'); return atomic(...args) }
  await assert.rejects(runRestore(plan, interrupted, { dryRun: false, projectId, reportPath: join(directory, 'emulator-partial.json') }), /interrupted/)
  interrupted.atomic = atomic
  const resumed = await runRestore(plan, interrupted, { dryRun: false, projectId, reportPath: join(directory, 'emulator-resume.json') })
  assert.equal(resumed.state, 'restored and verified')
  for (const item of plan.items) assert(same(await interrupted.get(item.path), item.data), item.path)
  assert.equal((await interrupted.list('decks/legacy-deck/cards')).length, plan.counts.cards)
  await interrupted.close()

  await envRules.clearFirestore()
  writeFileSync(join(directory, 'service-account.json'), JSON.stringify({ project_id: projectId }), { mode: 0o600 })
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.mjs', 'restore',
    '--dump', dumpPath, '--project', projectId, '--credential', 'service-account.json',
    '--report', join(directory, 'cli-apply.json'), '--emulator', '--apply'], { encoding: 'utf8', env: operator })
  const summary = JSON.parse(stdout)
  assert.equal(summary.state, 'restored and verified')
  assert.equal(summary.tombstones, 1)
  assert.equal(typeof summary.elapsedMs, 'number')
  assert.equal(stdout.includes('uid-alice'), false)
  assert.equal(stdout.includes('Hund'), false)
  assert.equal(stdout.includes('dog'), false)
  const again = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.mjs', 'restore',
    '--dump', dumpPath, '--project', projectId, '--credential', 'service-account.json',
    '--report', join(directory, 'cli-repeat.json'), '--emulator', '--apply'], { encoding: 'utf8', env: operator })
  assert.equal(JSON.parse(again).state, 'already restored')

  await envRules.clearFirestore()
  const orphanUid = 'uid-orphan'
  const orphanProgressPath = `users/${orphanUid}/progress/custom-9`
  const orphanProgress = { ease: 2.5, interval: 1, reps: 4, due: 5000, updated_at: 9_000_000_000_000 }
  await envRules.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'users', orphanUid), { deckId: 'orphan-deck', schemaVersion: 1, migrationStatus: 'new' })
    await setDoc(doc(db, 'users', orphanUid, 'progress', 'custom-9'), orphanProgress)
    await deleteDoc(doc(db, 'users', orphanUid))
  })
  assert.equal(await store.get(`users/${orphanUid}`), null)
  assert.equal((await store.list('users')).length, 0)
  assert(same(await store.get(orphanProgressPath), orphanProgress))
  const countedAtomic = store.atomic.bind(store)
  let writes = 0
  store.atomic = async (...args) => { writes += 1; return countedAtomic(...args) }
  try {
    const dry = await runRestore(plan, store, { projectId, reportPath: join(directory, 'orphan-dry.json') })
    assert.equal(dry.state, 'refused')
    assert.equal(dry.extras, 1)
    assert.equal(writes, 0)
    const applied = await runRestore(plan, store, { dryRun: false, projectId, reportPath: join(directory, 'orphan-apply.json') })
    assert.equal(applied.state, 'refused')
    assert.equal(applied.extras, 1)
    assert.equal(writes, 0)
    const repeat = await runRestore(plan, store, { dryRun: false, projectId, reportPath: join(directory, 'orphan-repeat.json') })
    assert.equal(repeat.state, 'refused')
  } finally {
    store.atomic = countedAtomic
  }
  assert.equal(await store.get('users/uid-alice'), null)
  assert.equal(await store.get('decks/legacy-deck'), null)
  assert(same(await store.get(orphanProgressPath), orphanProgress))
  await envRules.withSecurityRulesDisabled(async (ctx) => {
    const rows = await getDocs(collectionGroup(ctx.firestore(), 'progress'))
    assert.equal(rows.size, 1)
    assert.equal(rows.docs[0].ref.path, orphanProgressPath)
  })
  console.log(`restore emulator: state=${summary.state} cards=${summary.cards} tombstones=${summary.tombstones} elapsedMs=${summary.elapsedMs} sha256=${summary.sha256}`)
} finally {
  await store.close()
  await envRules.cleanup()
  rmSync(directory, { recursive: true, force: true })
}

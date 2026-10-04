import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareMigration, runMigration, same } from './migration-core.mjs'
import { exportFirestore, snapshotDigest } from './migration-files.mjs'
import { mapping, snapshot } from './migration-fixtures.mjs'
import { prepareRestore, publicRestoreSummary, readFirestoreBackup, runRestore } from './restore-core.mjs'

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

function saved(store) {
  return JSON.stringify([...store.records].sort(([left], [right]) => left.localeCompare(right)))
}

function copyStore(source) {
  const store = memoryStore()
  for (const [key, value] of source.records) store.records.set(key, structuredClone(value))
  return store
}

function resign(body) {
  body.sha256 = snapshotDigest(body)
  return body
}

const directory = mkdtempSync(join(tmpdir(), 'flashcards-restore-'))
const projectId = 'demo-restore-rehearsal'
try {
  const source = memoryStore()
  await runMigration(prepareMigration(snapshot(), mapping), source, { dryRun: false })
  const dumpPath = join(directory, 'backup.json')
  const exported = await exportFirestore(source, dumpPath)
  const plan = readFirestoreBackup(dumpPath)
  assert.equal(plan.sha256, exported.sha256)
  assert.equal(plan.counts.tombstones, 1)
  assert.equal(plan.counts.users, 2)
  assert.equal(plan.items.some((item) => item.path === 'decks/legacy-deck/cards/seed-02' && item.data.deletedAt === 50), true)

  const target = memoryStore()
  const dry = await runRestore(plan, target, { projectId, reportPath: join(directory, 'dry.json') })
  assert.equal(dry.state, 'dry-run')
  assert.equal(dry.creates, plan.items.length)
  assert.equal(dry.conflicts, 0)
  assert.equal(target.writes, 0)
  assert.equal(JSON.stringify(publicRestoreSummary(dry)).includes('uid-alice'), false)
  assert.equal(JSON.stringify(publicRestoreSummary(dry)).includes('Hund'), false)
  assert.equal(Object.hasOwn(publicRestoreSummary(dry), 'documents'), false)
  const dryReport = JSON.parse(readFileSync(join(directory, 'dry.json'), 'utf8'))
  assert.equal(dryReport.kind, 'firestore-restore-report')
  assert.equal(statSync(join(directory, 'dry.json')).mode & 0o777, 0o600)
  assert.equal(dryReport.documents.some((row) => row.path === 'users/uid-alice'), true)

  const restored = await runRestore(plan, target, { dryRun: false, projectId, reportPath: join(directory, 'apply.json') })
  assert.equal(restored.state, 'restored and verified')
  assert.equal(typeof restored.elapsedMs, 'number')
  assert.equal(saved(target), saved(source))
  const writes = target.writes
  const repeat = await runRestore(plan, target, { dryRun: false, projectId, reportPath: join(directory, 'repeat.json') })
  assert.equal(repeat.state, 'already restored')
  assert.equal(repeat.creates, 0)
  assert.equal(target.writes, writes, 'an unchanged repeat adds no documents')

  target.records.clear()
  const cleared = await runRestore(plan, target, { dryRun: false, projectId, reportPath: join(directory, 'cleared.json') })
  assert.equal(cleared.state, 'restored and verified')
  assert.equal(saved(target), saved(source), 'a cleared target round-trips every id, field, clock, and membership')

  const newer = copyStore(target)
  const progressPath = 'users/uid-alice/progress/custom-1'
  newer.records.set(progressPath, { ...newer.records.get(progressPath), reps: 80, updated_at: 900 })
  const beforeNewer = saved(newer)
  const newerWrites = newer.writes
  const refusedNewer = await runRestore(plan, newer, { dryRun: false, projectId, reportPath: join(directory, 'newer.json') })
  assert.equal(refusedNewer.state, 'refused')
  assert.equal(refusedNewer.newer, 1)
  assert.equal(newer.writes, newerWrites)
  assert.equal(saved(newer), beforeNewer, 'newer study is not reset')

  const older = copyStore(target)
  older.records.set(progressPath, { ...older.records.get(progressPath), reps: 1, updated_at: 1 })
  const beforeOlder = saved(older)
  const refusedOlder = await runRestore(plan, older, { dryRun: false, projectId, reportPath: join(directory, 'older.json') })
  assert.equal(refusedOlder.state, 'refused')
  assert.equal(refusedOlder.conflicts, 1)
  assert.equal(saved(older), beforeOlder, 'an older conflicting schedule is not overwritten')

  const extra = copyStore(target)
  extra.records.set('decks/legacy-deck/cards/extra-card', { ...target.records.get('decks/legacy-deck/cards/custom-1'), de: 'Zusatz' })
  const beforeExtra = saved(extra)
  const refusedExtra = await runRestore(plan, extra, { dryRun: true, projectId, reportPath: join(directory, 'extra.json') })
  assert.equal(refusedExtra.state, 'refused')
  assert.equal(refusedExtra.extras, 1)
  assert.equal(extra.writes, 0)
  assert.equal(saved(extra), beforeExtra)

  const interrupted = memoryStore()
  const atomic = interrupted.atomic.bind(interrupted)
  let calls = 0
  interrupted.atomic = async (...args) => { if (++calls === 2) throw new Error('interrupted'); return atomic(...args) }
  await assert.rejects(runRestore(plan, interrupted, { dryRun: false, projectId, reportPath: join(directory, 'partial.json') }), /interrupted/)
  assert.equal(JSON.parse(readFileSync(join(directory, 'partial.json'), 'utf8')).state, 'interrupted')
  assert(interrupted.records.size > 0 && interrupted.records.size < source.records.size)
  interrupted.atomic = atomic
  await runRestore(plan, interrupted, { dryRun: false, projectId, reportPath: join(directory, 'resume.json') })
  assert.equal(saved(interrupted), saved(source), 'resume finishes the missing documents without duplicates')

  const raced = memoryStore()
  const racedAtomic = raced.atomic.bind(raced)
  raced.atomic = async (paths, compute) => {
    if (paths[0] === progressPath) raced.records.set(progressPath, { ease: 2.5, interval: 1, reps: 4, due: 50, updated_at: 50 })
    return racedAtomic(paths, compute)
  }
  await assert.rejects(runRestore(plan, raced, { dryRun: false, projectId, reportPath: join(directory, 'race.json') }), /refusing to overwrite/)
  assert.equal(raced.records.get(progressPath).reps, 4)

  const broken = memoryStore()
  const read = broken.get.bind(broken)
  const brokenAtomic = broken.atomic.bind(broken)
  let armed = false
  broken.atomic = async (...args) => { const written = await brokenAtomic(...args); armed = true; return written }
  broken.get = async (path) => armed && path === progressPath ? null : read(path)
  await assert.rejects(runRestore(plan, broken, { dryRun: false, projectId, reportPath: join(directory, 'readback.json') }), /Readback verification failed/)
  broken.get = read
  const repaired = await runRestore(plan, broken, { dryRun: false, projectId, reportPath: join(directory, 'readback-resume.json') })
  assert.equal(repaired.state, 'already restored')
  assert.equal(saved(broken), saved(source))

  const parsed = JSON.parse(readFileSync(dumpPath, 'utf8'))
  parsed.users['uid-alice'].progress['custom-1'].reps = 2
  assert.throws(() => prepareRestore(parsed), /checksum/)
  const missingClock = structuredClone(JSON.parse(readFileSync(dumpPath, 'utf8')))
  delete missingClock.decks['legacy-deck'].cards['seed-02'].deletedAt
  assert.throws(() => prepareRestore(resign(missingClock)), /invalid card/)
  const extraField = structuredClone(JSON.parse(readFileSync(dumpPath, 'utf8')))
  extraField.decks['legacy-deck'].cards['custom-1'].note = 'nope'
  assert.throws(() => prepareRestore(resign(extraField)), /invalid card/)
  const orphan = structuredClone(JSON.parse(readFileSync(dumpPath, 'utf8')))
  orphan.decks['legacy-deck'].deck.memberUids = ['uid-alice']
  assert.throws(() => prepareRestore(resign(orphan)), /uid-bob is not a member/)
  const github = snapshot()
  github.sha256 = snapshotDigest(github)
  assert.throws(() => prepareRestore(github), /GitHub snapshot/)
  const truncated = join(directory, 'truncated.json')
  writeFileSync(truncated, '{"kind":"firestore"', { mode: 0o600 })
  assert.throws(() => readFirestoreBackup(truncated), /truncated/)
  const absentSettings = structuredClone(JSON.parse(readFileSync(dumpPath, 'utf8')))
  absentSettings.users['uid-bob'].settings = null
  const absentPlan = prepareRestore(resign(absentSettings))
  assert.equal(absentPlan.items.some((item) => item.path === 'users/uid-bob/settings/current'), false)
  const absentTarget = memoryStore()
  await runRestore(absentPlan, absentTarget, { dryRun: false, projectId, reportPath: join(directory, 'absent-settings.json') })
  assert.equal(absentTarget.records.has('users/uid-bob/settings/current'), false)
  assert.equal(absentTarget.records.get('users/uid-bob').deckId, 'legacy-deck')

  const env = { ...process.env, GERMAN_FLASHCARDS_PRIVATE_DIR: directory }
  delete env.FIRESTORE_EMULATOR_HOST
  const badPath = join(directory, 'bad-checksum.json')
  const badBody = JSON.parse(readFileSync(dumpPath, 'utf8'))
  badBody.sha256 = '0'.repeat(64)
  writeFileSync(badPath, JSON.stringify(badBody), { mode: 0o600 })
  writeFileSync(join(directory, 'service-account.json'), JSON.stringify({ project_id: projectId }), { mode: 0o600 })
  writeFileSync(join(directory, 'wrong-account.json'), JSON.stringify({ project_id: 'demo-other-project' }), { mode: 0o600 })
  const cli = (args) => {
    try {
      const stdout = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.mjs', ...args], {
        encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      return { status: error.status ?? 1, stdout: `${error.stdout ?? ''}`, stderr: `${error.stderr ?? ''}` }
    }
  }
  const badDigest = cli(['restore', '--dump', badPath, '--project', projectId, '--credential', 'missing.json', '--report', join(directory, 'unused.json')])
  assert.notEqual(badDigest.status, 0)
  assert.match(`${badDigest.stderr}`, /checksum/)
  assert.equal(statSafe(join(directory, 'unused.json')), null)
  const wrongProject = cli(['restore', '--dump', dumpPath, '--project', projectId, '--credential', 'wrong-account.json', '--report', join(directory, 'unused.json')])
  assert.match(wrongProject.stderr, /does not match/)
  const live = cli(['restore', '--dump', dumpPath, '--project', 'flashcards-ls9-auth-test', '--credential', 'service-account.json', '--report', join(directory, 'unused.json')])
  assert.match(live.stderr, /not an isolated restore target/)
  const production = cli(['restore', '--dump', dumpPath, '--project', 'flashcards-ls9-prod', '--credential', 'service-account.json', '--report', join(directory, 'unused.json')])
  assert.match(production.stderr, /not an isolated restore target/)
  const insideGit = join(process.cwd(), 'restore-report.json')
  const leaked = cli(['restore', '--dump', dumpPath, '--project', projectId, '--credential', 'service-account.json', '--report', insideGit])
  assert.match(leaked.stderr, /outside Git/)
  assert.equal(statSafe(insideGit), null)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

function statSafe(path) {
  try { return statSync(path) } catch { return null }
}

console.log('restore: checksum, schema, assignment, dry-run, exact round trip, newer/older/extra refusal, interrupt/resume, cleared target, credential pairing: ok')

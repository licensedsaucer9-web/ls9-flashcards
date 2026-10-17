import { starterCards, starterDeckId } from '../src/starter-decks.ts'
import { cardToDoc, progressToDoc } from '../src/firestore-docs.ts'
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
    listDocumentIds: async (collection) => {
      const prefix = `${collection}/`
      const ids = new Set()
      for (const key of records.keys()) {
        if (!key.startsWith(prefix)) continue
        const id = key.slice(prefix.length).split('/')[0]
        if (id) ids.add(id)
      }
      return [...ids]
    },
    listSubcollections: async (docPath) => {
      const prefix = `${docPath}/`
      const names = new Set()
      for (const key of records.keys()) {
        if (!key.startsWith(prefix)) continue
        const [name, documentId] = key.slice(prefix.length).split('/')
        if (name && documentId) names.add(name)
      }
      return [...names]
    },
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
  const activityId = '00000000-0000-4000-8000-000000000058'
  const input = snapshot()
  input.users.alice.activity = { [activityId]: { at: 1790856000000, timeZone: 'Europe/Oslo' } }
  await runMigration(prepareMigration(input, mapping), source, { dryRun: false })
  const dumpPath = join(directory, 'backup.json')
  const exported = await exportFirestore(source, dumpPath)
  const plan = readFirestoreBackup(dumpPath)
  const legacy = JSON.parse(readFileSync(dumpPath, 'utf8'))
  legacy.version = 1
  for (const user of Object.values(legacy.users)) { delete user.decks; delete user.activity }
  const legacyPlan = prepareRestore(resign(legacy))
  const legacyTarget = memoryStore()
  assert.equal((await runRestore(legacyPlan, legacyTarget, { dryRun: false, projectId })).state, 'restored and verified')
  assert.equal(legacyPlan.counts.decks, 1)
  assert.equal(legacyPlan.counts.activity, 0)
  for (const item of legacyPlan.items) assert.deepEqual(legacyTarget.records.get(item.path), source.records.get(item.path))

  assert.equal(plan.counts.activity, 1)
  assert.equal(plan.items.find(item => item.path === `users/uid-alice/activity/${activityId}`).data.timeZone, 'Europe/Oslo')
  const multiDump = JSON.parse(readFileSync(dumpPath, 'utf8'))
  const extraId = '00000000-0000-4000-8000-000000000074'
  multiDump.decks[extraId] = {
    deck: { ownerUid: 'uid-alice', memberUids: ['uid-alice'] },
    cards: structuredClone(multiDump.decks['legacy-deck'].cards),
  }
  multiDump.users['uid-alice'].decks[extraId] = {
    settings: { ...multiDump.users['uid-alice'].settings, wordTypes: ['verb'] },
    progress: structuredClone(multiDump.users['uid-alice'].progress),
  }
  const multiPlan = prepareRestore(resign(multiDump))
  const multiTarget = memoryStore()
  assert.equal((await runRestore(multiPlan, multiTarget, { dryRun: false, projectId })).state, 'restored and verified')
  assert.equal(multiPlan.counts.decks, 2)
  for (const item of multiPlan.items) assert.deepEqual(multiTarget.records.get(item.path), item.data)
  assert.equal((await runRestore(multiPlan, multiTarget, { dryRun: false, projectId })).state, 'already restored')
  // Actual language-deck documents pass the supported v2 exporter and guarded restore.
  const languageSource = copyStore(multiTarget)
  for (const lang of ['fr', 'es']) {
    const deckId = await starterDeckId('uid-alice', lang)
    const cards = starterCards(lang)
    languageSource.records.set(`decks/${deckId}`, { ownerUid: 'uid-alice', memberUids: ['uid-alice'] })
    languageSource.records.set(`users/uid-alice/decks/${deckId}/settings/current`, { direction: 'en-de', sessionSize: 7, tier: 2, wordTypes: ['noun'], settingsUpdatedAt: 17 })
    for (const card of cards) languageSource.records.set(`decks/${deckId}/cards/${card.id}`, cardToDoc(card, card.id === cards[1].id ? 123 : 0))
    languageSource.records.set(`users/uid-alice/decks/${deckId}/progress/${cards[0].id}`, progressToDoc({ ...cards[0].srs, reps: 2, interval: 3, due: 900, updated_at: 100 }))
  }
  const languageDump = join(directory, 'language-backup.json')
  await exportFirestore(languageSource, languageDump)
  const languagePlan = readFirestoreBackup(languageDump)
  const languageTarget = memoryStore()
  assert.equal((await runRestore(languagePlan, languageTarget, { dryRun: false, projectId })).state, 'restored and verified')
  assert.equal(languagePlan.counts.decks, 4)
  assert.equal(saved(languageTarget), saved(languageSource), 'exact starter content, Unicode, schedules, settings, tombstones and ownership restored')
  assert.equal((await runRestore(languagePlan, languageTarget, { dryRun: false, projectId })).state, 'already restored')
  const invalidOwner = structuredClone(multiDump)
  invalidOwner.decks[extraId].deck.ownerUid = 'uid-bob'
  assert.throws(() => prepareRestore(resign(invalidOwner)), /invalid user deck/)
  const missingDeck = structuredClone(multiDump)
  delete missingDeck.decks[extraId]
  assert.throws(() => prepareRestore(resign(missingDeck)), /invalid user deck/)
  const invalidSettings = structuredClone(multiDump)
  invalidSettings.users['uid-alice'].decks[extraId].settings.wordTypes = ['nope']
  assert.throws(() => prepareRestore(resign(invalidSettings)), /invalid settings/)
  const invalidProgress = structuredClone(multiDump)
  delete invalidProgress.users['uid-alice'].decks[extraId].progress['custom-1'].due
  assert.throws(() => prepareRestore(resign(invalidProgress)), /invalid progress/)
  const corrupt = JSON.parse(readFileSync(dumpPath, 'utf8'))
  for (const [index, timeZone] of ['Not/AZone', 'UTC+1'].entries()) {
    corrupt.users['uid-alice'].activity[`00000000-0000-4000-8000-00000000006${index}`] = { at: 1790856000000, timeZone }
  }
  corrupt.users['uid-alice'].activity['bad-id'] = { at: 1790856000000, timeZone: 'UTC' }
  const tolerantPlan = prepareRestore(resign(corrupt))
  assert.equal(tolerantPlan.counts.skippedActivity, 3)
  assert.deepEqual(tolerantPlan.items, plan.items)
  const tolerantTarget = memoryStore()
  const tolerantResult = await runRestore(tolerantPlan, tolerantTarget, {
    dryRun: false, projectId, reportPath: join(directory, 'skipped.json'),
  })
  assert.equal(tolerantResult.state, 'restored and verified')
  assert.equal(saved(tolerantTarget), saved(source))
  assert.equal(publicRestoreSummary(tolerantResult).skippedActivity, 3)
  assert.equal(JSON.parse(readFileSync(join(directory, 'skipped.json'), 'utf8')).skippedActivity, 3)
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

  const orphanProgress = { ease: 2.5, interval: 1, reps: 4, due: 5000, updated_at: 9_000_000_000_000 }
  const orphaned = memoryStore()
  orphaned.records.set('users/uid-orphan', { deckId: 'orphan-deck', schemaVersion: 1, migrationStatus: 'new' })
  orphaned.records.set('users/uid-orphan/progress/custom-9', orphanProgress)
  orphaned.records.delete('users/uid-orphan')
  assert.equal(await orphaned.get('users/uid-orphan'), null)
  assert.equal((await orphaned.list('users')).length, 0)
  assert.deepEqual(await orphaned.get('users/uid-orphan/progress/custom-9'), orphanProgress)
  const beforeOrphan = saved(orphaned)
  const dryOrphan = await runRestore(plan, orphaned, { projectId, reportPath: join(directory, 'orphan-dry.json') })
  assert.equal(dryOrphan.state, 'refused')
  assert.equal(dryOrphan.extras, 1)
  assert.equal(JSON.stringify(publicRestoreSummary(dryOrphan)).includes('uid-orphan'), false)
  assert.equal(orphaned.writes, 0)
  assert.equal(saved(orphaned), beforeOrphan)
  const applyOrphan = await runRestore(plan, orphaned, { dryRun: false, projectId, reportPath: join(directory, 'orphan-apply.json') })
  assert.equal(applyOrphan.state, 'refused')
  assert.equal(applyOrphan.extras, 1)
  assert.equal(orphaned.writes, 0)
  assert.equal(saved(orphaned), beforeOrphan)
  assert.equal(orphaned.records.size, 1)
  const repeatOrphan = await runRestore(plan, orphaned, { dryRun: false, projectId, reportPath: join(directory, 'orphan-repeat.json') })
  assert.equal(repeatOrphan.state, 'refused')

  const deckOrphan = memoryStore()
  deckOrphan.records.set('decks/orphan-deck/cards/extra-1', { de: 'Zusatz' })
  assert.equal((await deckOrphan.list('decks')).length, 0)
  const beforeDeck = saved(deckOrphan)
  const refusedDeck = await runRestore(plan, deckOrphan, { dryRun: false, projectId, reportPath: join(directory, 'orphan-deck.json') })
  assert.equal(refusedDeck.state, 'refused')
  assert.equal(refusedDeck.extras, 1)
  assert.equal(deckOrphan.writes, 0)
  assert.equal(saved(deckOrphan), beforeDeck)
  assert.equal(deckOrphan.records.has('decks/legacy-deck'), false)

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
  const dumpBody = () => structuredClone(JSON.parse(readFileSync(dumpPath, 'utf8')))
  assert(dumpBody().users['uid-alice'].settings, 'fixture has settings')
  assert.equal(Object.hasOwn(dumpBody().users['uid-alice'].settings, 'wordTypes'), false)
  for (const wordTypes of [[], ['verb'], ['adj', 'noun'], ['noun', 'verb', 'adj']]) {
    const typed = dumpBody()
    typed.users['uid-alice'].settings.wordTypes = wordTypes
    const typedPlan = prepareRestore(resign(typed))
    const item = typedPlan.items.find((entry) => entry.path === 'users/uid-alice/settings/current')
    assert.deepEqual(item.data.wordTypes, wordTypes)
    const typedTarget = memoryStore()
    await runRestore(typedPlan, typedTarget, { dryRun: false, projectId, reportPath: join(directory, `typed-${wordTypes.join('-') || 'empty'}.json`) })
    assert.deepEqual(typedTarget.records.get('users/uid-alice/settings/current').wordTypes, wordTypes)
  }
  for (const wordTypes of [['adverb'], ['noun', 'nope'], ['Noun'], ['adjective'], 'noun', null, {}, ['noun', 'noun'],
    ['noun', 'verb', 'adj', 'noun']]) {
    const bad = dumpBody()
    bad.users['uid-alice'].settings.wordTypes = wordTypes
    assert.throws(() => prepareRestore(resign(bad)), /invalid settings uid-alice/)
  }
  const extraSetting = dumpBody()
  extraSetting.users['uid-alice'].settings.theme = 'dark'
  assert.throws(() => prepareRestore(resign(extraSetting)), /invalid settings uid-alice/)
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

console.log('restore: checksum, schema, optional wordTypes, assignment, dry-run, exact round trip, newer/older/extra refusal, deleted-parent subcollections, interrupt/resume, cleared target, credential pairing: ok')

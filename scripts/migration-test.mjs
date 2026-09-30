import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareMigration, runMigration, same } from './migration-core.mjs'
import { exportRepository, privatePath, readExport, snapshotDigest } from './migration-files.mjs'
import { mapping, snapshot, card, srs, user } from './migration-fixtures.mjs'

function memoryStore() {
  const records = new Map()
  return { records, writes: 0,
    get: async (path) => structuredClone(records.get(path) ?? null),
    list: async (path) => [...records].filter(([key]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).indexOf('/') === -1)
      .map(([key, data]) => ({ id: key.split('/').at(-1), data: structuredClone(data) })),
    async atomic(paths, compute) {
      const before = paths.map((path) => structuredClone(records.get(path) ?? null))
      const after = compute(before)
      for (let index = 0; index < paths.length; index++) if (!same(before[index], after[index])) { records.set(paths[index], structuredClone(after[index])); this.writes++ }
    },
  }
}

const source = snapshot()
const plan = prepareMigration(source, mapping)
assert.deepEqual(plan.files.skipped, ['stranger'])
assert.throws(() => prepareMigration(source, null), /mapping/)
assert.throws(() => prepareMigration(source, { ...mapping, profiles: { ...mapping.profiles, missing: 'uid-missing' } }), /no source data/)
assert.throws(() => prepareMigration(source, { ...mapping, profiles: { guest: 'uid-guest' } }), /guest/)
assert.throws(() => prepareMigration(source, { ...mapping, profiles: { alice: 'same', bob: 'same' } }), /duplicate/)
assert.throws(() => prepareMigration(snapshot({ deck: { ...source.deck, cards: [...source.deck.cards, source.deck.cards[0]] } }), mapping), /duplicate/)
assert.throws(() => prepareMigration(snapshot({ users: { ...source.users, alice: user('alice', { progress: { 'custom-1': srs({ ease: -1 }) } }) } }), mapping), /ease/)

const store = memoryStore()
const reports = []
const dry = await runMigration(plan, store, { report: (row) => reports.push(row) })
assert(dry.dryRun && dry.writes > 0 && store.writes === 0)
assert(reports.some((row) => row.path === 'users/uid-alice/progress/custom-1' && row.source.reps === 3 && row.before === null && row.after.reps === 3))
const first = await runMigration(plan, store, { dryRun: false })
assert.equal(first.state, 'imported and verified')
assert.equal(store.records.get('users/uid-alice').migrationStatus, 'complete')
assert.equal(store.records.get('users/uid-bob/progress/custom-1').reps, 9)
assert.equal(store.records.get('decks/legacy-deck/cards/seed-02').deletedAt, 50)
const writes = store.writes
assert.equal((await runMigration(plan, store, { dryRun: false })).state, 'already imported')
assert.equal(store.writes, writes, 'a repeat run performs no writes, including account status')

store.records.set('users/uid-alice/progress/custom-1', srs({ updated_at: 900, reps: 50, due: 9000 }))
store.records.set('users/uid-alice/settings/current', { direction: 'de-en', sessionSize: 30, tier: 3, settingsUpdatedAt: 900 })
store.records.set('decks/legacy-deck/cards/custom-1', { ...store.records.get('decks/legacy-deck/cards/custom-1'), de: 'Katze', updated_at: 900 })
const beforeNewer = store.writes
await runMigration(plan, store, { dryRun: false })
assert.equal(store.writes, beforeNewer)
assert.equal(store.records.get('users/uid-alice/progress/custom-1').reps, 50)
assert.equal(store.records.get('decks/legacy-deck/cards/custom-1').de, 'Katze')

const interrupted = memoryStore()
const atomic = interrupted.atomic.bind(interrupted)
let calls = 0
interrupted.atomic = async (...args) => { if (++calls === 4) throw new Error('interrupted'); return atomic(...args) }
await assert.rejects(runMigration(plan, interrupted, { dryRun: false }), /interrupted/)
assert.equal(interrupted.records.get('users/uid-alice').migrationStatus, 'pending')
interrupted.atomic = atomic
await runMigration(plan, interrupted, { dryRun: false })
assert.equal(interrupted.records.get('users/uid-alice').migrationStatus, 'complete')

const wrongAccount = memoryStore()
wrongAccount.records.set('users/uid-alice', { deckId: 'uid-alice', schemaVersion: 1, migrationStatus: 'new' })
await assert.rejects(runMigration(plan, wrongAccount, { dryRun: false }), /refusing to reassign/)
assert.equal(wrongAccount.writes, 0)

const brokenReadback = memoryStore()
const read = brokenReadback.get
const readbackAtomic = brokenReadback.atomic.bind(brokenReadback)
let damage = false
brokenReadback.atomic = async (paths, compute) => { await readbackAtomic(paths, compute); if (paths[0].includes('/settings/')) damage = true }
brokenReadback.get = async (path) => damage && path.endsWith('/progress/custom-1') ? null : read(path)
await assert.rejects(runMigration(plan, brokenReadback, { dryRun: false }), /verification failed/)
assert.equal(brokenReadback.records.get('users/uid-alice').migrationStatus, 'pending')

const v1 = snapshot({ deck: { version: 1, updated_at: 80, settings: { direction: 'en-de', sessionSize: 15 },
  cards: [card('custom-1', { srs: srs({ updated_at: undefined, reps: 4 }) })], deleted_ids: { 'seed-02': 50 } },
  users: { bob: user('bob') } })
assert.throws(() => prepareMigration(v1, mapping), /v1Profile/)
const legacy = prepareMigration(v1, { ...mapping, v1Profile: 'alice' })
assert.equal(legacy.files.users.alice.progress['custom-1'].reps, 4)
assert.equal(legacy.files.users.alice.settings_updated_at, 80)
assert.equal(legacy.files.users.bob.progress['custom-1'].reps, 3)
await runMigration(legacy, memoryStore(), { dryRun: false })

const directory = mkdtempSync(join(tmpdir(), 'flashcards-migration-'))
try {
  const repo = join(directory, 'data-repo')
  mkdirSync(join(repo, 'users'), { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  git('init')
  writeFileSync(join(repo, 'data.json'), JSON.stringify(source.deck))
  writeFileSync(join(repo, 'users/alice.json'), JSON.stringify(source.users.alice))
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture')
  const output = join(directory, 'private/export.json')
  const exported = exportRepository(repo, 'HEAD', output)
  assert.match(exported.commit, /^[a-f0-9]{40}$/)
  assert.equal(statSync(output).mode & 0o777, 0o600)
  const parsed = readExport(output)
  assert.deepEqual(parsed.deck, source.deck)
  assert.equal(parsed.sha256, snapshotDigest(parsed))
  writeFileSync(join(repo, 'data.json'), '{}')
  const second = join(directory, 'private/second.json')
  exportRepository(repo, exported.commit, second)
  assert.deepEqual(readExport(second).deck, source.deck, 'export ignores uncommitted local changes')
  assert.throws(() => privatePath(join(repo, 'private/export.json')), /outside Git/)
  assert.throws(() => exportRepository(repo, 'HEAD', output), /already exists/)
  const corrupted = JSON.parse(readFileSync(output))
  corrupted.deck.cards[0].de = 'changed'
  writeFileSync(output, JSON.stringify(corrupted))
  assert.throws(() => readExport(output), /checksum/)
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('migration: dry-run, exact readback, resume, v1/v2, two profiles, unmapped names, newer server values, private commit export: ok')

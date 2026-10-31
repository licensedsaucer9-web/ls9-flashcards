import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupCounts, cliStore, expiredBackups, firestoreValue, runBackup } from './firestore-backup.mjs'

assert.equal(firestoreValue({ integerValue: '1' }), 1)
assert.equal(firestoreValue({ stringValue: 'de-en' }), 'de-en')
assert.deepEqual(firestoreValue({ mapValue: { fields: { tier: { integerValue: '1' } } } }), { tier: 1 })
assert.deepEqual(firestoreValue({ arrayValue: { values: [{ stringValue: 'a' }] } }), ['a'])
assert.throws(() => firestoreValue({ timestampValue: '2026-10-07T00:00:00Z' }), /Unsupported Firestore value/)

const counts = backupCounts({
  users: { accountA: { progress: { one: {} }, settings: { tier: 1 } } },
  decks: { deckA: { cards: { one: { deletedAt: 0 }, gone: { deletedAt: 3 } } } },
})
assert.deepEqual(counts, { users: 1, decks: 1, cards: 2, progress: 1, settings: 1, tombstones: 1, activity: 0 })
assert.equal(JSON.stringify(counts).includes('accountA'), false)

const dumps = Array.from({ length: 15 }, (_, index) => `firestore-20261007T${String(index).padStart(6, '0')}Z.json`)
assert.deepEqual(expiredBackups(dumps, 14), ['firestore-20261007T000000Z.json'])
assert.deepEqual(expiredBackups([...dumps, 'notes.txt'], 14), ['firestore-20261007T000000Z.json'])

// Restorable documents: the backup job now refuses a dump that restore would reject.
const SETTINGS = { direction: 'de-en', sessionSize: 20, tier: 1, settingsUpdatedAt: 1 }
const PROGRESS = (updated) => ({ ease: 2.5, interval: 1, reps: 1, due: 5, updated_at: updated })
const CARD = (deletedAt) => ({ de: 'Hund', en: 'dog', article: 'der', example_de: '', example_en: '', tags: [],
  created_at: 1, updated_at: 1, deletedAt })

const directory = mkdtempSync(join(tmpdir(), 'firestore-backup-'))
try {
  const store = {
    get: async (path) => path.endsWith('/settings/current') ? SETTINGS : null,
    list: async (path) => {
      if (path === 'users') return [{ id: 'accountA', data: { deckId: 'deckA', schemaVersion: 1, migrationStatus: 'new' } }]
      if (path === 'users/accountA/activity') return [{ id: '00000000-0000-4000-8000-000000000058', data: { at: 1790856000000, timeZone: 'Europe/Oslo' } }]
      if (path === 'users/accountA/progress') return [{ id: 'one', data: PROGRESS(1) }]
      if (path === 'decks') return [{ id: 'deckA', data: { memberUids: ['accountA'] } },
        { id: 'extra-deck', data: { ownerUid: 'accountA', memberUids: ['accountA'] } }]
      if (path === 'users/accountA/decks/extra-deck/progress') return [{ id: 'one', data: PROGRESS(2) }]
      if (path === 'decks/extra-deck/cards') return [{ id: 'one', data: CARD(0) }]
      if (path === 'decks/deckA/cards') return [{ id: 'one', data: CARD(0) }, { id: 'gone', data: CARD(3) }]
      return []
    },
  }
  const status = await runBackup({ store, directory })
  assert.equal(status.ok, true)
  assert.equal(status.cards, 3)
  assert.equal(status.decks, 2)
  assert.equal(status.progress, 2)
  assert.equal(status.settings, 2)
  const dump = JSON.parse(readFileSync(join(directory, 'exports', status.file), 'utf8'))
  assert.equal(dump.version, 2)
  assert.deepEqual(dump.users.accountA.decks['extra-deck'].progress, { one: PROGRESS(2) })
  assert.deepEqual(dump.users.accountA.decks['extra-deck'].settings, SETTINGS)
  assert.deepEqual(dump.decks['extra-deck'].deck, { ownerUid: 'accountA', memberUids: ['accountA'] })
  assert.equal(status.activity, 1)
  assert.equal(status.tombstones, 1)
  assert.equal(JSON.stringify(status).includes('accountA'), false)
  const saved = JSON.parse(readFileSync(join(directory, 'exports', 'backup-status.json'), 'utf8'))
  assert.equal(saved.sha256, status.sha256)
  assert.equal(saved.file, status.file)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

// Every REST get and list carries the same readTime (#116).
{
  const urls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { status: 200, ok: true, json: async () => ({ documents: [], fields: {} }) }
  }
  try {
    const pinned = cliStore('token', 'demo', '2026-10-26T12:00:00.000Z')
    await pinned.list('users')
    await pinned.get('users/a/settings/current')
    assert.equal(urls.length, 2)
    for (const url of urls) assert.equal(new URL(url).searchParams.get('readTime'), '2026-10-26T12:00:00.000Z', url)
    urls.length = 0
    await cliStore('token', 'demo').list('users')
    assert.equal(new URL(urls[0]).searchParams.has('readTime'), false)
  } finally {
    globalThis.fetch = realFetch
  }
}

// The incremental-pull cursor (#171) is a timestamp the dump does not carry; it is dropped, not fatal.
{
  const realFetch = globalThis.fetch
  const stamped = { integerValue: '2' }
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({
    documents: [{ name: 'x/decks/d/cards/c', fields: { updated_at: stamped, syncedAt: { timestampValue: '2026-10-31T00:00:00Z' } } }],
  }) })
  try {
    const rows = await cliStore('token', 'demo').list('decks/d/cards')
    assert.deepEqual(rows, [{ id: 'c', data: { updated_at: 2 } }])
  } finally {
    globalThis.fetch = realFetch
  }
}

// A user in the dump whose deck is missing (a sign-up racing the export) would make restore refuse it:
// the job must say so, not report ok, and must not leave it among the retained dumps.
{
  const racing = mkdtempSync(join(tmpdir(), 'firestore-backup-racing-'))
  try {
    const store = {
      get: async () => null,
      list: async (path) => path === 'users'
        ? [{ id: 'accountB', data: { deckId: 'deckB', schemaVersion: 1, migrationStatus: 'new' } }] : [],
    }
    await assert.rejects(runBackup({ store, directory: racing }), /failed restore validation/)
    const names = readdirSync(join(racing, 'exports'))
    assert.deepEqual(names.filter((name) => /^firestore-\d{8}T\d{6}Z\.json$/.test(name)), [])
    assert.equal(names.some((name) => name.endsWith('.rejected.json')), true)
    const status = JSON.parse(readFileSync(join(racing, 'exports', 'backup-status.json'), 'utf8'))
    assert.equal(status.ok, false)
  } finally {
    rmSync(racing, { recursive: true, force: true })
  }
}

console.log('firestore backup: values, counts, retention, private status: ok')

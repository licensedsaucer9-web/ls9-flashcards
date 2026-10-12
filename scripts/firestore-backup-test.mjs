import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupCounts, expiredBackups, firestoreValue, runBackup } from './firestore-backup.mjs'

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

const directory = mkdtempSync(join(tmpdir(), 'firestore-backup-'))
try {
  const store = {
    get: async (path) => path === 'users/accountA/settings/current' ? { tier: 1 } : null,
    list: async (path) => {
      if (path === 'users') return [{ id: 'accountA', data: { deckId: 'accountA', schemaVersion: 1, migrationStatus: 'new' } }]
      if (path === 'users/accountA/activity') return [{ id: '00000000-0000-4000-8000-000000000058', data: { at: 1790856000000, timeZone: 'Europe/Oslo' } }]
      if (path === 'users/accountA/progress') return [{ id: 'one', data: { updated_at: 1 } }]
      if (path === 'decks') return [{ id: 'deckA', data: { memberUids: ['accountA'] } }]
      if (path === 'decks/deckA/cards') return [{ id: 'one', data: { deletedAt: 0 } }, { id: 'gone', data: { deletedAt: 3 } }]
      return []
    },
  }
  const status = await runBackup({ store, directory })
  assert.equal(status.ok, true)
  assert.equal(status.cards, 2)
  assert.equal(status.activity, 1)
  assert.equal(status.tombstones, 1)
  assert.equal(JSON.stringify(status).includes('accountA'), false)
  const saved = JSON.parse(readFileSync(join(directory, 'exports', 'backup-status.json'), 'utf8'))
  assert.equal(saved.sha256, status.sha256)
  assert.equal(saved.file, status.file)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('firestore backup: values, counts, retention, private status: ok')

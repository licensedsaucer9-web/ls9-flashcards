// Read-only live inspection using the same private credential path as the importer.
import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { adminStore } from './migration-admin.mjs'
import { configDirectory, privatePath, readPrivateJson } from './migration-files.mjs'
import { validateMapping } from '../src/migration-data.ts'
import { same } from './migration-core.mjs'

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' } } })
  const mapping = validateMapping(readPrivateJson(join(configDirectory, 'migration-map-auth-test.json')))
  assert.equal(mapping.projectId, 'flashcards-ls9-auth-test', 'Preflight requires the test-project mapping')
  assert.equal(mapping.deckId, 'legacy-german', 'Preflight requires the reviewed legacy deck')
  const store = await adminStore(mapping.projectId, { credential: 'service-account-auth-test.json' })
  try {
    const accounts = []
    for (const uid of Object.values(mapping.profiles)) accounts.push(await store.get(`users/${uid}`))
    const deck = await store.get(`decks/${mapping.deckId}`)
    for (const account of accounts) {
      if (account) assert(account.deckId === mapping.deckId && account.schemaVersion === 1,
        'Existing test account conflicts with the reviewed legacy assignment')
    }
    if (deck) assert(Array.isArray(deck.memberUids) && same([...deck.memberUids].sort(), Object.values(mapping.profiles).sort()),
      'Existing test deck membership conflicts with the reviewed mapping')
    assert(deck || accounts.every((account) => !account), 'A preassigned account is missing its legacy deck')
    const report = { projectId: mapping.projectId, inspectedAt: new Date().toISOString(), mapping, accounts, deck,
      accountState: accounts.every((account) => !account) ? 'absent' : 'legacy assignment',
      deckState: deck ? 'matching legacy deck' : 'absent', readAccess: 'passed' }
    if (values.out) writeFileSync(privatePath(values.out), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ projectId: report.projectId, accountState: report.accountState,
      deckState: report.deckState, readAccess: report.readAccess }))
  } finally { await store.close() }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })

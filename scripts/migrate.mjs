// Local operator tool. Never imported by the app or invoked by the deploy workflow.
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { configDirectory, exportRepository, readExport, readPrivateJson } from './migration-files.mjs'
import { prepareMigration, runMigration } from './migration-core.mjs'

const help = `Usage (Node 22+):
  npm run migrate -- export --repo /path/to/german-flashcards-data --commit HEAD --out /private/export.json
  npm run migrate -- import --export /private/export.json [--mapping /private/map.json] [--credential service-account.json] [--apply] [--emulator]

Import defaults to dry-run and prints record-level source/before/after differences.
Mapping defaults to ~/.config/german-flashcards/migration-map.json.
Live credentials are read only from ~/.config/german-flashcards/.
--apply writes and verifies every imported record before marking migration complete.
--emulator requires a demo-* mapping project and FIRESTORE_EMULATOR_HOST.
Repeat the same command to resume after interruption. Private inputs stay outside Git repositories.`

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, commit: { type: 'string', default: 'HEAD' }, out: { type: 'string' },
    export: { type: 'string' }, mapping: { type: 'string', default: join(configDirectory, 'migration-map.json') },
    credential: { type: 'string', default: 'service-account.json' }, apply: { type: 'boolean', default: false },
    emulator: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log(help); return }
  if (positionals.length !== 1) throw new Error(help)
  if (positionals[0] === 'export') {
    if (!values.repo || !values.out) throw new Error(help)
    console.log(JSON.stringify(exportRepository(values.repo, values.commit, values.out)))
    return
  }
  if (positionals[0] !== 'import' || !values.export) throw new Error(help)
  // Validate all source records and the manual mapping before opening a network client.
  const plan = prepareMigration(readExport(values.export), readPrivateJson(values.mapping))
  const { adminStore } = await import('./migration-admin.mjs')
  const store = await adminStore(plan.mapping.projectId, { emulator: values.emulator, credential: values.credential })
  try {
    console.log(JSON.stringify({ projectId: plan.mapping.projectId, deckId: plan.mapping.deckId, commit: plan.commit, dryRun: !values.apply }))
    const result = await runMigration(plan, store, { dryRun: !values.apply, report: (record) => console.log(JSON.stringify(record)) })
    console.log(JSON.stringify(result))
  } finally { await store.close() }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })

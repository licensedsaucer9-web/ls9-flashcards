// Local operator tool. Never imported by the app or invoked by the deploy workflow.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicFirebaseWeb } from '../src/firebase-web.ts'
import { configDirectory, credentialPath, exportFirestore, exportRepository, privatePath, readExport, readPrivateJson } from './migration-files.mjs'
import { prepareMigration, runMigration } from './migration-core.mjs'
import { exportMigrationBaseline } from './migration-baseline.mjs'
import { configurationFingerprint, productionReadiness } from './preflight-core.mjs'
import { preflightRestore, publicRestoreSummary, runRestore } from './restore-core.mjs'

const help = `Usage (Node 22+):
  npm run migrate -- export --repo /path/to/ls9-flashcards-data --commit HEAD --out /private/export.json
  npm run migrate -- baseline --export /private/export.json [--mapping /private/map.json] --out /private/baseline.json
  npm run migrate -- import --export /private/export.json [--mapping /private/map.json] [--credential service-account.json] [--apply] [--emulator]
  npm run migrate -- backup --project flashcards-ls9-prod --credential service-account-prod.json --out /private/firestore.json
  npm run migrate -- restore --dump /private/firestore.json --project demo-example --credential service-account.json --report /private/restore.json [--apply] [--emulator]
  npm run migrate -- preflight [--out /private/preflight.json]

Import defaults to dry-run and prints record-level source/before/after differences.
The private operator directory defaults to ~/.config/german-flashcards/.
Set GERMAN_FLASHCARDS_PRIVATE_DIR to a directory outside Git if home is tracked.
Mapping defaults to migration-map.json there; live credentials are read only there.
baseline validates the export/mapping and writes private exact expectations offline.
--apply writes and verifies every imported record before marking migration complete.
--emulator requires a demo-* project and FIRESTORE_EMULATOR_HOST.
backup writes one private Admin SDK JSON file. It is not a scheduled job and does not need Blaze.
restore reads a kind:firestore backup. It defaults to a read-only dry run.
Stdout is aggregate counts, the dump checksum, and elapsedMs. Paths stay in --report.
--apply creates missing documents only. Newer, conflicting, or extra target documents fail closed.
It does not restore Google Auth users, IndexedDB, security rules, or hosting.
It refuses flashcards-ls9-prod and flashcards-ls9-auth-test.
Repeat restore with a new --report filename to resume. Private inputs stay outside Git repositories.
preflight binds the production rules, web project, base path, and held Pages publish steps to this source revision.
It does not deploy rules, import, back up, confirm UIDs, or publish. Stdout is the blocker list and checksums.
A private --out report repeats the prepared rules command with executed false.`

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, commit: { type: 'string', default: 'HEAD' }, out: { type: 'string' },
    project: { type: 'string' },
    export: { type: 'string' }, mapping: { type: 'string', default: join(configDirectory, 'migration-map.json') },
    credential: { type: 'string', default: 'service-account.json' }, apply: { type: 'boolean', default: false },
    emulator: { type: 'boolean', default: false }, help: { type: 'boolean' },
    dump: { type: 'string' }, report: { type: 'string' },
  } })
  if (values.help) { console.log(help); return }
  if (positionals.length !== 1) throw new Error(help)
  if (positionals[0] === 'preflight') {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const sourceRevision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const fingerprint = configurationFingerprint({
      rulesText: readFileSync(join(root, 'firestore.rules'), 'utf8'),
      firebaseJsonText: readFileSync(join(root, 'firebase.json'), 'utf8'),
      workflowText: readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8'),
      sourceRevision,
      webProjectId: publicFirebaseWeb.projectId,
    })
    const operatorFileExists = (name) => {
      try { return existsSync(credentialPath(name)) } catch { return false }
    }
    const summary = productionReadiness({
      fingerprint,
      credentialPresent: operatorFileExists('service-account-prod.json'),
      mappingPresent: operatorFileExists('migration-map-prod.json'),
      uidsConfirmed: false,
      inspection: null,
      backupVerified: false,
    })
    if (values.out) {
      const destination = privatePath(values.out)
      writeFileSync(destination, `${JSON.stringify({ ...fingerprint, readiness: summary }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    console.log(JSON.stringify(summary))
    return
  }
  if (positionals[0] === 'export') {
    if (!values.repo || !values.out) throw new Error(help)
    console.log(JSON.stringify(exportRepository(values.repo, values.commit, values.out)))
    return
  }
  if (positionals[0] === 'backup') {
    if (!values.project || !values.out) throw new Error(help)
    const { adminStore } = await import('./migration-admin.mjs')
    const store = await adminStore(values.project, { emulator: values.emulator, credential: values.credential })
    try {
      console.log(JSON.stringify(await exportFirestore(store, values.out)))
    } finally { await store.close() }
    return
  }
  if (positionals[0] === 'restore') {
    const explicit = (name) => process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`))
    if (!values.dump || !values.project || !values.report || !explicit('--credential') || !explicit('--project')) throw new Error(help)
    // Validate the dump, project pairing, and report path before opening a client.
    const prepared = preflightRestore({
      dumpPath: values.dump, projectId: values.project, credentialName: values.credential, reportPath: values.report,
    })
    const { adminStore } = await import('./migration-admin.mjs')
    const store = await adminStore(values.project, { emulator: values.emulator, credential: values.credential })
    try {
      const result = await runRestore(prepared.plan, store, {
        dryRun: !values.apply, projectId: values.project, reportPath: prepared.reportPath,
      })
      console.log(JSON.stringify(publicRestoreSummary(result)))
      if (result.state === 'refused') throw new Error('Restore refused: target has conflicting, newer, or extra documents')
    } finally { await store.close() }
    return
  }
  if (positionals[0] === 'baseline') {
    if (!values.export || !values.out) throw new Error(help)
    console.log(JSON.stringify(exportMigrationBaseline(values.export, values.mapping, values.out)))
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

// Offline operator preparation. No Admin SDK or cloud access.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { prepareMigration } from './migration-core.mjs'
import { privatePath, readExport, readPrivateJson, snapshotDigest } from './migration-files.mjs'

/** Exact source expectations for an empty server; live merges may preserve newer records. */
export function createMigrationBaseline(snapshot, mapping) {
  if (snapshot.sha256 !== snapshotDigest(snapshot)) throw new Error('Export checksum does not match')
  const plan = prepareMigration(snapshot, mapping)
  const expectedDocuments = plan.items.map((item) => {
    const data = item.merge(null)
    if (!data) throw new Error(`No baseline result for ${item.path}`)
    return { path: item.path, kind: item.kind, data }
  })
  const counts = {
    cards: plan.files.deck.cards.length,
    tombstones: Object.keys(plan.files.deck.deleted_ids).length,
    cardDocuments: expectedDocuments.filter((item) => item.kind === 'card').length,
    profiles: Object.keys(plan.files.users).length,
    progressRecords: expectedDocuments.filter((item) => item.kind === 'progress').length,
    settingsDocuments: expectedDocuments.filter((item) => item.kind === 'settings').length,
    skippedProfiles: plan.files.skipped.length,
  }
  const baseline = {
    version: 1,
    kind: 'migration-baseline',
    createdAt: new Date().toISOString(),
    source: { repository: snapshot.sourceRepository, commit: plan.commit,
      exportedAt: snapshot.exportedAt, sha256: snapshot.sha256 },
    mapping: plan.mapping,
    migrationFingerprint: plan.fingerprint,
    counts,
    normalization: [
      'normalizedFiles uses the existing validated v1/v2 migration parser, including explicit v1 ownership and legacy settings clocks.',
      'expectedDocuments uses the importer merge rules against an empty server, including missing progress/settings clocks becoming 0, default tier 1, and winning tombstones.',
      'A live import must compare its reviewed merge result when server records are newer; this baseline is not a restore command.',
    ],
    normalizedFiles: plan.files,
    expectedDocuments,
  }
  baseline.sha256 = snapshotDigest(baseline)
  return baseline
}

export function exportMigrationBaseline(exportPath, mappingPath, output) {
  const destination = privatePath(output)
  const baseline = createMigrationBaseline(readExport(exportPath), readPrivateJson(mappingPath))
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  writeFileSync(destination, `${JSON.stringify(baseline)}\n`, { flag: 'wx', mode: 0o600 })
  // Check the serialized artifact, not just the object that was about to be written.
  const readback = readExport(destination)
  return { path: destination, commit: readback.source.commit, exportSha256: readback.source.sha256,
    sha256: readback.sha256, counts: readback.counts }
}

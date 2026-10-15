// Synthetic artifacts only: no production service, identity or device access.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artifactFiles, buildIdentity, candidateManifest, MANIFEST_FILE, PUBLIC_BASE,
  publicationMode, sha256, validateCandidate, validateIdentity, verifyLocalCandidate, verifyServedCandidate } from './release-core.mjs'

const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8')
const masterCondition = "${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/master' }}"
assert(['held', 'master-only'].includes(publicationMode(workflow)))
const held = workflow.replaceAll(masterCondition, '${{ false }}')
assert.equal(publicationMode(held), 'held')
assert.equal(publicationMode(held.replaceAll('${{ false }}', masterCondition)), 'master-only')
assert.throws(() => publicationMode(held.replace('${{ false }}', masterCondition)), /together/)
assert.throws(() => publicationMode(held.replaceAll('${{ false }}', '${{ true }}')), /together/)

const release = buildIdentity({ version: '1.0.0-rc.1', sourceCommit: 'a'.repeat(40), sourceDirty: false,
  basePath: PUBLIC_BASE, backend: 'firebase', firebaseProject: 'flashcards-ls9-prod' })
assert.equal(validateIdentity(release, { candidate: true }), release)
for (const change of [{ sourceDirty: true }, { sourceCommit: 'abc' }, { version: '0.0.0' },
  { version: '1.0.0-rc.0' }, { backend: 'device', firebaseProject: null, mode: 'device' },
  { firebaseProject: 'flashcards-ls9-auth-test' }, { basePath: '/' }, { emulators: true },
  { mode: 'rehearsal' }, { mode: 'recovery-bridge' }]) {
  assert.throws(() => validateIdentity({ ...release, ...change }, { candidate: true }))
}
assert.throws(() => validateIdentity({ ...release, adminCredential: 'must not be public' }))
for (const version of ['1.1.0', '1.1.0-rc.1', '2.0.0']) validateIdentity({ ...release, version }, { candidate: true })
assert.equal(buildIdentity({ version: release.version, sourceCommit: release.sourceCommit, sourceDirty: true,
  basePath: '/', backend: 'device', firebaseProject: null }).mode, 'device')

const root = await mkdtemp(join(tmpdir(), 'ls9-candidate-test-'))
try {
  const bytes = {
    '.nojekyll': Buffer.from(''), 'index.html': Buffer.from('<title>LS9 Flashcards</title>'),
    'release.json': Buffer.from(JSON.stringify(release)), 'manifest.webmanifest': Buffer.from('{"scope":"./"}'),
    'sw.js': Buffer.from('/* worker fixture */'), 'assets/app.js': Buffer.from('/* app fixture */'),
  }
  await mkdir(join(root, 'assets'))
  for (const [name, data] of Object.entries(bytes)) await writeFile(join(root, name), data)
  const candidate = candidateManifest(release, await artifactFiles(root))
  const manifestBytes = Buffer.from(JSON.stringify(candidate))
  await writeFile(join(root, MANIFEST_FILE), manifestBytes)
  assert.deepEqual(await verifyLocalCandidate(root), candidate)
  const fetchFile = async (name) => {
    assert.notEqual(name, '.nojekyll', 'Pages dotfile marker is verified locally, not fetched')
    return name === MANIFEST_FILE ? manifestBytes : bytes[name]
  }
  const report = await verifyServedCandidate(candidate, fetchFile)
  assert.equal(report.sourceCommit, release.sourceCommit)
  assert.equal(report.artifactSha256, candidate.sha256)
  assert.equal(report.filesVerified, Object.keys(bytes).length - 1)
  await assert.rejects(() => verifyServedCandidate(candidate, async (name) =>
    name === 'assets/app.js' ? Buffer.from('stale app') : fetchFile(name)), /served file differs/)
  await assert.rejects(() => verifyServedCandidate(candidate, async (name) => {
    if (name === 'sw.js') throw new Error('missing served worker')
    return fetchFile(name)
  }), /missing served worker/)
  const other = candidateManifest({ ...release, sourceCommit: 'b'.repeat(40) }, candidate.files)
  await assert.rejects(() => verifyServedCandidate(candidate, async (name) =>
    name === MANIFEST_FILE ? Buffer.from(JSON.stringify(other)) : fetchFile(name)), /not the tested artifact/)
  const tampered = structuredClone(candidate)
  tampered.files['assets/app.js'] = sha256('different bytes')
  assert.throws(() => validateCandidate(tampered), /fingerprint/)
  for (const path of ['../private.json', '/absolute', 'assets/../../secret', '.git/config', MANIFEST_FILE]) {
    const files = Object.fromEntries(Object.entries({ ...candidate.files, [path]: sha256('bad') }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    assert.throws(() => candidateManifest(release, files), /unsafe/)
  }
  await writeFile(join(root, 'assets/app.js'), 'modified after testing')
  await assert.rejects(() => verifyLocalCandidate(root), /differ/)
  await writeFile(join(root, 'assets/app.js'), bytes['assets/app.js'])
  await writeFile(join(root, 'extra.txt'), 'unexpected file')
  await assert.rejects(() => verifyLocalCandidate(root), /differ/)
  await rm(join(root, 'extra.txt'))
  await rm(join(root, 'sw.js'))
  await assert.rejects(() => verifyLocalCandidate(root), /differ/)
  console.log('release: identity scope, dirty source, exact local/served bytes, stale/missing files, fingerprint and path rejection: ok')
} finally { await rm(root, { recursive: true, force: true }) }

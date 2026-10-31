import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PUBLIC_BASE = '/ls9-flashcards-site/'
export const SITE_REPOSITORY = 'licensedsaucer9-web/ls9-flashcards-site'
export const SITE_URL = `https://licensedsaucer9-web.github.io${PUBLIC_BASE}`
export const MANIFEST_FILE = 'release-candidate.json'
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

export function publicationMode(workflow) {
  const conditions = ['Check out public site', 'Publish tested files'].map((name) => {
    const prefix = `      - name: ${name}\n        if: `
    assert(workflow.includes(prefix), 'missing publication gate')
    return workflow.split(prefix)[1].split('\n')[0].trim()
  })
  if (conditions.every((condition) => condition === '${{ false }}')) return 'held'
  const masterOnly = "${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/master' }}"
  assert(conditions.every((condition) => condition === masterOnly), 'both publication conditions must be held or guarded together')
  return 'master-only'
}

export function buildIdentity({ version, sourceCommit, sourceDirty, basePath, backend, firebaseProject,
  rehearsal = false, emulators = false }) {
  const info = { schema: 1, version, sourceCommit, sourceDirty, basePath, backend, firebaseProject,
    mode: rehearsal ? 'rehearsal' : backend === 'firebase' ? 'production' : 'device',
    emulators, siteRepository: SITE_REPOSITORY }
  validateIdentity(info)
  return info
}

export function validateIdentity(info, { candidate = false } = {}) {
  assert(info && info.schema === 1, 'unsupported build identity')
  assert.equal(Object.keys(info).sort().join(','),
    'backend,basePath,emulators,firebaseProject,mode,schema,siteRepository,sourceCommit,sourceDirty,version')
  assert(typeof info.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(info.version), 'invalid app version')
  assert(commit(info.sourceCommit), 'source must be a full git commit')
  assert.equal(typeof info.sourceDirty, 'boolean')
  assert.equal(typeof info.emulators, 'boolean')
  assert(typeof info.basePath === 'string' && /^\/(?:[A-Za-z0-9_-]+\/)*$/.test(info.basePath), 'invalid build base')
  assert(['firebase', 'device'].includes(info.backend), 'invalid backend')
  assert(['production', 'rehearsal', 'device'].includes(info.mode), 'invalid build mode')
  assert.equal(info.siteRepository, SITE_REPOSITORY)
  if (info.backend === 'firebase') assert(typeof info.firebaseProject === 'string' && /^[a-zA-Z0-9-]+$/.test(info.firebaseProject))
  else assert(info.firebaseProject === null && info.mode === 'device', 'device builds cannot claim Firebase')
  if (candidate) {
    assert(/^[1-9]\d*\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/.test(info.version), 'candidate needs a release version (1.0.0 or later)')
    assert(!info.sourceDirty, 'release candidate requires a clean source tree')
    assert(!info.emulators && info.mode === 'production', 'release candidate cannot use a test or emulator mode')
    assert.equal(info.backend, 'firebase', 'release candidate must use Firebase')
    assert.equal(info.firebaseProject, 'flashcards-ls9-prod', 'release candidate must use the production project')
    assert.equal(info.basePath, PUBLIC_BASE, 'release candidate must use the public root')
  }
  return info
}

function safePath(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._/-]+$/.test(name) &&
    name.split('/').every((part) => part && !['.', '..', '.git'].includes(part))
}

export async function artifactFiles(root) {
  const files = {}
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const name = prefix + entry.name
      assert(safePath(name), 'unsafe artifact path')
      assert(!entry.isSymbolicLink(), 'artifact cannot contain symlinks')
      if (entry.isDirectory()) await walk(join(directory, entry.name), name + '/')
      else {
        assert(entry.isFile(), 'artifact contains a non-file entry')
        if (name !== MANIFEST_FILE) files[name] = sha256(await readFile(join(root, name)))
      }
    }
  }
  await walk(root)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => compare(a, b)))
}

export function candidateManifest(release, files) {
  const value = { schema: 1, release, files, sha256: sha256(JSON.stringify({ release, files })) }
  validateCandidate(value)
  return value
}

export function validateCandidate(value) {
  assert(value && value.schema === 1, 'unsupported candidate manifest')
  assert.deepEqual(Object.keys(value).sort(), ['files', 'release', 'schema', 'sha256'])
  validateIdentity(value.release, { candidate: true })
  assert(value.files && typeof value.files === 'object' && !Array.isArray(value.files))
  const names = Object.keys(value.files)
  assert(names.length > 0 && names.length <= 512, 'invalid artifact file count')
  assert.deepEqual(names, [...names].sort(), 'artifact inventory must be sorted')
  assert(names.every((name) => safePath(name) && name !== MANIFEST_FILE && hash(value.files[name])), 'unsafe artifact inventory')
  for (const name of ['index.html', 'release.json', 'manifest.webmanifest', 'sw.js', '.nojekyll']) {
    assert(Object.hasOwn(value.files, name), `candidate is missing ${name}`)
  }
  assert.equal(value.sha256, sha256(JSON.stringify({ release: value.release, files: value.files })), 'candidate fingerprint mismatch')
  return value
}

export async function verifyLocalCandidate(root) {
  const candidate = validateCandidate(JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')))
  assert.deepEqual(await artifactFiles(root), candidate.files, 'artifact files differ from the tested candidate')
  const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'))
  assert.deepEqual(release, candidate.release, 'artifact build identity differs from candidate')
  return candidate
}

/** Read-only byte comparison. fetchFile receives only validated relative paths. */
export async function verifyServedCandidate(candidate, fetchFile) {
  validateCandidate(candidate)
  const served = JSON.parse((await fetchFile(MANIFEST_FILE)).toString('utf8'))
  assert.deepEqual(validateCandidate(served), candidate, 'served candidate is not the tested artifact')
  for (const [name, checksum] of Object.entries(candidate.files)) {
    // Pages uses this deployment marker but does not have to serve dotfiles.
    if (name === '.nojekyll') continue
    assert.equal(sha256(await fetchFile(name)), checksum, `served file differs: ${name}`)
  }
  return { version: candidate.release.version, sourceCommit: candidate.release.sourceCommit,
    artifactSha256: candidate.sha256, filesVerified: Object.keys(candidate.files).length - 1 }
}

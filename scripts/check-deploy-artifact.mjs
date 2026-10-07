import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { validateIdentity } from './release-core.mjs'

const artifactDir = process.env.ARTIFACT_DIR || 'dist'
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactDir)) {
  throw new Error(`unsupported ARTIFACT_DIR: ${artifactDir}`)
}
const root = fileURLToPath(new URL(`../${artifactDir}/`, import.meta.url))
const base = process.env.BASE || '/'
const expectedProject = process.env.EXPECTED_FIREBASE_PROJECT || 'flashcards-ls9-prod'
assert(['flashcards-ls9-prod', 'flashcards-ls9-auth-test'].includes(expectedProject), 'unsupported expected Firebase project')
assert(base.startsWith('/') && base.endsWith('/'), `invalid BASE: ${base}`)

const html = await readFile(join(root, 'index.html'), 'utf8')
const manifest = JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8'))
const release = validateIdentity(JSON.parse(await readFile(join(root, 'release.json'), 'utf8')))
assert.equal(release.basePath, base, 'build identity uses the wrong base path')
assert.equal(release.backend, 'firebase', 'build identity must name Firebase')
assert.equal(release.firebaseProject, expectedProject, 'build identity uses the wrong project')
assert.equal(release.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
}).trim(), 'artifact belongs to a different source commit')
assert(html.includes(`src="${base}assets/`), 'JavaScript asset uses the wrong base path')
assert(html.includes(`href="${base}manifest.webmanifest"`), 'manifest uses the wrong base path')
assert.equal(new URL(manifest.start_url, `https://example.test${base}manifest.webmanifest`).pathname, base)
assert.equal(new URL(manifest.scope, `https://example.test${base}manifest.webmanifest`).pathname, base)
await readFile(join(root, '.nojekyll'))
await readFile(join(root, 'sw.js'))

const scripts = []
async function checkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      assert.notEqual(entry.name, '.git', 'Git metadata must not be deployed')
      await checkFiles(path)
      continue
    }
    const name = relative(root, path)
    assert(!/(^|\/)(data\.json|\.env[^/]*|[^/]+\.(map|pem|key))$/i.test(name), `private file in site: ${name}`)
    assert(!/service-account|migration-map|export\.json/i.test(name), `private file in site: ${name}`)
    if (name.endsWith('.js')) {
      const source = await readFile(path, 'utf8')
      assert(!source.includes('github_pat_'), `public bundle includes a GitHub token prefix: ${name}`)
      assert(!source.includes('ghp_'), `public bundle includes a GitHub token prefix: ${name}`)
      assert(!source.includes('BEGIN PRIVATE KEY'), `public bundle includes a private key: ${name}`)
      assert(!source.includes('api.github.com'), `public bundle includes the GitHub API: ${name}`)
      scripts.push(source)
    }
  }
}

await checkFiles(root)
assert(scripts.some((source) => source.includes(release.sourceCommit) && source.includes(release.version)),
  'app bundle must contain the artifact build identity')
assert((await readFile(join(root, 'sw.js'), 'utf8')).includes('release.json'), 'worker must cache the offline build identity')
assert(scripts.some((source) => source.includes(expectedProject)), 'bundle must name the expected Firebase project')
if (expectedProject === 'flashcards-ls9-auth-test') {
  assert(scripts.every((source) => !source.includes('flashcards-ls9-prod')), 'test preview must not contain production Firebase configuration')
}
console.log(`Checked ${artifactDir} uses ${base}, names ${expectedProject}, and contains no token, private key, or source map`)

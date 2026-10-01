import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const artifactDir = process.env.ARTIFACT_DIR || 'dist'
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifactDir)) {
  throw new Error(`unsupported ARTIFACT_DIR: ${artifactDir}`)
}
const root = fileURLToPath(new URL(`../${artifactDir}/`, import.meta.url))
const base = process.env.BASE || '/'
assert(base.startsWith('/') && base.endsWith('/'), `invalid BASE: ${base}`)

const html = await readFile(join(root, 'index.html'), 'utf8')
const manifest = JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8'))
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
assert(scripts.some((source) => source.includes('flashcards-ls9-prod')), 'public bundle must name the production Firebase project')
console.log(`Checked ${artifactDir} uses ${base}, names flashcards-ls9-prod, and contains no token, private key, or source map`)

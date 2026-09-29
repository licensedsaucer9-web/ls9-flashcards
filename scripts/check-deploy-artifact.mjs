import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../dist/', import.meta.url))
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
    if (name.endsWith('.js')) {
      const source = await readFile(path, 'utf8')
      assert(!source.includes('firebase'), `public bundle includes Firebase: ${name}`)
    }
  }
}

await checkFiles(root)
console.log(`Public artifact uses ${base} and contains no private data files or source maps`)

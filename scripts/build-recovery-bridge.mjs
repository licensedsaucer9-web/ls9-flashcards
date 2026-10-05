// Local recovery artifact for the old installation scope. It is not published.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dropped = [
  'VITE_REHEARSAL_PREVIEW',
  'VITE_REHEARSAL_REVISION',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_AUTH_EMULATOR',
  'VITE_FIREBASE_FIRESTORE_EMULATOR',
]
const env = { ...process.env, BASE: '/german-flashcards-site/', VITE_SYNC_BACKEND: 'firebase', VITE_RECOVERY_BRIDGE: 'true',
  ARTIFACT_DIR: 'dist-recovery-bridge', EXPECTED_FIREBASE_PROJECT: 'flashcards-ls9-prod' }
for (const key of dropped) delete env[key]

for (const args of [
  ['node_modules/typescript/bin/tsc'],
  ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-recovery-bridge', '--emptyOutDir'],
  ['scripts/check-deploy-artifact.mjs'],
]) execFileSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })

const out = join(root, 'dist-recovery-bridge')
const manifest = JSON.parse(readFileSync(join(out, 'manifest.webmanifest'), 'utf8'))
assert.equal(manifest.name, 'LS9 Flashcards')
assert.equal(manifest.short_name, 'LS9 Cards')
assert.equal(manifest.start_url, './')
assert.equal(manifest.scope, './')
assert.equal(Object.hasOwn(manifest, 'id'), false, 'a new manifest id would split the installed app from its storage')
const manifestUrl = 'https://licensedsaucer9-web.github.io/german-flashcards-site/manifest.webmanifest'
assert.equal(new URL(manifest.scope, manifestUrl).href, 'https://licensedsaucer9-web.github.io/german-flashcards-site/')
assert.equal(new URL(manifest.start_url, manifestUrl).href, 'https://licensedsaucer9-web.github.io/german-flashcards-site/')

const scripts = []
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (entry.name.endsWith('.js')) scripts.push(readFileSync(path, 'utf8'))
  }
}
collect(out)
const bundle = scripts.join('\n')
assert(bundle.includes('recovery/legacy-required'), 'bridge must refuse an unverified account')
assert(bundle.includes('german-flashcards'), 'bridge must keep the original storage prefix')
assert(!bundle.includes('german-flashcards-rehearsal'), 'bridge must not open rehearsal storage')
assert(!bundle.includes('flashcards-ls9-auth-test'), 'bridge must not embed the rehearsal project')
console.log('Recovery bridge: /german-flashcards-site/, original storage, production web config, unpublished')

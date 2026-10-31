// Builds locally. This command never deploys rules, imports data or publishes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { publicFirebaseWeb } from '../src/firebase-web.ts'
import { artifactFiles, candidateManifest, MANIFEST_FILE, PUBLIC_BASE, publicationMode, validateIdentity } from './release-core.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '', 'commit or isolate source changes before building a candidate')
const sourceCommit = git('rev-parse', 'HEAD')
const publishMode = publicationMode(readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8'))
const env = { ...process.env, BASE: PUBLIC_BASE, VITE_SYNC_BACKEND: 'firebase',
  VITE_REHEARSAL_PREVIEW: '', VITE_REHEARSAL_REVISION: '',
  VITE_FIREBASE_API_KEY: publicFirebaseWeb.apiKey, VITE_FIREBASE_AUTH_DOMAIN: publicFirebaseWeb.authDomain,
  VITE_FIREBASE_PROJECT_ID: publicFirebaseWeb.projectId, VITE_FIREBASE_APP_ID: publicFirebaseWeb.appId,
  VITE_FIREBASE_AUTH_EMULATOR: '', VITE_FIREBASE_FIRESTORE_EMULATOR: '', ARTIFACT_DIR: 'dist-firebase',
  EXPECTED_FIREBASE_PROJECT: 'flashcards-ls9-prod' }
for (const args of [
  ['node_modules/typescript/bin/tsc'],
  ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-firebase', '--emptyOutDir'],
  ['scripts/check-deploy-artifact.mjs'],
]) execFileSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })

assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'source advanced during build')
assert.equal(git('status', '--porcelain', '--untracked-files=normal'), '', 'source changed during build')
const artifact = fileURLToPath(new URL('../dist-firebase/', import.meta.url))
const release = validateIdentity(JSON.parse(readFileSync(artifact + 'release.json', 'utf8')), { candidate: true })
assert.equal(release.sourceCommit, sourceCommit)
const manifest = candidateManifest(release, await artifactFiles(artifact))
writeFileSync(artifact + MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ version: release.version, sourceCommit, artifactSha256: manifest.sha256,
  files: Object.keys(manifest.files).length, publicationHeld: publishMode === 'held' }))

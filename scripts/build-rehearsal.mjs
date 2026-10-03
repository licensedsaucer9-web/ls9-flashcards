// Public web configuration only. No Admin credential, private mapping, or export.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = JSON.parse(readFileSync(new URL('../spikes/firebase-rehearsal/web-config.json', import.meta.url), 'utf8'))
assert.equal(config.projectId, 'flashcards-ls9-auth-test')
for (const field of ['apiKey', 'authDomain', 'projectId', 'appId']) assert(config[field], `Missing test config field ${field}`)
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const env = { ...process.env, BASE: '/german-flashcards-site/auth-spike/rehearsal/',
  VITE_SYNC_BACKEND: 'firebase', VITE_REHEARSAL_PREVIEW: 'true', VITE_REHEARSAL_REVISION: revision,
  VITE_FIREBASE_API_KEY: config.apiKey, VITE_FIREBASE_AUTH_DOMAIN: config.authDomain,
  VITE_FIREBASE_PROJECT_ID: config.projectId, VITE_FIREBASE_APP_ID: config.appId,
  // A local emulator environment must never sneak into the live preview.
  VITE_FIREBASE_AUTH_EMULATOR: '', VITE_FIREBASE_FIRESTORE_EMULATOR: '',
  ARTIFACT_DIR: 'dist-rehearsal', EXPECTED_FIREBASE_PROJECT: config.projectId }
for (const args of [
  ['node_modules/typescript/bin/tsc'],
  ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-rehearsal', '--emptyOutDir'],
  ['scripts/check-deploy-artifact.mjs'],
]) execFileSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
console.log(`Rehearsal build: ${config.projectId}, revision ${revision}, ${env.BASE}`)

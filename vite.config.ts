import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { publicFirebaseWeb } from './src/firebase-web.ts'
import { buildIdentity } from './scripts/release-core.mjs'

const rehearsal = process.env.VITE_REHEARSAL_PREVIEW === 'true'
const recoveryBridge = process.env.VITE_RECOVERY_BRIDGE === 'true'
if (rehearsal && process.env.VITE_FIREBASE_PROJECT_ID !== 'flashcards-ls9-auth-test') {
  throw new Error('Rehearsal builds require the explicit OAuth test-project configuration')
}
if (recoveryBridge && rehearsal) throw new Error('The recovery bridge cannot use rehearsal storage')
if (recoveryBridge && process.env.BASE !== '/german-flashcards-site/') {
  throw new Error('The recovery bridge must be built at the old installation path')
}

function accountBackend(): Plugin {
  return {
    name: 'account-backend',
    enforce: 'pre',
    load(id) {
      // VITE_SYNC_BACKEND=firebase swaps in Firestore. Pages checks that client
      // in dist-firebase; publication waits for the authorized production gate.
      if (process.env.VITE_SYNC_BACKEND !== 'firebase') return null
      if (id.endsWith('/src/account.ts')) return `export * from './cloud-on.ts'\n`
      if (id.endsWith('/src/sync-backend.ts')) return `export * from './cloud-sync.ts'\n`
      return null
    },
  }
}

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL('.', import.meta.url))
  const env = { ...loadEnv(mode, root, 'VITE_'), ...process.env }
  const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  const firebase = process.env.VITE_SYNC_BACKEND === 'firebase'
  const info = buildIdentity({ version,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim()),
    basePath: process.env.BASE || '/', backend: firebase ? 'firebase' : 'device',
    firebaseProject: firebase ? env.VITE_FIREBASE_PROJECT_ID || publicFirebaseWeb.projectId : null,
    rehearsal, recoveryBridge,
    emulators: firebase && Boolean(env.VITE_FIREBASE_AUTH_EMULATOR || env.VITE_FIREBASE_FIRESTORE_EMULATOR),
  })
  return {
    base: info.basePath,
    define: { __LS9_BUILD_INFO__: JSON.stringify(info) },
    plugins: [
      accountBackend(),
      {
        name: 'release-identity',
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'release.json', source: JSON.stringify(info, null, 2) + '\n' })
        },
      },
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,
        includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png', 'pwa-512-maskable.png'],
        manifest: {
          name: rehearsal ? 'LS9 Flashcards Test Rehearsal' : 'LS9 Flashcards',
          short_name: rehearsal ? 'LS9 Test' : 'LS9 Cards',
          description: 'Personal flashcards with spaced repetition and offline study',
          theme_color: '#0e1116',
          background_color: '#0e1116',
          display: 'standalone',
          orientation: 'portrait',
          start_url: './',
          scope: './',
          lang: 'en',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: 'pwa-512-maskable.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}', 'release.json'],
          // The temporary auth PWAs live under this Pages path. Let their own
          // service workers handle navigation instead of serving the main app.
          navigateFallbackDenylist: [/\/auth-spike(?:-prod)?\//],
        },
      }),
    ],
  }
})

import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const rehearsal = process.env.VITE_REHEARSAL_PREVIEW === 'true'
if (rehearsal && process.env.VITE_FIREBASE_PROJECT_ID !== 'flashcards-ls9-auth-test') {
  throw new Error('Rehearsal builds require the explicit OAuth test-project configuration')
}

function accountBackend(): Plugin {
  return {
    name: 'account-backend',
    enforce: 'pre',
    load(id) {
      // VITE_SYNC_BACKEND=firebase swaps in Firestore. Pages checks that client
      // in dist-firebase and does not publish it until the #14 readback is recorded.
      if (process.env.VITE_SYNC_BACKEND !== 'firebase') return null
      if (id.endsWith('/src/account.ts')) return `export * from './cloud-on.ts'\n`
      if (id.endsWith('/src/sync-backend.ts')) return `export * from './cloud-sync.ts'\n`
      return null
    },
  }
}

export default defineConfig({
  base: process.env.BASE || '/',
  plugins: [
    accountBackend(),
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
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // The temporary auth PWAs live under this Pages path. Let their own
        // service workers handle navigation instead of serving the main app.
        navigateFallbackDenylist: [/\/auth-spike(?:-prod)?\//],
      },
    }),
  ],
})

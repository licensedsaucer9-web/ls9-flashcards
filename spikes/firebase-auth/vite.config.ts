import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const root = fileURLToPath(new URL('.', import.meta.url))

// Separate build entry: the normal site build never includes the spike.
export default defineConfig({
  root,
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  base: process.env.BASE || '/',
  build: { outDir: fileURLToPath(new URL('../../dist-auth-spike', import.meta.url)), emptyOutDir: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Firebase Sign-in Check',
        short_name: 'Auth Check',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0e1116',
        theme_color: '#0e1116',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,png,webmanifest}'],
        navigateFallbackDenylist: [/\/rehearsal\//] },
    }),
  ],
})

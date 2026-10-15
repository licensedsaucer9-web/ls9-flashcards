/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SYNC_BACKEND?: string
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
  readonly VITE_FIREBASE_AUTH_EMULATOR?: string
  readonly VITE_FIREBASE_FIRESTORE_EMULATOR?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

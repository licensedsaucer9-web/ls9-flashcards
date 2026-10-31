export interface BuildInfo {
  readonly schema: 1
  readonly version: string
  readonly sourceCommit: string
  readonly sourceDirty: boolean
  readonly basePath: string
  readonly backend: 'firebase' | 'device'
  readonly firebaseProject: string | null
  readonly mode: 'production' | 'rehearsal' | 'device'
  readonly emulators: boolean
  readonly siteRepository: string
}

// Vite embeds the same identity in this bundle and release.json. No network
// lookup: Settings continues to identify the running build while offline.
declare const __LS9_BUILD_INFO__: BuildInfo
export const buildInfo = Object.freeze(__LS9_BUILD_INFO__)

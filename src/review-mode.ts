import { storagePrefix } from './rehearsal.ts'

const key = `${storagePrefix}.hard-mode`
let enabled = false
try { enabled = localStorage.getItem(key) === 'true' } catch { /* Device storage is optional. */ }

export function hardModeEnabled(): boolean { return enabled }
export function chooseHardMode(value: boolean): boolean {
  enabled = value
  try { localStorage.setItem(key, String(value)); return true } catch { return false }
}

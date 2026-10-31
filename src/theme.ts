import { storagePrefix } from './rehearsal.ts'

export const themes = ['dark', 'light', 'halloween', 'christmas', 'neopunk', 'nature', 'coffee', 'dissonant', 'pink', 'mint', 'lavender'] as const
export type Theme = typeof themes[number]
export const themeLabels: Record<Theme, string> = {
  dark: 'Dark', light: 'Light', halloween: 'Halloween', christmas: 'Christmas', neopunk: 'NeoPunk', nature: 'Nature', coffee: 'Coffee', dissonant: 'Dissonant',
  pink: 'Cute Pink', mint: 'Mint', lavender: 'Lavender',
}
const storageKey = `${storagePrefix}.theme`

export function currentTheme(): Theme {
  return validTheme(document.documentElement.dataset.theme)
}

function validTheme(value: string | null | undefined): Theme {
  return themes.find((theme) => theme === value) ?? 'dark'
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

/** Appearance belongs to this browser, across accounts and decks. */
export function initializeTheme(): void {
  let theme: Theme = 'dark'
  try {
    theme = validTheme(localStorage.getItem(storageKey))
  } catch { /* Appearance still works when browser storage is unavailable. */ }
  applyTheme(theme)
}

/** Apply immediately; report whether the choice will survive a reload. */
export function chooseTheme(theme: Theme): boolean {
  applyTheme(theme)
  try {
    localStorage.setItem(storageKey, theme)
    return true
  } catch {
    return false
  }
}

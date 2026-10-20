import { storagePrefix } from './rehearsal.ts'

export type Theme = 'dark' | 'light'
const storageKey = `${storagePrefix}.theme`

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
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
    if (localStorage.getItem(storageKey) === 'light') theme = 'light'
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

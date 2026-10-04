// Live operator check. Uses fresh browser contexts and never signs into Google.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const root = process.env.ROOT_URL || 'https://licensedsaucer9-web.github.io/ls9-flashcards-site/'
const preview = new URL('auth-spike/rehearsal/', root).href
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await context.newPage()

try {
  // Install the old root worker and establish legacy local data first.
  await page.goto(root)
  await page.waitForSelector('[data-due-count]')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  const before = await page.evaluate(async () => {
    localStorage.setItem('german-flashcards.github', 'legacy-token-sentinel')
    localStorage.setItem('german-flashcards.github.shas', 'legacy-sha-sentinel')
    const keys = ['user', 'users', 'migrated', 'github', 'github.shas', 'copy-choice', 'device-study']
    const storage = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(`german-flashcards.${key}`)]))
    const profile = localStorage.getItem('german-flashcards.user')
    const name = profile ? `german-flashcards:${profile}` : 'german-flashcards'
    const request = indexedDB.open(name)
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['cards', 'settings'], 'readonly')
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const [cards, settings] = await Promise.all([read(tx.objectStore('cards').getAll()), read(tx.objectStore('settings').getAll())])
    db.close()
    return { storage, name, cards, settings }
  })
  // The auth-only parent's worker must also leave the full-app child alone.
  const authUrl = new URL('auth-spike/', root).href
  await page.goto(authUrl)
  await page.waitForSelector('#sign-in')
  await page.waitForFunction(async (url) => (await navigator.serviceWorker.getRegistration(url))?.scope === url, authUrl)
  await page.reload()
  await page.goto(preview)
  await page.waitForSelector('#guest-study')
  const marker = await page.locator('#rehearsal-notice').textContent()
  assert(marker.includes('flashcards-ls9-auth-test'))
  if (process.env.PREVIEW_REVISION) assert(marker.includes(process.env.PREVIEW_REVISION.slice(0, 7)), 'preview revision differs')
  const manifestUrl = new URL(await page.locator('link[rel="manifest"]').getAttribute('href'), preview).href
  const manifest = await (await fetch(manifestUrl)).json()
  assert.equal(new URL(manifest.scope, manifestUrl).href, preview)
  assert.equal(new URL(manifest.start_url, manifestUrl).href, preview)
  await page.click('#guest-study')
  await page.waitForSelector('[data-due-count]')
  const after = await page.evaluate(async (before) => {
    const storage = Object.fromEntries(Object.keys(before.storage).map((key) => [key, localStorage.getItem(`german-flashcards.${key}`)]))
    const request = indexedDB.open(before.name)
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['cards', 'settings'], 'readonly')
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const [cards, settings] = await Promise.all([read(tx.objectStore('cards').getAll()), read(tx.objectStore('settings').getAll())])
    db.close()
    const names = (await indexedDB.databases()).map((db) => db.name)
    return { storage, name: before.name, cards, settings, names }
  }, before)
  assert.deepEqual(after.storage, before.storage, 'rehearsal must leave legacy preferences and PAT keys intact')
  assert.deepEqual(after.cards, before.cards, 'rehearsal must leave legacy vocabulary/progress intact')
  assert.deepEqual(after.settings, before.settings, 'rehearsal must leave legacy settings intact')
  assert(after.names.includes('german-flashcards-rehearsal'), 'rehearsal guest must use its separate database')
  await page.waitForFunction(async (url) => (await navigator.serviceWorker.getRegistration(url))?.scope === url, preview)
  console.log(JSON.stringify({ preview, marker, parentWorkersBypassed: true, legacyStoragePreserved: true,
    separateGuestStorage: true, manifestScope: 'passed', desktopChromiumMobileViewport: 'passed' }))
  if (process.env.PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.PREVIEW_SCREENSHOT, fullPage: true })
} finally { await context.close(); await browser.close() }

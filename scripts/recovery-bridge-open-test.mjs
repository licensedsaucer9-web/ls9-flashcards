// Opens the built recovery bridge the way a signed-out installation does.
// The legacy profile must survive that open with no sign-in and no Copy.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { chromium } from 'playwright-core'
import { card, srs } from './migration-fixtures.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const base = 'http://127.0.0.1:4184/german-flashcards-site/'
const cards = [
  card('custom-1', { srs: srs({ reps: 2, updated_at: 50 }) }),
  card('custom-offline', { de: 'offline', updated_at: 700, srs: srs({ reps: 7, updated_at: 700 }) }),
]
const settings = {
  id: 'settings',
  direction: 'de-en',
  sessionSize: 30,
  tier: 3,
  deletedIds: { 'seed-01': 700 },
  localRevision: 20,
  acknowledgedRevision: 19,
  settingsUpdatedAt: 700,
}
const storage = {
  'german-flashcards.users': JSON.stringify([{ slug: 'synthetic', name: 'Synthetic fixture', createdAt: 1 }]),
  'german-flashcards.user': 'synthetic',
  'german-flashcards.migrated': '1',
  'german-flashcards.github': 'synthetic-sentinel',
}

const server = await preview({
  root,
  configFile: false,
  base: '/german-flashcards-site/',
  build: { outDir: 'dist-recovery-bridge' },
  preview: { host: '127.0.0.1', port: 4184, strictPort: true },
})
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') return route.abort()
    if (url.pathname.endsWith('/__review_fixture__')) {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic recovery fixture</title>' })
    }
    return route.continue()
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}__review_fixture__`)
  await page.evaluate(async ({ cards: sourceCards, settings: sourceSettings, storage: sourceStorage }) => {
    for (const [key, value] of Object.entries(sourceStorage)) localStorage.setItem(key, value)
    const request = indexedDB.open('german-flashcards:synthetic', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('cards', { keyPath: 'id' })
      request.result.createObjectStore('settings', { keyPath: 'id' })
    }
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['cards', 'settings'], 'readwrite')
    for (const sourceCard of sourceCards) tx.objectStore('cards').put(sourceCard)
    tx.objectStore('settings').put(sourceSettings)
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  }, { cards, settings, storage })

  await page.goto(base)
  await page.waitForSelector('[data-due-count]')
  // Reading the Decks tab must also preserve the original schema and records.
  await page.evaluate(() => { location.hash = '#/decks' })
  await page.waitForSelector('.card-row')
  assert.equal(await page.locator('.card-row .de').first().textContent(), 'German')
  const result = await page.evaluate(async (keys) => {
    const request = indexedDB.open('german-flashcards:synthetic', 1)
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['cards', 'settings'], 'readonly')
    const read = (pending) => new Promise((resolve, reject) => {
      pending.onsuccess = () => resolve(pending.result)
      pending.onerror = () => reject(pending.error)
    })
    const [storedCards, storedSettings] = await Promise.all([
      read(tx.objectStore('cards').getAll()),
      read(tx.objectStore('settings').get('settings')),
    ])
    db.close()
    return {
      cards: storedCards,
      settings: storedSettings,
      storage: Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
    }
  }, Object.keys(storage))

  assert.deepEqual(errors, [], 'a normal bridge open raised a page error')
  assert.deepEqual(result.cards.sort((a, b) => a.id.localeCompare(b.id)), cards.sort((a, b) => a.id.localeCompare(b.id)))
  assert.deepEqual(result.settings, settings, 'a normal bridge open changed the source settings')
  assert.equal(result.cards.length, cards.length, 'a normal bridge open changed the source card count')
  assert.equal(result.settings.localRevision, settings.localRevision)
  assert.equal(result.settings.acknowledgedRevision, settings.acknowledgedRevision)
  assert.equal(Object.keys(result.settings.pending?.cards ?? {}).length, 0, 'a normal bridge open added pending card markers')
  assert.deepEqual(result.storage, storage, 'a normal bridge open changed the legacy token or profile keys')
  console.log('recovery bridge open: synthetic source unchanged without sign-in or copy')
} finally {
  await browser.close()
  await new Promise((resolve) => server.httpServer.close(resolve))
}

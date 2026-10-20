// Exercise appearance in disposable browsers without contacting cloud services.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'themes-'))
let server, browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4191, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  const errors = [], external = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    external.push(route.request().url()); return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://127.0.0.1:4191/#/settings')
  const select = page.getByLabel('Theme', { exact: true })
  await select.waitFor()
  assert.equal(await select.inputValue(), 'dark')
  const before = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    return { cards: await db.getAllCards(), settings: await db.getSettings(), activity: await db.getReviewActivity() }
  })
  const palette = () => page.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    return { bg: css.getPropertyValue('--bg').trim(), scheme: css.colorScheme, meta: document.querySelector('meta[name="theme-color"]').content }
  })
  assert.deepEqual(await palette(), { bg: '#0e1116', scheme: 'dark', meta: '#0e1116' })
  await select.focus()
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  assert.equal(await select.inputValue(), 'light', 'theme control supports keyboard selection')
  assert.deepEqual(await palette(), { bg: '#f5f7fb', scheme: 'light', meta: '#f5f7fb' })
  if (process.env.THEME_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-theme-light.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile layout fits')
  await page.reload(); await select.waitFor()
  assert.equal(await select.inputValue(), 'light', 'selection survives reload')
  for (const route of ['/', '/deck', '/decks']) {
    await page.goto(`http://127.0.0.1:4191/#${route}`)
    await page.waitForSelector('.screen')
    assert.equal((await palette()).scheme, 'light', `${route} inherits selected theme`)
  }
  await page.goto('http://127.0.0.1:4191/#/')
  await page.click('#start'); await page.waitForSelector('#card')
  await page.click('#card'); await page.waitForSelector('.grades:not([hidden])')
  if (process.env.THEME_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-theme-review.png', fullPage: true })
  await page.goto('http://127.0.0.1:4191/#/settings'); await select.waitFor()
  await page.setViewportSize({ width: 1280, height: 900 })
  await select.selectOption('dark')
  if (process.env.THEME_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-theme-dark.png', fullPage: true })
  await page.reload(); await select.waitFor()
  assert.equal(await select.inputValue(), 'dark', 'switching back persists too')
  const after = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    return { cards: await db.getAllCards(), settings: await db.getSettings(), activity: await db.getReviewActivity() }
  })
  assert.deepEqual(after, before, 'appearance and ungraded previews preserve study data')
  await page.evaluate(() => localStorage.setItem('german-flashcards.theme', 'unknown'))
  await page.reload(); await select.waitFor()
  assert.equal(await select.inputValue(), 'dark', 'invalid saved value falls back safely')
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError') } })
  await select.selectOption('light')
  assert.equal((await palette()).scheme, 'light', 'storage failure still applies theme')
  assert.match(await page.locator('.toast').textContent(), /storage is unavailable/)
  const blocked = await browser.newContext()
  await blocked.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) {
      if (key === 'german-flashcards.theme') throw new DOMException('Blocked', 'SecurityError')
      return getItem.call(this, key)
    }
  })
  const blockedPage = await blocked.newPage()
  await blockedPage.goto('http://127.0.0.1:4191/#/settings')
  await blockedPage.waitForSelector('#theme')
  assert.equal(await blockedPage.locator('#theme').inputValue(), 'dark', 'blocked storage does not prevent startup')
  await blocked.close()
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('themes UI: keyboard switching, palettes, mobile/desktop, reload, navigation/review, data preservation, invalid/blocked storage: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

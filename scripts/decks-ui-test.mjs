// Local device-study navigation acceptance; fresh browser storage, no live services.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'decks-ui-test-'))
let server
let browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4182, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  const externalRequests = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    externalRequests.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:4182/')
  await page.waitForSelector('#start')
  // Establish existing study history before exercising navigation.
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const card = (await db.getAllCards())[0]
    await db.saveReview(card.id, 'good', crypto.randomUUID(), Date.now(), 'UTC')
  })
  const snapshot = () => page.evaluate(async () => {
    const db = await import('/src/db.ts')
    return { cards: await db.getAllCards(), activity: await db.getReviewActivity() }
  })
  const before = await snapshot()
  assert.equal(before.cards.length, 514)
  assert.equal(Object.keys(before.activity).length, 1)
  assert.deepEqual(await page.locator('#tabbar .tab').allTextContents(), ['Review', 'Cards', 'Decks', 'Settings'])
  async function tab(name, hash, heading) {
    await page.locator('#tabbar .tab').filter({ hasText: new RegExp(`^${name}$`) }).click()
    await page.waitForFunction(({ hash, heading }) => location.hash === hash && document.querySelector('h1')?.textContent === heading, { hash, heading })
    assert.equal(await page.locator('#tabbar .is-active').textContent(), name)
  }
  async function assertDeckCount(count) {
    assert.equal(await page.locator('#main .card-row').count(), 1)
    assert.equal(await page.locator('#main .de').textContent(), 'German')
    assert.equal(await page.locator('#main .en').textContent(), `${count} cards`)
    assert.equal(await page.locator('#main .badge').textContent(), 'Active')
    assert.equal(await page.locator('#main a, #main button, #main input').count(), 0)
  }
  await tab('Decks', '#/decks', 'Decks')
  await assertDeckCount(514)
  const boxes = await page.locator('#tabbar .tab').evaluateAll(tabs => tabs.map(tab => {
    const { x, y, width, height } = tab.getBoundingClientRect()
    return { x, y, width, height }
  }))
  assert(boxes.every(box => box.y === boxes[0].y && box.width > 0 && box.height > 0), 'four tabs share one visible row')
  if (process.env.DECKS_SCREENSHOT) await page.screenshot({ path: process.env.DECKS_SCREENSHOT, fullPage: true })
  await tab('Cards', '#/deck', 'Cards')
  assert(await page.locator('.card-list .card-row').count() > 0)
  await page.locator('.card-list .card-row').first().click()
  await page.waitForSelector('#form')
  assert.match(await page.evaluate(() => location.hash), /^#\/card\/.+/)
  assert.equal(await page.locator('#tabbar .is-active').textContent(), 'Cards')
  const editedId = await page.evaluate(() => location.hash.split('/')[2])
  await page.locator('[name="en"]').fill('Synthetic navigation edit')
  await page.locator('#form [type="submit"]').click()
  await page.waitForSelector('#search')
  assert.equal(await page.evaluate(() => location.hash), '#/deck')
  await page.locator('a[href="#/import"]').click()
  await page.waitForSelector('#paste')
  assert.equal(await page.evaluate(() => location.hash), '#/import')
  assert.equal(await page.locator('#tabbar .is-active').textContent(), 'Cards')
  await page.locator('#paste').fill('de,en,article,type\nNavigationstest,synthetic navigation import,none,other')
  await page.locator('#run').click()
  await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('1 new cards'))
  await tab('Decks', '#/decks', 'Decks')
  await assertDeckCount(515)
  await page.reload()
  await page.waitForSelector('#main .card-row')
  await assertDeckCount(515)
  const after = await snapshot()
  assert.deepEqual(after.activity, before.activity, 'navigation/edit/import preserve streak events')
  for (const card of before.cards) {
    const saved = after.cards.find(c => c.id === card.id)
    assert(saved, 'every existing German card survives')
    assert.deepEqual(saved.srs, card.srs, 'existing due dates and schedules survive')
    if (card.id !== editedId) assert.deepEqual(saved, card, 'untouched German cards retain all fields')
    else assert.equal(saved.en, 'Synthetic navigation edit')
  }
  await tab('Settings', '#/settings', 'Settings')
  await page.locator('#tabbar [data-tab="home"]').click()
  await page.waitForSelector('#start')
  assert.equal(await page.locator('#tabbar .is-active').textContent(), 'Review')
  await page.locator('#start').click()
  await page.waitForSelector('#card')
  assert.equal(await page.evaluate(() => location.hash), '#/review')
  assert.equal(await page.locator('#tabbar').isVisible(), false)
  await page.locator('#card').click()
  assert.equal(await page.locator('[data-grade="good"]').isVisible(), true)
  await page.locator('#back').click()
  await page.waitForSelector('#start')
  assert.deepEqual(await snapshot(), after, 'entering/flipping/leaving Review does not mutate study data')
  assert.deepEqual(errors, [], 'no browser errors')
  assert.deepEqual(externalRequests, [], 'no external service access')
  console.log('decks-ui: four tabs, distinct routes, display-only count, edit/import, Review, German schedules/streak preservation: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

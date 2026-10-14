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
    await db.putSettings({ tier: 3, sessionSize: 0, direction: 'en-de' })
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
    assert.equal(await page.locator('#main .card-row a, #main .card-row button, #main .card-row input').count(), 0)
    assert.equal(await page.locator('[data-word-type]').count(), 4)
    assert.equal(await page.locator('[data-tier]').count(), 3)
    assert.deepEqual(await page.locator('#dir button').allTextContents(), ['DE → EN', 'EN → DE'])
    assert.equal(await page.locator('[data-session], #session-custom, #session-size').count(), 0, 'Decks has no session-size control')
  }
  await tab('Decks', '#/decks', 'Decks')
  await assertDeckCount(514)
  const settings = () => page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { direction, sessionSize, tier, wordTypes } = await db.getSettings()
    return { direction, sessionSize, tier, wordTypes }
  })
  const originalSettings = await settings()
  async function pickType(type, expected) {
    await page.locator(`[data-word-type="${type}"]`).click()
    await page.waitForFunction(async expected => {
      const db = await import('/src/db.ts')
      const selected = (await db.getSettings()).wordTypes
      const pressed = [...document.querySelectorAll('[data-word-type][aria-pressed="true"]')].map(button => button.dataset.wordType)
      return JSON.stringify(selected) === JSON.stringify(expected)
        && JSON.stringify(pressed) === JSON.stringify(expected.length ? expected : ['all'])
    }, expected)
    assert.deepEqual(await settings(), { ...originalSettings, wordTypes: expected }, 'only the word-type preference changes')
    await page.waitForSelector(`[data-word-type="${expected.length ? expected.at(-1) : 'all'}"][aria-pressed="true"]`)
  }
  async function assertReviewQueue(typeLabel) {
    await tab('Review', '#/', 'LS9 Flashcards')
    assert.equal(await page.locator('[data-word-type], [data-tier], [data-dir]').count(), 0, 'Review home has no tier, word-type or direction controls')
    assert.equal(await page.locator('#session-custom').isVisible(), true)
    if (typeLabel) assert.match(await page.locator('.due-hero > .kicker').textContent(), new RegExp(typeLabel))
    const expected = await page.evaluate(async () => {
      const db = await import('/src/db.ts')
      const { selectReviewCandidates, sessionCount } = await import('/src/session.ts')
      const settings = await db.getSettings()
      const candidates = selectReviewCandidates(await db.getAllCards(), settings.tier, settings.wordTypes)
      return sessionCount(candidates.cards.length, settings.sessionSize)
    })
    assert.equal(Number(await page.locator('#start').getAttribute('data-session-count')), expected)
    await page.locator('#start').click()
    await page.waitForSelector('#card')
    assert.equal(Number(await page.locator('[data-remaining]').textContent()), expected, 'Decks preference controls the next review queue')
    assert.equal(await page.locator('[data-word-type], [data-tier], [data-dir]').count(), 0, 'active Review has no tier, word-type or direction controls')
    const faces = await page.evaluate(async () => {
      const db = await import('/src/db.ts')
      const { selectReviewCandidates } = await import('/src/session.ts')
      const settings = await db.getSettings()
      const candidates = selectReviewCandidates(await db.getAllCards(), settings.tier, settings.wordTypes).cards
      const front = document.querySelector('.front .word').textContent
      const back = document.querySelector('.back .word').textContent
      return { matches: candidates.some(card => settings.direction === 'en-de'
        ? front === card.en && back.endsWith(card.de)
        : front.endsWith(card.de) && back === card.en) }
    })
    assert.equal(faces.matches, true, 'the next review uses the saved tier and direction')
    if (typeLabel === 'Nouns') assert.equal(await page.locator('.front .word-type').textContent(), 'noun')
    await page.locator('#back').click()
    await page.waitForSelector('#start')
    return expected
  }
  assert.equal(await page.locator('[data-word-type="all"]').getAttribute('aria-pressed'), 'true')
  await pickType('noun', ['noun'])
  await page.reload()
  await page.waitForSelector('[data-word-type="noun"][aria-pressed="true"]')
  assert.deepEqual((await settings()).wordTypes, ['noun'], 'choice survives reload')
  await tab('Settings', '#/settings', 'Settings')
  assert.equal(await page.locator('[data-word-type], [data-tier], [data-dir], [data-session], #session-custom, #session-size').count(), 0, 'Settings has no study controls')
  assert.equal(await page.locator('#app-version').isVisible(), true)
  assert.equal(await page.locator('#sw-status').isVisible(), true)
  assert.match(await page.locator('#main').textContent(), /Install/)
  assert.match(await page.locator('#main').textContent(), /SM-2 with Again/)
  const nounQueue = await assertReviewQueue('Nouns')
  await tab('Decks', '#/decks', 'Decks')
  await pickType('verb', ['noun', 'verb'])
  await pickType('noun', ['verb'])
  await pickType('verb', [])
  assert.equal(await page.locator('[data-word-type="all"]').getAttribute('aria-pressed'), 'true', 'last deselection returns to All')
  await pickType('adj', ['adj'])
  await pickType('all', [])
  const allQueue = await assertReviewQueue()
  assert(allQueue > nounQueue, 'All restores the wider review queue')
  async function pickPreference(selector, patch) {
    const previous = await settings()
    await page.locator(selector).click()
    await page.waitForFunction(async ({ selector, patch }) => {
      const saved = await (await import('/src/db.ts')).getSettings()
      return Object.entries(patch).every(([key, value]) => saved[key] === value)
        && document.querySelector(selector)?.classList.contains('is-on')
    }, { selector, patch })
    assert.deepEqual(await settings(), { ...previous, ...patch }, 'only the selected preference changes')
  }
  await tab('Decks', '#/decks', 'Decks')
  await pickPreference('[data-tier="1"]', { tier: 1 })
  await pickPreference('[data-dir="de-en"]', { direction: 'de-en' })
  await page.reload()
  await page.waitForSelector('[data-dir="de-en"].is-on')
  assert.equal(await page.locator('[data-tier="1"].is-on').count(), 1, 'saved tier survives reload')
  const tierOneQueue = await assertReviewQueue()
  assert(tierOneQueue < allQueue, 'the saved tier narrows the next review')
  const savedBeforeBrowse = await page.evaluate(async () => (await import('/src/db.ts')).getSettings())
  await tab('Cards', '#/deck', 'Cards')
  const tierOneCards = await page.locator('.card-list .card-row').count()
  await page.click('[data-tier="3"]')
  assert.equal(await page.locator('.card-list .card-row').count(), 514, 'Cards can browse beyond the saved tier')
  assert(tierOneCards < 514)
  await page.locator('#search').fill('Haus')
  await page.click('[data-tier="2"]')
  assert.deepEqual(await page.evaluate(async () => (await import('/src/db.ts')).getSettings()), savedBeforeBrowse,
    'Cards tier/search filters do not write preferences, clocks or pending markers')
  assert.equal(await assertReviewQueue(), tierOneQueue, 'Cards browsing does not change the next review')
  await tab('Decks', '#/decks', 'Decks')
  assert.equal(await page.locator('[data-tier="1"].is-on').count(), 1)
  await pickPreference('[data-tier="2"]', { tier: 2 })
  const tierTwoQueue = await assertReviewQueue()
  assert(tierTwoQueue > tierOneQueue && tierTwoQueue < allQueue, 'tier 2 is cumulative')
  await tab('Decks', '#/decks', 'Decks')
  await pickPreference('[data-tier="3"]', { tier: 3 })
  await pickPreference('[data-dir="en-de"]', { direction: 'en-de' })
  assert.equal(await assertReviewQueue(), allQueue)
  assert.deepEqual(await settings(), originalSettings, 'unrelated preferences survive tier and direction changes')
  assert.deepEqual(await snapshot(), before, 'filter changes and review entry preserve every card, schedule and streak event')
  await tab('Decks', '#/decks', 'Decks')
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
  const allCount = await assertReviewQueue()
  const eligible = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { inSelectedWordTypes } = await import('/src/word-types.ts')
    const cards = (await db.getAllCards()).filter(card => card.srs.due <= Date.now())
    return { all: cards.length, typed: cards.filter(card => inSelectedWordTypes(card, ['noun', 'verb', 'adj'])).length }
  })
  assert.equal(allCount, eligible.all, 'All includes every due card, including the imported untyped fixture')
  assert(eligible.all > eligible.typed, 'fixture contains a due untyped card')
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
  // A local-only fixture with no typed cards exercises Review's empty-match recovery.
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.putCards((await db.getAllCards()).map(card => ({ ...card, tags: ['other'] })))
  })
  const untypedFixture = await snapshot()
  await tab('Decks', '#/decks', 'Decks')
  await pickType('noun', ['noun'])
  await tab('Review', '#/', 'LS9 Flashcards')
  assert.equal(await page.locator('[data-word-type]').count(), 0)
  assert.match(await page.locator('.due-hero > .kicker').textContent(), /Nouns/)
  assert.equal(await page.locator('#start').isDisabled(), true)
  await page.locator('#show-all-types').click()
  await page.waitForFunction(() => document.querySelector('#start')?.disabled === false && !document.querySelector('#show-all-types'))
  assert.deepEqual(await settings(), originalSettings, 'empty-match All button clears only wordTypes')
  await tab('Decks', '#/decks', 'Decks')
  assert.equal(await page.locator('[data-word-type="all"]').getAttribute('aria-pressed'), 'true')
  assert.deepEqual(await snapshot(), untypedFixture, 'empty-match recovery preserves cards, schedules and streaks')
  assert.deepEqual(errors, [], 'no browser errors')
  assert.deepEqual(externalRequests, [], 'no external service access')
  console.log('decks-ui: four tabs, distinct routes, deck count, Decks-only saved tier/direction/word-type controls, unsaved Cards filters, Review-only session size, Settings content, persisted review filters, All/last deselection, empty-match recovery, edit/import, German cards/schedules/streak preservation: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

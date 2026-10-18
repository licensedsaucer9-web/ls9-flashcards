// Synthetic local browser data only. The production-build phase verifies real SW offline reopen.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, preview } from 'vite'
import { chromium } from 'playwright-core'
const cacheDir = mkdtempSync(join(tmpdir(), 'starter-ui-'))
let server, browser, built
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4185, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  const external = [], errors = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    external.push(route.request().url()); return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:4185/')
  await page.waitForSelector('#start')
  const german = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.saveReview((await db.getAllCards())[0].id, 'good', crypto.randomUUID(), Date.now(), 'UTC')
    return { cards: await db.getAllCards(), deck: await db.getActiveDeck(), settings: await db.getSettings(), activity: await db.getReviewActivity() }
  })
  const tab = async path => { await page.locator(`.tabbar a[href="#${path}"]`).click() }
  const outcomes = []
  for (const [lang, name, word, article] of [['fr','French','école','l_f'], ['es','Spanish','agua','el_f']]) {
    await tab('/decks')
    await page.waitForSelector(`[data-starter="${lang}"]`)
    await page.click(`[data-starter="${lang}"]`)
    await page.waitForSelector('#start')
    const initial = await page.evaluate(async () => {
      const db = await import('/src/db.ts')
      return { deck: await db.getActiveDeck(), cards: await db.getAllCards() }
    })
    assert.equal(initial.deck.targetLang, name)
    assert.equal(initial.deck.direction, 'en-de', 'new language starters default to English questions')
    assert.equal(initial.cards.length, 567)
    assert(initial.cards.every(c => c.deckId === initial.deck.id))
    if (lang === 'fr') {
      // Regression: use the real seed card whose silent h previously rendered as "le homme".
      await page.evaluate(async () => {
        const db = await import('/src/db.ts')
        await db.putSettings({ tier: 3, sessionSize: 1 })
        await db.putCards((await db.getAllCards()).map(c => ({ ...c, srs: { ...c.srs, due: c.de === 'homme' ? 0 : Date.now() + 86400000 } })))
      })
      for (const dir of ['de-en', 'en-de']) {
        await tab('/decks')
        await page.locator(`[data-dir="${dir}"]`).click()
        await page.waitForFunction(dir => document.querySelector(`[data-dir="${dir}"]`)?.classList.contains('is-on'), dir)
        await tab('/')
        await page.click('#start')
        await page.waitForSelector('#card')
        const face = dir === 'de-en' ? '.front' : '.back'
        assert.equal(await page.locator(`${face} .word`).textContent(), 'l’homme')
        assert.match(await page.locator(`${face} .article`).textContent(), /masculine/)
        await page.click('#card')
        await page.locator('[data-grade="good"]').waitFor({ state: 'visible' })
        assert.equal(await page.locator('.example strong').textContent(), "Nous parlons de l'homme.")
        await page.screenshot({ path: join(tmpdir(), `issue96-homme-${dir}.png`) })
        await page.click('#back')
        await page.waitForSelector('#start')
      }
      await tab('/deck')
      await page.fill('#search', 'homme')
      await page.locator('.card-list .card-row').filter({ hasText: 'homme' }).first().click()
      await page.waitForSelector('#form')
      assert.equal(await page.locator('[name="article"]').inputValue(), 'l_m')
      assert.equal(await page.locator('[name="example_de"]').inputValue(), "Nous parlons de l'homme.")
    }
    if (lang === 'es') {
      // Check the shipped state examples on real review cards in both directions.
      for (const word of ['triste', 'cansado', 'enfermo', 'libre', 'nervioso']) {
        await page.evaluate(async word => {
          const db = await import('/src/db.ts')
          await db.putSettings({ tier: 3, sessionSize: 1 })
          await db.putCards((await db.getAllCards()).map(c => ({ ...c, srs: { ...c.srs, due: c.de === word ? 0 : Date.now() + 86400000 } })))
        }, word)
        for (const dir of ['de-en', 'en-de']) {
          await tab('/decks')
          await page.locator(`[data-dir="${dir}"]`).click()
          await page.waitForFunction(dir => document.querySelector(`[data-dir="${dir}"]`)?.classList.contains('is-on'), dir)
          await tab('/')
          await page.click('#start')
          await page.waitForSelector('#card')
          const face = dir === 'de-en' ? '.front' : '.back'
          assert.equal(await page.locator(`${face} .word`).textContent(), word)
          await page.click('#card')
          await page.locator('[data-grade="good"]').waitFor({ state: 'visible' })
          assert.equal(await page.locator('.example strong').textContent(), `Está ${word}.`)
          await page.screenshot({ path: join(tmpdir(), `issue96-es-${word}-${dir}.png`) })
          await page.click('#back')
          await page.waitForSelector('#start')
        }
      }
    }
    // Isolate one noun in the queue, exercising real grading with an elided/feminine article.
    await page.evaluate(async word => {
      const db = await import('/src/db.ts')
      const cards = await db.getAllCards()
      await db.putSettings({ tier: 3, sessionSize: 1 })
      await db.putCards(cards.map(c => ({ ...c, srs: { ...c.srs, due: c.de === word ? 0 : Date.now() + 86400000 } })))
    }, word)
    await tab('/decks')
    for (const dir of ['de-en', 'en-de']) {
      await page.locator(`[data-dir="${dir}"]`).click()
      await page.waitForFunction(dir => document.querySelector(`[data-dir="${dir}"]`)?.classList.contains('is-on'), dir)
      await tab('/')
      await page.waitForSelector('#start')
      await page.click('#start')
      await page.waitForSelector('#card')
      assert.equal(await page.locator('.front .prompt').textContent(), dir === 'de-en' ? name : 'English')
      const targetFace = dir === 'de-en' ? '.front' : '.back'
      assert.match(await page.locator(`${targetFace} .article`).textContent(), /feminine/)
      assert.equal(await page.locator(`${targetFace} .word`).textContent(), lang === 'fr' ? 'l’école' : 'el agua')
      if (dir === 'en-de') assert.equal(await page.locator('.front .article').count(), 0)
      await page.click('#card')
      await page.locator('[data-grade="wrong_gender"]').waitFor({ state: 'visible' })
      await page.screenshot({ path: join(tmpdir(), `issue96-${lang}-review.png`) })
      await page.click('[data-grade="wrong_gender"]')
      // Gender requeues immediately; exit while keeping the review and account streak event.
      await page.click('#back')
      await page.waitForSelector('#start')
      await tab('/decks')
    }
    await tab('/')
    await page.locator('[data-word-type="noun"]').click()
    await page.waitForFunction(() => document.querySelector('[data-word-type="noun"]')?.classList.contains('is-on'))
    await tab('/deck')
    await page.waitForSelector('#search')
    await page.fill('#search', word)
    await page.locator('.card-list .card-row').filter({ hasText: word }).first().click()
    await page.waitForSelector('#form')
    assert.equal(await page.locator('[name="article"]').inputValue(), article)
    const options = await page.locator('[name="article"] option').allTextContents()
    assert(options.every(o => !['der','die','das'].includes(o)))
    await page.fill('[name="en"]', `${lang} edited translation`)
    await page.click('#form [type="submit"]')
    await page.waitForSelector('#search')
    const retained = await page.evaluate(async () => {
      const db = await import('/src/db.ts')
      const cards = await db.getAllCards()
      const victim = cards.find(c => !c.en.includes('edited translation'))
      await db.deleteCard(victim.id)
      return { cards: await db.getAllCards(), deck: await db.getActiveDeck(), deleted: victim.id, activity: await db.getReviewActivity() }
    })
    await tab('/decks')
    assert.equal(await page.locator(`[data-delete-deck="${initial.deck.id}"]`).count(), 0)
    await page.waitForSelector(`[data-starter="${lang}"]`)
    await page.locator('h1').filter({ hasText: /^Decks$/ }).waitFor()
    await page.screenshot({ path: join(tmpdir(), `issue96-${lang}-decks.png`) })
    await page.click(`[data-starter="${lang}"]`)
    await page.waitForSelector('#start')
    await page.reload()
    await page.waitForSelector('#start')
    const after = await page.evaluate(async () => {
      const db = await import('/src/db.ts')
      return { cards: await db.getAllCards(), deck: await db.getActiveDeck(), activity: await db.getReviewActivity() }
    })
    assert.deepEqual(after.cards, retained.cards, 'repeat addition and reopen preserve edits, schedules and deletion')
    assert.deepEqual(after.deck, retained.deck, 'preferences and identity survive repeat addition')
    assert.deepEqual(after.activity, retained.activity)
    outcomes.push({ lang, ...after })
  }
  const originalAfter = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.switchActiveDeck('local-german')
    return { cards: await db.getAllCards(), deck: await db.getActiveDeck(), settings: await db.getSettings(), activity: await db.getReviewActivity() }
  })
  assert.deepEqual(originalAfter.cards, german.cards)
  assert.deepEqual(originalAfter.deck, german.deck)
  assert.equal(Object.keys(originalAfter.activity).length, Object.keys(german.activity).length + 4)
  for (const [id, event] of Object.entries(german.activity)) assert.deepEqual(originalAfter.activity[id], event)
  assert.equal(originalAfter.settings.direction, german.settings.direction)
  assert.deepEqual(originalAfter.settings.wordTypes, german.settings.wordTypes)
  // Separate synthetic account databases receive the same private starter ID on each device.
  const devices = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { bindStudyDatabase, clearStudyBinding } = await import('/src/study-lock.ts')
    const results = []
    try {
      for (const name of ['starter-device-one','starter-device-two']) {
        bindStudyDatabase({ uid: 'synthetic-starter-owner', dbName: name })
        const deck = await db.addStarterDeck('fr')
        results.push(deck.id)
      }
    } finally { clearStudyBinding() }
    return results
  })
  assert.equal(devices[0], devices[1])
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  await context.close()

  // CI's release build is Firebase; use its device-study route without signing in.
  // Locally npm run build creates the same offline assets in dist/.
  const outDir = process.env.STARTER_ARTIFACT_DIR || 'dist'
  if (!existsSync(join(outDir, 'sw.js'))) throw new Error(`Build ${outDir} before this test`)
  process.env.BASE = process.env.STARTER_APP_BASE || '/'
  built = await preview({ preview: { host: '127.0.0.1', port: 4186, strictPort: true }, build: { outDir } })
  const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const offlinePage = await offlineContext.newPage()
  const appBase = process.env.STARTER_APP_BASE || '/'
  await offlinePage.goto(`http://127.0.0.1:4186${appBase}`)
  const guest = offlinePage.getByRole('button', { name: 'Study on this device', exact: true })
  await offlinePage.waitForFunction(() => document.querySelector('#guest-study') || document.querySelector('#start'))
  if (await guest.count()) await guest.click()
  await offlinePage.waitForSelector('#start')
  await offlinePage.evaluate(() => navigator.serviceWorker.ready)
  await offlinePage.reload()
  await offlinePage.waitForFunction(() => !!navigator.serviceWorker.controller)
  for (const lang of ['fr', 'es']) {
    await offlinePage.locator('.tabbar a[href="#/decks"]').click()
    await offlinePage.click(`[data-starter="${lang}"]`)
    await offlinePage.waitForSelector('#start')
  }
  await offlineContext.setOffline(true)
  for (const [lang, name] of [['fr','French'],['es','Spanish']]) {
    await offlinePage.locator('.tabbar a[href="#/decks"]').click()
    await offlinePage.click(`[data-starter="${lang}"]`)
    await offlinePage.waitForSelector('#start')
    await offlinePage.reload()
    await offlinePage.waitForSelector('#start')
    await offlinePage.click('#start')
    await offlinePage.waitForSelector('#card')
    assert.equal(await offlinePage.locator('.front .prompt').textContent(), 'English')
    assert.equal(await offlinePage.locator('.back .prompt').textContent(), name)
    await offlinePage.click('#card')
    await offlinePage.locator('[data-grade="good"]').click()
    await offlinePage.click('#back')
    await offlinePage.waitForSelector('#start')
  }
  await offlineContext.close()
  console.log('starter decks UI: add/select, both directions, gender, editing, preferences, repeated add, deletion, German preservation, account-wide streak and built-PWA offline reopen/grade: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  if (built) await new Promise(resolve => built.httpServer.close(resolve))
  rmSync(cacheDir, { recursive: true, force: true })
}

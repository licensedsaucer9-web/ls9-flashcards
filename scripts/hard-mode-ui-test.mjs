import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'hard-mode-'))
let server, browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4193, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] })
  const errors = [], external = []
  for (const scenario of [
    { answers: ['die Katze'], grade: 'Easy', interval: 4, ease: 2.65 },
    { answers: ['Hund', 'die Katze'], grade: 'Good', interval: 1, ease: 2.5 },
    { answers: ['der Katze'], grade: 'Gender', interval: 0, ease: 2.4 },
    { answers: ['Hund', 'das Katze'], grade: 'Gender', interval: 0, ease: 2.4 },
    { answers: ['Hund', 'Vogel'], grade: 'Hard', interval: 1, ease: 2.35 },
    { answers: ['feline'], direction: 'de-en', grade: 'Easy', interval: 4, ease: 2.65 },
    { answers: ['die Katze'], failSave: true, grade: 'Easy', interval: 4, ease: 2.65 },
  ]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto('http://127.0.0.1:4193/')
    await page.waitForSelector('#start')
    const id = await page.evaluate(async direction => {
      const db = await import('/src/db.ts')
      const cards = await db.getAllCards()
      await db.putCards(cards.map((card, i) => ({ ...card,
        ...(i === 0 ? { de: 'Katze', en: 'cat / feline', article: 'die', example_de: 'Die Katze schläft.', example_en: 'The cat sleeps.' } : {}),
        srs: { ease: 2.5, interval: 0, reps: 0, due: i ? Date.now() + 86400000 : 0 },
      })))
      await db.putSettings({ direction: direction ?? 'en-de', tier: 3, selectedTiers: [1, 2, 3], wordTypes: [], sessionSize: 1 })
      return cards[0].id
    }, scenario.direction)
    await page.reload(); await page.waitForSelector('#start')
    await page.check('#hard-mode')
    await page.reload(); await page.waitForSelector('#hard-mode:checked')
    await page.click('#start'); await page.waitForSelector('#answer')
    assert.equal(await page.locator('#card, [data-grade]').count(), 0, 'no flip or manual grading in Hard mode')
    assert.equal(await page.locator('.typed-feedback').count(), 0, 'answer is hidden')
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 650 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'answer form fits phone widths')
    }
    if (scenario.grade === 'Good') await page.screenshot({ path: '/tmp/flashcards-hard-mode-input.png', fullPage: true })
    await page.locator('#answer').fill('  '); await page.locator('#answer').press('Enter')
    assert.equal(await page.locator('.typed-feedback').count(), 0, 'empty answers do not count')
    // Numeric grading shortcuts and spaces remain ordinary input.
    await page.locator('#answer').fill('')
    await page.keyboard.type('12345 a b')
    assert.equal(await page.locator('#answer').inputValue(), '12345 a b')
    for (let i = 0; i < scenario.answers.length; i++) {
      if (scenario.failSave) await page.evaluate(id => {
        const original = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (value, ...rest) {
          if (this.name === 'cards' && value.id === id) {
            IDBObjectStore.prototype.put = original
            throw new DOMException('Simulated full storage', 'QuotaExceededError')
          }
          return original.call(this, value, ...rest)
        }
      }, id)
      await page.locator('#answer').fill(scenario.answers[i])
      await page.locator('#answer').press('Enter')
      if (i < scenario.answers.length - 1) {
        await page.getByText('Not quite. Try once more.', { exact: true }).waitFor()
        assert.equal(await page.locator('.typed-feedback').count(), 0, 'first miss does not reveal the answer')
        const count = await page.evaluate(async () => Object.keys(await (await import('/src/db.ts')).getReviewActivity()).length)
        assert.equal(count, 0, 'first miss does not save progress or activity')
      }
    }
    if (scenario.failSave) {
      await page.getByRole('button', { name: 'Retry saving', exact: true }).waitFor()
      assert.equal(await page.evaluate(async () => Object.keys(await (await import('/src/db.ts')).getReviewActivity()).length), 0)
      await page.click('#typed-next')
    }
    await page.getByRole('button', { name: 'Next card', exact: true }).waitFor()
    assert.match(await page.locator('.typed-feedback .kicker').textContent(), new RegExp(`^${scenario.grade}`))
    const saved = await page.evaluate(async id => {
      const db = await import('/src/db.ts')
      return { card: await db.getCard(id), count: Object.keys(await db.getReviewActivity()).length }
    }, id)
    assert.equal(saved.count, 1, 'exactly one activity event per graded answer')
    assert.equal(saved.card.srs.interval, scenario.interval)
    assert.equal(saved.card.srs.ease, scenario.ease)
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 650 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone layout fits')
    }
    if (scenario.grade === 'Good') await page.screenshot({ path: '/tmp/flashcards-hard-mode-result.png', fullPage: true })
    await page.locator('#typed-next').focus(); await page.keyboard.press('Enter')
    if (scenario.grade === 'Gender') {
      await page.waitForSelector('#answer')
      assert.equal(await page.locator('#answer').inputValue(), '', 'gender-requeued card starts with fresh attempts')
      await page.locator('#answer').fill('die Katze'); await page.locator('#answer').press('Enter')
      await page.getByRole('button', { name: 'Next card', exact: true }).waitFor()
      assert.match(await page.locator('.typed-feedback .kicker').textContent(), /^Easy/)
      await page.click('#typed-next')
    }
    await page.waitForSelector('#review-more')
    await page.click('#home'); await page.waitForSelector('#start')
    await page.uncheck('#hard-mode'); await page.click('#start'); await page.waitForSelector('#card')
    await page.click('#card'); await page.waitForSelector('.grades:not([hidden])')
    await page.click('[data-grade="good"]'); await page.waitForSelector('#review-more')
    await context.close()
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('Hard mode UI: first/second try, immediate gender/requeue, hard, both directions, persistence, save recovery, keyboard, responsive layout, classic flow: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

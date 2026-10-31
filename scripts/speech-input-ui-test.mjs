// Exercise the optional Hard-mode mic in disposable browsers with a fake recognition API.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'speech-input-'))
const base = 'http://127.0.0.1:4197'
let server, browser
const fakeRecognition = () => {
  window.__listens = []
  window.__recs = []
  window.__aborts = 0
  window.__cancels = 0
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    speaking: false, pending: false, getVoices: () => [], speak() {}, cancel: () => { window.__cancels++ },
  } })
  delete window.SpeechRecognition
  window.webkitSpeechRecognition = class {
    constructor() { window.__recs.push(this) }
    start() { window.__listens.push({ lang: this.lang, continuous: this.continuous, interimResults: this.interimResults, cancels: window.__cancels }) }
    stop() {}
    abort() { window.__aborts++ }
  }
  window.__emit = (name, event = {}) => window.__recs.at(-1)[`on${name}`]?.(event)
  window.__result = (text, isFinal) => window.__emit('result', { results: [Object.assign([{ transcript: text }], { isFinal })] })
}
const noRecognition = () => {
  delete window.SpeechRecognition; delete window.webkitSpeechRecognition
}
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4197, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] })
  const errors = [], external = []
  const open = async init => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    await context.addInitScript(init)
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    return { context, page }
  }
  const seed = (page, direction) => page.evaluate(async direction => {
    const db = await import('/src/db.ts')
    const cards = await db.getAllCards()
    await db.putCards(cards.map((card, i) => ({ ...card,
      ...(i === 0 ? { de: 'Katze', en: 'cat', article: 'die' } : {}),
      srs: { ease: 2.5, interval: 0, reps: 0, due: i ? Date.now() + 86400000 : 0 },
    })))
    await db.putSettings({ direction, tier: 3, selectedTiers: [1, 2, 3], wordTypes: [], sessionSize: 1 })
  }, direction)
  const startReview = async page => {
    await page.goto(`${base}/#/`); await page.waitForSelector('#start')
    if (!await page.isChecked('#hard-mode')) await page.check('#hard-mode')
    await page.click('#start'); await page.waitForSelector('#answer')
    // Short cut-offs keep the test fast; the module is shared with the app.
    await page.evaluate(async () => (await import('/src/speech-input.ts')).setListenTimings({ startMs: 400, silenceMs: 300, stableMs: 150, hardMs: 700 }))
  }
  const mic = page => page.locator('[data-listen]')
  const status = async page => (await page.locator('#listen-status').textContent()).trim()
  const idle = page => page.waitForSelector('[data-listen][aria-pressed="false"]')

  const { context, page } = await open(fakeRecognition)
  await page.goto(`${base}/#/settings`)
  const toggle = page.getByRole('switch', { name: 'Speech input' })
  await toggle.waitFor()
  assert.equal(await toggle.isChecked(), false, 'speech input is off by default')
  assert.equal(await toggle.isDisabled(), false)
  assert.match(await page.locator('#speech-input-note').textContent(), /Apple or Google servers/)
  await seed(page, 'en-de')
  const settingsBefore = await page.evaluate(async () => (await import('/src/db.ts')).getSettings())
  await startReview(page)
  assert.equal(await mic(page).count(), 0, 'no mic in the DOM while the setting is off')

  await page.goto(`${base}/#/settings`); await toggle.waitFor()
  await toggle.check()
  await page.reload(); await toggle.waitFor()
  assert.equal(await toggle.isChecked(), true, 'setting survives reload')
  assert.equal(await page.evaluate(() => localStorage.getItem('german-flashcards.speech-input')), 'true')
  assert.deepEqual(await page.evaluate(async () => (await import('/src/db.ts')).getSettings()), settingsBefore, 'speech input is not a synced setting')

  await startReview(page)
  assert.equal(await mic(page).count(), 1, 'mic shown in Hard mode for en-de')
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 650 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'answer row fits phone widths')
  }

  // Silence cut-off: Safari never ends a silent attempt itself.
  const cancels = await page.evaluate(() => window.__cancels)
  await mic(page).click()
  let listens = await page.evaluate(() => window.__listens)
  assert.deepEqual(listens.at(-1), { lang: 'de-DE', continuous: false, interimResults: true, cancels: cancels + 1 }, 'speech output cancelled before listening, deck language used')
  assert.equal(await mic(page).getAttribute('aria-pressed'), 'true')
  assert.equal(await status(page), 'Starting…')
  await page.evaluate(() => window.__emit('start'))
  assert.equal(await status(page), 'Listening…')
  let aborts = await page.evaluate(() => window.__aborts)
  await idle(page)
  assert.match(await status(page), /catch that/)
  assert.equal(await page.inputValue('#answer'), '')
  assert.ok(await page.evaluate(() => window.__aborts) > aborts, 'silent attempt aborted')

  // Interim result with no final is accepted after the cut-off.
  await mic(page).click()
  await page.evaluate(() => { window.__emit('start'); window.__result('der Hund', false) })
  assert.equal(await status(page), 'Listening… der Hund')
  await idle(page)
  assert.equal(await page.inputValue('#answer'), 'der Hund', 'interim-only transcript fills the field')
  assert.equal(await page.locator('.typed-feedback').count(), 0, 'no auto-submit')

  // Hung session: interim results that never finalise hit the hard timeout.
  await mic(page).click()
  aborts = await page.evaluate(() => window.__aborts)
  await page.evaluate(() => {
    window.__emit('start')
    let n = 0
    window.__tick = setInterval(() => window.__result(`wort ${n++}`, false), 50)
  })
  await idle(page)
  await page.evaluate(() => clearInterval(window.__tick))
  assert.match(await page.inputValue('#answer'), /^wort \d+$/)
  assert.ok(await page.evaluate(() => window.__aborts) > aborts, 'hung session aborted')

  // A start that never happens times out instead of hanging in "Starting…".
  await mic(page).click()
  await idle(page)
  assert.match(await status(page), /did not start/)

  // audio-capture during an attempt ends it; the button stays usable.
  await mic(page).click()
  await page.evaluate(() => { window.__emit('start'); window.__emit('error', { error: 'audio-capture', message: 'Source is muted' }) })
  await idle(page)
  assert.match(await status(page), /microphone is not available/)

  // A late muted error after a finished attempt does not disturb the result or the next attempt.
  await mic(page).click()
  await page.evaluate(() => { window.__emit('start'); window.__result('Katze', true) })
  await idle(page)
  await page.evaluate(() => { window.__late = window.__recs.at(-1) })
  assert.equal(await page.inputValue('#answer'), 'Katze')
  await mic(page).click()
  await page.evaluate(() => {
    window.__late.onerror?.({ error: 'audio-capture', message: 'Source is muted' })
    window.__emit('start')
  })
  assert.equal(await mic(page).getAttribute('aria-pressed'), 'true', 'late error ignored by the new attempt')
  await page.evaluate(() => window.__result('die Katze', true))
  await idle(page)
  assert.equal(await page.inputValue('#answer'), 'die Katze', 'final transcript fills the field')
  assert.match(await status(page), /Heard: die Katze/)
  if (process.env.SPEECH_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-speech-input.png' })
  // Grading is the unchanged typed path.
  await page.click('#typed-answer button[type="submit"]')
  await page.waitForSelector('.typed-feedback')
  assert.match(await page.locator('.typed-feedback .kicker').textContent(), /^Easy/)
  assert.equal(await mic(page).count(), 0, 'no mic once the answer is revealed')

  // Leaving review and hiding the tab abort a running attempt.
  await startReview(page)
  await mic(page).click()
  await page.evaluate(() => window.__emit('start'))
  aborts = await page.evaluate(() => window.__aborts)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    delete document.visibilityState
  })
  assert.ok(await page.evaluate(() => window.__aborts) > aborts, 'hidden tab aborts listening')
  await idle(page)
  await mic(page).click()
  await page.evaluate(() => window.__emit('start'))
  aborts = await page.evaluate(() => window.__aborts)
  await page.click('#back'); await page.waitForSelector('#start')
  assert.ok(await page.evaluate(() => window.__aborts) > aborts, 'leaving review aborts listening')

  // de-en: the answer is in the base language, so no mic.
  await seed(page, 'de-en')
  await startReview(page)
  assert.equal(await mic(page).count(), 0, 'no mic when the answer is not in the target language')
  await page.evaluate(() => { location.hash = '#/' })
  await page.uncheck('#hard-mode')
  await page.click('#start'); await page.waitForSelector('#card')
  assert.equal(await mic(page).count(), 0, 'no mic in flip mode')
  await context.close()

  const missing = await open(noRecognition)
  await missing.page.goto(`${base}/#/settings`)
  await missing.page.evaluate(() => localStorage.setItem('german-flashcards.speech-input', 'true'))
  await missing.page.reload()
  const missingToggle = missing.page.getByRole('switch', { name: 'Speech input' })
  await missingToggle.waitFor()
  assert.equal(await missingToggle.isDisabled(), true, 'toggle disabled without the API')
  assert.match(await missing.page.locator('#speech-input-note').textContent(), /not available in this browser/)
  await seed(missing.page, 'en-de')
  await startReview(missing.page)
  assert.equal(await mic(missing.page).count(), 0, 'no mic without the API')
  await missing.context.close()

  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('speech input UI: default off, hidden/shown, deck language, final/interim/silence/hung/no-start, muted errors, abort on hide and leave, de-en and flip hidden, unavailable API: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

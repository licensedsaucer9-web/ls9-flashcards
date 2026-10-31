// Exercise the optional speak button in disposable browsers with a fake speech API.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'speech-'))
const base = 'http://127.0.0.1:4194'
let server, browser
const fakeSpeech = () => {
  window.__spoken = []
  window.__dropped = 0
  window.__cancels = 0
  // Like real engines: an utterance stays "speaking" until cancelled, and one
  // queued in the same turn as cancel() is silently dropped.
  let justCancelled = false
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.lang = ''; this.voice = null } }
  const synth = {
    speaking: false, pending: false,
    getVoices: () => [{ lang: 'en-US', name: 'US' }, { lang: 'en-GB', name: 'GB' }, { lang: 'de-AT', name: 'AT' }],
    speak: u => {
      if (justCancelled) { window.__dropped++; return }
      synth.speaking = true
      window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice?.name ?? null })
    },
    cancel: () => {
      window.__cancels++
      synth.speaking = false
      justCancelled = true
      setTimeout(() => { justCancelled = false }, 0)
    },
  }
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
}
const noSpeech = () => {
  delete window.speechSynthesis; delete window.SpeechSynthesisUtterance
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: undefined })
}
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4194, strictPort: true } })
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

  const { context, page } = await open(fakeSpeech)
  await page.goto(`${base}/#/settings`)
  const toggle = page.getByRole('switch', { name: 'Speech' })
  await toggle.waitFor()
  assert.equal(await toggle.isChecked(), false, 'speech is off by default')
  assert.equal(await toggle.isDisabled(), false)
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const cards = await db.getAllCards()
    await db.putCards(cards.map((card, i) => ({ ...card,
      ...(i < 2 ? { de: i ? 'Hund' : 'Katze', en: i ? 'dog' : 'cat', article: i ? 'der' : 'die' } : {}),
      srs: { ease: 2.5, interval: 0, reps: 0, due: i < 2 ? 0 : Date.now() + 86400000 },
    })))
    await db.putSettings({ direction: 'de-en', tier: 3, selectedTiers: [1, 2, 3], wordTypes: [], sessionSize: 2 })
  })
  const settingsBefore = await page.evaluate(async () => (await import('/src/db.ts')).getSettings())
  await page.goto(`${base}/#/`); await page.click('#start'); await page.waitForSelector('#card')
  assert.equal(await page.locator('[data-speak]').count(), 0, 'button hidden when the setting is off')

  await page.goto(`${base}/#/settings`); await toggle.waitFor()
  await toggle.check()
  await page.reload(); await toggle.waitFor()
  assert.equal(await toggle.isChecked(), true, 'setting survives reload')
  assert.equal(await page.evaluate(() => localStorage.getItem('german-flashcards.speech')), 'true')
  assert.deepEqual(await page.evaluate(async () => (await import('/src/db.ts')).getSettings()), settingsBefore, 'speech is not a synced setting')

  await page.goto(`${base}/#/`); await page.click('#start'); await page.waitForSelector('#card')
  const speakBtn = page.getByRole('button', { name: 'Speak word' })
  assert.equal(await speakBtn.count(), 1, 'button shown when on')
  const word = (await page.locator('.face.front .word').textContent()).trim()
  await speakBtn.click()
  assert.equal(await page.locator('#card.is-flipped').count(), 0, 'speaking does not flip the card')
  let spoken = await page.evaluate(() => window.__spoken)
  assert.deepEqual(spoken.at(-1), { text: word, lang: 'de-DE', voice: 'AT' }, 'front speaks the German word with a matching voice')
  await speakBtn.focus(); await page.keyboard.press('Enter')
  assert.equal(await page.locator('#card.is-flipped').count(), 0, 'keyboard activation speaks without flipping')
  await page.waitForFunction(() => window.__spoken.length === 2)
  assert.equal(await page.evaluate(() => window.__dropped), 0, 'replaying while speaking is not dropped after cancel')
  if (process.env.SPEECH_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-speech-front.png' })
  await page.click('#card'); await page.waitForSelector('.grades:not([hidden])')
  await page.getByRole('button', { name: 'Speak word' }).click()
  await page.waitForFunction(() => window.__spoken.length === 3)
  spoken = await page.evaluate(() => window.__spoken)
  assert.deepEqual(spoken.at(-1), { text: (await page.locator('.face.back .word').textContent()).trim(), lang: 'en-GB', voice: 'GB' }, 'back speaks English')
  if (process.env.SPEECH_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-speech-back.png' })
  const cancels = await page.evaluate(() => window.__cancels)
  await page.click('[data-grade="good"]'); await page.waitForSelector('#card:not(.is-flipped)')
  assert.ok(await page.evaluate(() => window.__cancels) > cancels, 'card change cancels speech')
  // Again on the last card requeues the same id; its answer must not keep playing.
  await page.getByRole('button', { name: 'Speak word' }).click()
  await page.waitForFunction(() => window.__spoken.length === 4)
  await page.click('#card'); await page.waitForSelector('.grades:not([hidden])')
  await page.getByRole('button', { name: 'Speak word' }).click()
  await page.waitForFunction(() => window.__spoken.length === 5)
  const requeued = (await page.locator('.face.front .word').textContent()).trim()
  await page.click('[data-grade="again"]'); await page.waitForSelector('#card:not(.is-flipped)')
  assert.equal((await page.locator('.face.front .word').textContent()).trim(), requeued, 'the same card is shown again')
  assert.equal(await page.evaluate(() => speechSynthesis.speaking), false, 'requeued card cancels the previous answer')
  const leaving = await page.evaluate(() => window.__cancels)
  await page.click('#back'); await page.waitForSelector('#start')
  assert.ok(await page.evaluate(() => window.__cancels) > leaving, 'leaving review cancels speech')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout fits')
  // Hard mode: speak the prompt, then the answer once it is revealed.
  await page.check('#hard-mode'); await page.click('#start'); await page.waitForSelector('#answer')
  assert.equal(await page.locator('.typed-card [data-speak="front"]').count(), 1, 'hard mode prompt has a speak button')
  assert.equal(await page.locator('[data-speak="back"]').count(), 0, 'answer is not speakable before it is revealed')
  let count = await page.evaluate(() => window.__spoken.length)
  await page.click('[data-speak="front"]')
  await page.waitForFunction(n => window.__spoken.length > n, count)
  assert.equal((await page.evaluate(() => window.__spoken)).at(-1).lang, 'de-DE')
  for (let i = 0; i < 2; i++) { await page.fill('#answer', 'zzz'); await page.press('#answer', 'Enter') }
  await page.waitForSelector('.typed-feedback [data-speak="back"]')
  count = await page.evaluate(() => window.__spoken.length)
  await page.click('[data-speak="back"]')
  await page.waitForFunction(n => window.__spoken.length > n, count)
  assert.equal((await page.evaluate(() => window.__spoken)).at(-1).lang, 'en-GB')
  assert.equal(await page.evaluate(() => window.__dropped), 0, 'no utterance was dropped')
  if (process.env.SPEECH_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-speech-hard.png' })
  await context.close()

  const missing = await open(noSpeech)
  await missing.page.goto(`${base}/#/settings`)
  await missing.page.evaluate(() => localStorage.setItem('german-flashcards.speech', 'true'))
  await missing.page.reload()
  const missingToggle = missing.page.getByRole('switch', { name: 'Speech' })
  await missingToggle.waitFor()
  assert.equal(await missingToggle.isDisabled(), true, 'toggle disabled without the API')
  assert.match(await missing.page.locator('#speech-note').textContent(), /not available in this browser/)
  await missing.page.goto(`${base}/#/`); await missing.page.click('#start'); await missing.page.waitForSelector('#card')
  assert.equal(await missing.page.locator('[data-speak]').count(), 0, 'button hidden when the API is unavailable')
  await missing.context.close()

  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('speech UI: default off, hidden/shown, front/back languages and voices, keyboard, hard mode, cancel on card change, requeue and leave, no dropped restarts, unavailable API: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

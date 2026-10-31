// Exercise the standalone speech recognition device test page with a fake recognition API.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'speech-page-'))
const base = 'http://127.0.0.1:4195'
let server, browser

// Fires the usual Safari-like event sequence; window.__scenario = 'error' fails instead.
const fakeRecognition = () => {
  window.__recognitions = []
  window.__spoken = []
  window.__dropped = []
  let active = null, cancelledThisTurn = false
  class FakeRecognition extends EventTarget {
    constructor() { super(); this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; window.__recognitions.push(this) }
    fire(type, props = {}) { const ev = new Event(type); Object.assign(ev, props); this.dispatchEvent(ev) }
    start() {
      this.started = true
      const alts = (list, isFinal) => Object.assign(list.slice(0, this.maxAlternatives).map(([transcript, confidence]) => ({ transcript, confidence })), { isFinal })
      const steps = window.__scenario === 'error'
        ? [['start'], ['error', { error: 'not-allowed', message: 'Permission denied' }], ['end']]
        : [['start'], ['audiostart'], ['soundstart'], ['speechstart'],
          ['result', { resultIndex: 0, results: [alts([['der', 0]], false)] }],
          ['result', { resultIndex: 0, results: [alts([['der Hund', 0.92], ['der Hunt', 0.4], ['Dahun', 0.1]], true)] }],
          ['speechend'], ['soundend'], ['audioend'], ['end']]
      steps.forEach(([type, props], i) => setTimeout(() => this.fire(type, props), 10 * (i + 1)))
    }
    stop() { this.stopped = true }
    abort() { this.aborted = true }
  }
  // Chromium ships its own constructors; replace them so only the Safari-style prefix exists.
  Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined })
  Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeRecognition })
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.lang = ''; this.voice = null } }
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => [{ name: 'Anna', lang: 'de-DE' }, { name: 'Daniel', lang: 'en-GB' }],
    // Like real engines: cancel() interrupts the current utterance and drops one queued in the same turn.
    cancel() {
      const u = active; active = null
      if (u) setTimeout(() => u.onerror?.({ error: 'interrupted' }))
      cancelledThisTurn = true; setTimeout(() => { cancelledThisTurn = false })
    },
    speak(u) {
      if (cancelledThisTurn) { window.__dropped.push(u.text); return }
      window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice?.name ?? null, recognitionsBefore: window.__recognitions.length })
      active = u
      setTimeout(() => { if (active === u) u.onstart?.() }, 5)
      setTimeout(() => { if (active === u) { active = null; u.onend?.() } }, window.__ttsMs ?? 20)
    },
  } })
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

try {
  assert.ok(existsSync('public/speech-test.html'), 'page ships from public/')
  for (const file of ['index.html', ...filesUnder('src')]) {
    assert.ok(!readFileSync(file, 'utf8').includes('speech-test'), `${file} must not link the speech test page`)
  }

  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4195, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] })
  const errors = [], external = []
  const open = async init => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
      external.push(route.request().url()); return route.abort()
    })
    if (init) await context.addInitScript(init)
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    return { context, page }
  }

  // The main app has no link to the page.
  {
    const { context, page } = await open()
    for (const route of ['#/', '#/settings', '#/decks']) {
      await page.goto(`${base}/${route}`); await page.waitForLoadState('networkidle')
      assert.equal(await page.locator('[href*="speech-test"]').count(), 0, `no link on ${route}`)
      assert.ok(!(await page.content()).includes('speech-test'), `no reference on ${route}`)
    }
    await context.close()
  }

  const { context, page } = await open(fakeRecognition)
  await page.goto(`${base}/speech-test.html`)
  await page.getByRole('button', { name: 'Start listening' }).waitFor()
  const env = await page.locator('#env').textContent()
  assert.match(env, /webkitSpeechRecognitionyes/, 'detects the webkit constructor')
  assert.match(env, /SpeechRecognitionno/, 'reports the unprefixed constructor as missing')
  assert.match(env, /usingwebkitSpeechRecognition/)
  assert.match(env, /speechSynthesisyes/)
  assert.match(env, /navigator\.standalone/)
  assert.match(env, /display-modebrowser/)
  assert.equal(await page.locator('#expected').inputValue(), 'der Hund', 'German is the default with a suggested phrase')
  for (const [lang, phrase] of [['es-ES', 'el perro'], ['nb-NO', 'hunden'], ['en-GB', 'the dog'], ['de-DE', 'der Hund']]) {
    await page.selectOption('#lang', lang)
    assert.equal(await page.locator('#expected').inputValue(), phrase, `${lang} suggests ${phrase}`)
  }

  await page.getByRole('button', { name: 'Start listening' }).click()
  await page.waitForFunction(() => document.getElementById('status').textContent === 'done')
  const settings = await page.evaluate(() => { const r = window.__recognitions[0]; return { lang: r.lang, continuous: r.continuous, interimResults: r.interimResults, maxAlternatives: r.maxAlternatives } })
  assert.deepEqual(settings, { lang: 'de-DE', continuous: false, interimResults: true, maxAlternatives: 5 })
  const log = await page.locator('#log').textContent()
  for (const type of ['start()', 'start', 'audiostart', 'soundstart', 'speechstart', 'result', 'speechend', 'soundend', 'audioend', 'end']) {
    assert.match(log, new RegExp(`#1 \\+\\d+ms ${type.replace(/[()]/g, '\\$&')}(\\s|$)`, 'm'), `logs ${type}`)
  }
  assert.equal(await page.locator('#live').textContent(), 'der Hund')
  assert.equal(await page.locator('#alts tbody tr').count(), 3, 'shows every alternative')
  assert.match(await page.locator('#alts tbody').textContent(), /der Hund0\.9201\.00/)
  assert.notEqual(await page.locator('#timings').textContent(), '', 'shows timings')

  // Speak-then-listen starts recognition only after the utterance ends.
  await page.getByRole('button', { name: 'Speak phrase, then listen' }).click()
  await page.waitForFunction(() => window.__recognitions.length === 2 && document.getElementById('status').textContent === 'done')
  assert.deepEqual(await page.evaluate(() => window.__spoken), [{ text: 'der Hund', lang: 'de-DE', voice: 'Anna', recognitionsBefore: 1 }])
  const ttsTypes = (await page.locator('#log').textContent()).split('\n').filter(l => l.startsWith('#2 ')).map(l => l.replace(/^#2 \+\d+ms /, '').split(' ')[0])
  assert.deepEqual(ttsTypes.slice(0, 5), ['tts', 'tts', 'tts', 'start()', 'start'], 'recognition starts after the utterance ends')
  assert.match(await page.locator('#log').textContent(), /#2 \+\d+ms tts end\n#2 \+\d+ms start\(\)/)

  // Stopping or aborting while speaking closes the attempt without starting recognition.
  await page.evaluate(() => { window.__ttsMs = 5000 })
  for (const [n, name] of [[3, 'Stop'], [4, 'Abort']]) {
    await page.getByRole('button', { name: 'Speak phrase, then listen' }).click()
    await page.waitForFunction(n => new RegExp(`#${n} \\+\\d+ms tts start`).test(document.getElementById('log').textContent), n)
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => window.__recognitions.length), 2, `${name} while speaking starts no recognition`)
    assert.equal(await page.locator('#status').textContent(), 'done')
    assert.equal(await page.getByRole('button', { name: 'Start listening' }).isDisabled(), false, `${name} re-enables Start`)
    assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true)
  }
  await page.evaluate(() => { window.__ttsMs = 20 })
  assert.deepEqual(await page.evaluate(() => window.__dropped), [], 'no utterance is dropped after cancel()')

  // Errors are logged with their code and message.
  await page.evaluate(() => { window.__scenario = 'error' })
  await page.uncheck('#interim'); await page.check('#continuous'); await page.fill('#maxAlt', '3')
  await page.getByRole('button', { name: 'Start listening' }).click()
  await page.waitForFunction(() => window.__recognitions.length === 3 && /#5 \+\d+ms end/.test(document.getElementById('log').textContent))
  assert.match(await page.locator('#log').textContent(), /#5 \+\d+ms error error=not-allowed message="Permission denied"/)
  assert.match(await page.locator('#status').textContent(), /error: not-allowed/)

  // Report, copied through the clipboard API when allowed.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await page.getByRole('button', { name: 'Copy results' }).click()
  await page.waitForFunction(() => /Copied/.test(document.getElementById('copyStatus').textContent))
  const report = await page.evaluate(() => navigator.clipboard.readText())
  const untimed = text => text.replace(/^time: .*$/m, '')
  assert.equal(untimed(report), untimed(await page.locator('#report').inputValue()))
  assert.match(report, /userAgent: .*HeadlessChrome/)
  assert.match(report, /webkitSpeechRecognition: yes/)
  assert.match(report, /## Attempts \(5\)/)
  assert.match(report, /### #1 listen lang=de-DE continuous=false interimResults=true maxAlternatives=5/)
  assert.match(report, /\[0\.0\] "der Hund" conf=0\.920 match=1\.00/)
  assert.match(report, /\[0\.1\] "der Hunt" conf=0\.400 match=0\.88/)
  assert.match(report, /interim \(1\): \+\d+ "der"/)
  assert.match(report, /timings: tap → start\(\)=\d+ms, tap → start event=\d+ms, tap → first result=\d+ms, tap → first final=\d+ms, total \(tap → end\)=\d+ms/)
  assert.match(report, /events: start\(\)@\d+ start@\d+ audiostart@\d+ soundstart@\d+ speechstart@\d+ speechend@\d+ soundend@\d+ audioend@\d+ end@\d+/)
  assert.match(report, /### #2 speak-then-listen[\s\S]*tts: "der Hund" voice=Anna de-DE/)
  assert.match(report, /### #5 listen lang=de-DE continuous=true interimResults=false maxAlternatives=3[\s\S]*errors: not-allowed "Permission denied"/)

  // Without clipboard access the report stays selectable in the textarea.
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.execCommand = () => false })
  await page.getByRole('button', { name: 'Copy results' }).click()
  assert.match(await page.locator('#copyStatus').textContent(), /Copy failed .*Select the text below/)
  assert.equal(await page.evaluate(() => { const t = document.getElementById('report'); return t.value.slice(t.selectionStart, t.selectionEnd) }), await page.locator('#report').inputValue())
  if (process.env.SPEECH_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-speech-test-page.png', fullPage: true })
  await context.close()

  // Clearing while speaking cancels the utterance and starts no recognition.
  {
    const { context, page } = await open(fakeRecognition)
    await page.goto(`${base}/speech-test.html`)
    await page.evaluate(() => { window.__ttsMs = 5000 })
    await page.getByRole('button', { name: 'Speak phrase, then listen' }).click()
    await page.waitForFunction(() => /#1 \+\d+ms tts start/.test(document.getElementById('log').textContent))
    await page.getByRole('button', { name: 'Clear attempts' }).click()
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => window.__recognitions.length), 0, 'Clear while speaking starts no recognition')
    assert.equal(await page.locator('#log').textContent(), '')
    assert.equal(await page.getByRole('button', { name: 'Speak phrase, then listen' }).isDisabled(), false)
    await context.close()
  }

  // No API: the page still loads and says so.
  {
    const { context, page } = await open(() => {
      for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) Object.defineProperty(window, name, { configurable: true, value: undefined })
    })
    await page.goto(`${base}/speech-test.html`)
    await page.locator('#status').filter({ hasText: 'not supported' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Start listening' }).isDisabled(), true)
    assert.match(await page.locator('#env').textContent(), /usingnone/)
    await context.close()
  }

  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  console.log('speech test page checks passed')
} finally {
  await browser?.close()
  await server?.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

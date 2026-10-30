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
  assert.deepEqual(await select.locator('option').evaluateAll(options => options.map(o => [o.value, o.textContent])), [
    ['dark', 'Dark'], ['light', 'Light'], ['halloween', 'Halloween'], ['christmas', 'Christmas'], ['neopunk', 'NeoPunk'], ['nature', 'Nature'], ['coffee', 'Coffee'],
  ], 'picker lists every theme')
  const seasonal = { halloween: ['#120b1a', 'dark'], christmas: ['#0d2618', 'dark'], neopunk: ['#07060d', 'dark'], nature: ['#f2f0e1', 'light'], coffee: ['#1c120b', 'dark'] }
  for (const [theme, [bg, scheme]] of Object.entries(seasonal)) {
    await select.selectOption(theme)
    assert.deepEqual(await palette(), { bg, scheme, meta: bg }, `${theme} palette and theme-color`)
    const worst = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      const lum = name => {
        const hex = css.getPropertyValue(`--${name}`).trim()
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
          .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      let min = Infinity, pair = ''
      for (const fg of ['text', 'muted', 'der', 'die', 'das', 'none', 'again', 'hard', 'good', 'easy', 'gender']) {
        for (const bg of ['bg', 'bg-elev', 'surface', 'surface-2']) {
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
          const ratio = (hi + 0.05) / (lo + 0.05)
          if (ratio < min) { min = ratio; pair = `${fg} on ${bg}` }
        }
      }
      return { min, pair }
    })
    assert.ok(worst.min >= 4.5, `${theme} text contrast ${worst.min.toFixed(2)} (${worst.pair}) meets WCAG AA`)
    if (process.env.THEME_SCREENSHOTS) await page.screenshot({ path: `/tmp/flashcards-theme-${theme}.png`, fullPage: true })
    await page.reload(); await select.waitFor()
    assert.equal(await select.inputValue(), theme, `${theme} survives reload`)
  }
  // NeoPunk effects: animated glitch normally, nothing moving under reduced motion,
  // and the scanline layer never intercepts pointer input.
  await select.selectOption('neopunk')
  const effects = () => page.evaluate(() => {
    const h1 = getComputedStyle(document.querySelector('.topbar h1'))
    const scan = getComputedStyle(document.body, '::before')
    const control = document.querySelector('#theme').getBoundingClientRect()
    return {
      glitch: h1.animationName, upper: h1.textTransform, glow: h1.textShadow !== 'none',
      running: document.getAnimations().length,
      scanPointer: scan.pointerEvents, scanBehind: Number(scan.zIndex) < 0, scanPosition: scan.position,
      hit: document.elementFromPoint(control.x + control.width / 2, control.y + control.height / 2)?.id,
    }
  })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const moving = await effects()
  assert.equal(moving.glitch, 'neopunk-glitch', 'NeoPunk headings glitch')
  assert.ok(moving.running > 0, 'glitch animation runs')
  assert.equal(moving.upper, 'uppercase'); assert.ok(moving.glow, 'headings glow')
  assert.deepEqual([moving.scanPointer, moving.scanBehind, moving.scanPosition, moving.hit], ['none', true, 'fixed', 'theme'], 'scanlines stay behind content and pass pointer events')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const still = await effects()
  assert.equal(still.glitch, 'none', 'reduced motion disables the glitch')
  assert.equal(still.running, 0, 'reduced motion leaves no running animations')
  assert.ok(still.glow, 'static glow remains under reduced motion')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.primary, .secondary, select')).transitionDuration), '0s')
  if (process.env.THEME_SCREENSHOTS) await page.screenshot({ path: '/tmp/flashcards-theme-neopunk-reduced.png', fullPage: true })
  await page.emulateMedia({ reducedMotion: null })
  await select.selectOption('dark')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar h1')).animationName), 'none', 'other themes do not glitch')
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
  console.log('themes UI: keyboard switching, all seven palettes and contrast, NeoPunk effects and reduced motion, mobile/desktop, reload, navigation/review, data preservation, invalid/blocked storage: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

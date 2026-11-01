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
    ['dark', 'Dark'], ['light', 'Light'], ['halloween', 'Halloween'], ['christmas', 'Christmas'], ['neopunk', 'NeoPunk'], ['nature', 'Nature'], ['coffee', 'Coffee'], ['dissonant', 'Dissonant'],
    ['pink', 'Cute Pink'], ['mint', 'Mint'], ['lavender', 'Lavender'],
  ], 'picker lists every theme')
  const seasonal = { halloween: ['#120b1a', 'dark'], christmas: ['#0d2618', 'dark'], neopunk: ['#07060d', 'dark'], nature: ['#f2f0e1', 'light'], coffee: ['#1c120b', 'dark'], dissonant: ['#2a1636', 'dark'], pink: ['#fdeef4', 'light'], mint: ['#e8f7ef', 'light'], lavender: ['#f1ecfb', 'light'] }
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
  // The NeoPunk card glow must not hide the der/die/das ring on noun cards.
  const rings = await page.evaluate(() => ['der', 'die', 'das', ''].map(gender => {
    const face = document.createElement('div')
    face.className = gender ? `face gender-${gender}` : 'face'
    document.body.append(face)
    const shadow = getComputedStyle(face).boxShadow
    face.remove()
    return shadow
  }))
  assert.deepEqual(rings.map(shadow => shadow.includes('inset')), [true, true, true, false], 'NeoPunk keeps gender rings on noun cards')
  assert.equal(new Set(rings).size, 4, 'each gender ring has its own colour')
  await page.emulateMedia({ reducedMotion: null })
  // Dissonant (jarring accents) and the pastels (soft surfaces, deeper accent):
  // every rendered text sits on its surface at AA contrast and UI boundaries
  // reach 3:1, in Settings and on Review.
  const rendered = () => page.evaluate(() => {
    // color-mix() computes to color(srgb r g b / a) with 0–1 channels.
    const rgb = value => (value.match(/[\d.]+/g) || []).map(Number).map((v, i) => value.startsWith('color(srgb') && i < 3 ? v * 255 : v)
    const lum = ([r, g, b]) => [r, g, b].map(v => v / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
    const surface = el => {
      for (let node = el; node; node = node.parentElement) {
        const c = rgb(getComputedStyle(node).backgroundColor)
        if (c.length === 3 || c[3] > 0) return c
      }
      return rgb(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => `${parseInt(r, 16)} ${parseInt(g, 16)} ${parseInt(b, 16)}`))
    }
    const failures = []
    const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
    for (const el of document.querySelectorAll('.screen *, .tabbar *')) {
      if (!visible(el) || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
      // Composite the text over its surface, including opacity on the way up to it.
      const [fr, fg, fb, fa = 1] = rgb(getComputedStyle(el).color), bg = surface(el)
      let alpha = fa
      for (let node = el; node; node = node.parentElement) {
        const css = getComputedStyle(node), c = rgb(css.backgroundColor)
        if (node !== el && (c.length === 3 || c[3] > 0)) break
        alpha *= Number(css.opacity)
      }
      const r = ratio([fr, fg, fb].map((v, i) => v * alpha + bg[i] * (1 - alpha)), bg)
      if (r < 4.5) failures.push(`${el.tagName.toLowerCase()}.${el.className} "${el.textContent.trim().slice(0, 20)}" ${r.toFixed(2)}`)
    }
    for (const el of document.querySelectorAll('.screen :is(button, input, select, textarea, .grade)')) {
      const css = getComputedStyle(el)
      if (!visible(el) || parseFloat(css.borderTopWidth) === 0) continue
      const r = ratio(rgb(css.borderTopColor), surface(el.parentElement))
      if (r < 3) failures.push(`border ${el.tagName.toLowerCase()}#${el.id}.${el.className} ${r.toFixed(2)}`)
    }
    return { failures, checked: document.querySelectorAll('.screen *').length, running: document.getAnimations().length }
  })
  const accents = {}
  for (const [theme, label] of [['dissonant', 'Dissonant'], ['pink', 'Cute Pink'], ['mint', 'Mint'], ['lavender', 'Lavender']]) {
    await page.goto('http://127.0.0.1:4191/#/settings'); await select.waitFor()
    await select.selectOption(theme)
    const settingsCheck = await rendered()
    assert.deepEqual(settingsCheck.failures, [], `${label} Settings text and controls meet WCAG AA`)
    assert.equal(settingsCheck.running, 0, `${label} has no animations`)
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar h1')).animationName), 'none')
    await page.goto('http://127.0.0.1:4191/#/'); await page.waitForSelector('#start')
    assert.deepEqual((await rendered()).failures, [], `${label} home and primary button meet WCAG AA`)
    await page.hover('.tab.is-active')
    assert.deepEqual((await rendered()).failures, [], `${label} hovered active tab meets WCAG AA`)
    await page.mouse.move(0, 0)
    accents[theme] = await page.evaluate(() => getComputedStyle(document.querySelector('#start')).backgroundColor)
    await page.click('#start'); await page.waitForSelector('#card')
    assert.deepEqual((await rendered()).failures, [], `${label} Review front meets WCAG AA`)
    await page.click('#card'); await page.waitForSelector('.grades:not([hidden])')
    assert.deepEqual((await rendered()).failures, [], `${label} Review grades meet WCAG AA`)
    if (process.env.THEME_SCREENSHOTS) await page.screenshot({ path: `/tmp/flashcards-theme-${theme}-review.png`, fullPage: true })
    for (const route of ['/deck', '/decks']) {
      await page.goto(`http://127.0.0.1:4191/#${route}`); await page.waitForSelector('.screen')
      assert.deepEqual((await rendered()).failures, [], `${label} ${route} meets WCAG AA`)
    }
  }
  assert.equal(new Set([accents.pink, accents.mint, accents.lavender]).size, 3, 'each pastel has its own accent')
  await page.goto('http://127.0.0.1:4191/#/settings'); await select.waitFor()
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
  console.log('themes UI: keyboard switching, all eleven palettes and contrast, Dissonant and pastel rendered contrast, NeoPunk effects, gender rings and reduced motion, mobile/desktop, reload, navigation/review, data preservation, invalid/blocked storage: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

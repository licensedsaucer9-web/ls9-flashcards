// With the app worker controlling the tab, standalone *.html pages must come from the network, not the app shell.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, preview } from 'vite'
import { chromium } from 'playwright-core'

const outDir = mkdtempSync(join(tmpdir(), 'sw-nav-'))
const userDataDir = mkdtempSync(join(tmpdir(), 'sw-nav-profile-'))
const basePath = '/ls9-flashcards-site/'
const base = `http://127.0.0.1:4196${basePath}`
let server, context

try {
  process.env.BASE = basePath
  process.env.VITE_SYNC_BACKEND = ''
  await build({ logLevel: 'warn', build: { outDir, emptyOutDir: true } })

  const sw = readFileSync(join(outDir, 'sw.js'), 'utf8')
  assert.ok(!sw.includes('speech-test.html'), 'speech-test.html is not precached')
  assert.ok(sw.includes('"index.html"'), 'the app shell is precached')
  const denylist = [...sw.matchAll(/denylist:\[(.*?)\]\}/g)]
  assert.equal(denylist.length, 1, 'one navigation route with a denylist')
  const patterns = Function(`return [${denylist[0][1]}]`)()
  // NavigationRoute tests pathname + search against each pattern.
  const denied = path => patterns.some(re => re.test(path))
  for (const path of ['speech-test.html', 'speech-test.html?v=1d5f6bd', 'other.html', 'sub/page.html?x=1', 'auth-spike/rehearsal/', 'auth-spike-prod/x']) {
    assert.ok(denied(basePath + path), `${path} bypasses the app shell`)
  }
  for (const path of ['', '?v=1', 'index.html', 'index.html?v=1', 'settings', 'x.htmlx', '?next=a.html']) {
    assert.ok(!denied(basePath + path), `${path || '(root)'} still gets the app shell`)
  }

  server = await preview({ logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 4196, strictPort: true } })
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox'], viewport: { width: 390, height: 844 },
  })
  const page = context.pages()[0] || await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(base, { waitUntil: 'load' })
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload({ waitUntil: 'load' })
  assert.ok(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'app worker controls the tab')

  for (const path of ['speech-test.html', 'speech-test.html?v=1d5f6bd']) {
    const response = await page.goto(base + path, { waitUntil: 'load' })
    assert.ok(!response.fromServiceWorker(), `${path} comes from the network`)
    await page.getByRole('button', { name: 'Start listening' }).waitFor()
    assert.equal(await page.locator('#app').count(), 0, `${path} is not the app shell`)
  }

  // The app shell is still served offline, including with a query string.
  await context.setOffline(true)
  for (const path of ['', 'index.html?v=1']) {
    const response = await page.goto(base + path, { waitUntil: 'load' })
    assert.ok(response.fromServiceWorker(), `${path || '(root)'} comes from the worker offline`)
    await page.locator('#app').waitFor({ state: 'attached' })
  }
  // Offline, the standalone page fails instead of showing the app.
  await assert.rejects(page.goto(base + 'speech-test.html?v=2'), 'speech-test.html is not served from cache offline')
  await context.setOffline(false)

  assert.deepEqual(errors, [])
  console.log('service worker navigation checks passed')
} finally {
  await context?.close()
  await server?.close()
  rmSync(outDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
}

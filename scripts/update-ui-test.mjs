// Exercise Settings → Check for update against a mocked release.json.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'update-'))
const base = 'http://127.0.0.1:4196'
const appCache = `workbox-precache-v2-${base}/`
const otherCaches = ['other-app-cache', `workbox-precache-v2-${base}/elsewhere/`]
let server, browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4196, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] })
  const errors = [], external = []
  const open = async release => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const requests = []
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.hostname !== '127.0.0.1') { external.push(url.href); return route.abort() }
      if (url.pathname === '/release.json') {
        requests.push(url)
        return release(route)
      }
      return route.continue()
    })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${base}/#/settings`)
    await page.getByRole('button', { name: 'Check for update' }).waitFor()
    const running = {
      version: await page.locator('#app-version').getAttribute('data-version'),
      sourceCommit: await page.locator('#app-version').getAttribute('data-source'),
    }
    return { context, page, requests, running }
  }
  const json = body => route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const seed = async page => page.evaluate(async ({ appCache, otherCaches }) => {
    const db = await import('/src/db.ts')
    const cards = await db.getAllCards()
    await db.putCards([{ ...cards[0], de: 'Bewahrt', en: 'preserved' }])
    localStorage.setItem('ls9-update-test', 'keep me')
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('ls9-update-test-db', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('s')
      req.onsuccess = () => { const tx = req.result.transaction('s', 'readwrite'); tx.objectStore('s').put('kept', 'k'); tx.oncomplete = () => { req.result.close(); resolve() }; tx.onerror = () => reject(tx.error) }
      req.onerror = () => reject(req.error)
    })
    for (const name of [appCache, ...otherCaches]) await (await caches.open(name)).put('/probe', new Response('x'))
    window.__notReloaded = true
  }, { appCache, otherCaches })
  const snapshot = page => page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const cards = await db.getAllCards()
    const extra = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ls9-update-test-db', 1)
      req.onsuccess = () => { const get = req.result.transaction('s').objectStore('s').get('k'); get.onsuccess = () => { req.result.close(); resolve(get.result) } }
      req.onerror = () => reject(req.error)
    })
    const storage = Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]))
    return { cards: cards.length, first: cards.find(card => card.de === 'Bewahrt')?.en ?? null, extra, storage, caches: (await caches.keys()).sort() }
  })

  // Up to date: same version and commit → message, no reload, caches kept.
  {
    let running
    const up = await open(route => json(running)(route))
    running = up.running
    await seed(up.page)
    await up.page.click('#check-update')
    await up.page.waitForFunction(() => /You're up to date/.test(document.querySelector('#update-status')?.textContent ?? ''))
    assert.match(await up.page.locator('#update-status').textContent(), new RegExp(running.version.replace(/\./g, '\\.')))
    await up.page.waitForTimeout(300)
    assert.equal(await up.page.evaluate(() => window.__notReloaded), true, 'up-to-date check does not reload')
    assert.equal((await snapshot(up.page)).caches.includes(appCache), true, 'up-to-date check keeps caches')
    assert.equal(up.requests.length, 1)
    assert.ok(up.requests[0].searchParams.has('ls9-update'), 'release.json request is cache-busted')
    await up.context.close()
  }

  // Update available: app caches cleared, page hard-reloaded, user data kept.
  {
    const next = await open(json({ schema: 1, version: '99.0.0', sourceCommit: 'f'.repeat(40) }))
    await seed(next.page)
    const before = await snapshot(next.page)
    const reload = next.page.waitForRequest(r => r.resourceType() === 'document' && new URL(r.url()).searchParams.has('ls9-update'))
    await next.page.click('#check-update')
    await reload
    await next.page.waitForLoadState('load')
    await next.page.getByRole('button', { name: 'Check for update' }).waitFor()
    assert.equal(await next.page.evaluate(() => window.__notReloaded), undefined, 'page reloaded')
    assert.equal(new URL(next.page.url()).searchParams.has('ls9-update'), false, 'cache-bust query removed after reload')
    assert.equal(new URL(next.page.url()).hash, '#/settings')
    const after = await snapshot(next.page)
    assert.deepEqual(after.caches, [...otherCaches].sort(), 'only this app\'s Workbox caches are deleted')
    assert.deepEqual({ ...after, caches: null }, { ...before, caches: null }, 'localStorage and IndexedDB preserved')
    assert.equal(after.first, 'preserved'); assert.equal(after.extra, 'kept'); assert.equal(after.storage['ls9-update-test'], 'keep me')
    await next.context.close()
  }

  // Errors: offline, HTTP failure, unreadable body → friendly message, no reload.
  for (const [name, release, pattern] of [
    ['offline', route => route.abort('internetdisconnected'), /Check your connection/],
    ['http', route => route.fulfill({ status: 503, body: 'down' }), /server answered 503/],
    ['parse', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{not json' }), /Could not read the latest version/],
    ['shape', json({ version: 1 }), /Could not read the latest version/],
  ]) {
    const bad = await open(release)
    await seed(bad.page)
    await bad.page.click('#check-update')
    await bad.page.waitForFunction(() => /Could not/.test(document.querySelector('#update-status')?.textContent ?? ''))
    assert.match(await bad.page.locator('#update-status').textContent(), pattern, name)
    await bad.page.waitForTimeout(200)
    assert.equal(await bad.page.evaluate(() => window.__notReloaded), true, `${name}: no reload`)
    assert.equal(await bad.page.locator('#check-update').isDisabled(), false, `${name}: button usable again`)
    assert.equal((await snapshot(bad.page)).caches.includes(appCache), true, `${name}: caches kept`)
    if (process.env.UPDATE_SCREENSHOTS && name === 'offline') await bad.page.screenshot({ path: '/tmp/flashcards-update-error.png', fullPage: true })
    await bad.context.close()
  }

  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('update UI: up to date without reload, update clears only app caches and reloads with data preserved, offline/http/parse errors: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

import { chromium } from 'playwright-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.APP_URL || 'http://127.0.0.1:4173/'
const CHROME = process.env.CHROME || '/usr/bin/chromium'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function dismissWelcome(page) {
  await page.waitForFunction(() => document.querySelector('#guest-study') || document.querySelector('[data-due-count]'))
  if (await page.locator('#guest-study').count()) await page.click('#guest-study')
  await page.waitForSelector('[data-due-count]')
}

// The recovery bridge does not seed the legacy database. This profile is
// disposable, so one synthetic due card lets the review controls run.
async function plantDueCardWhenEmpty(page) {
  const planted = await page.evaluate(async () => {
    const start = document.querySelector('#start')
    if (!start || !start.disabled) return false
    const listed = await indexedDB.databases()
    const names = listed.map((entry) => entry.name).filter((name) => typeof name === 'string')
    const name = names.find((entry) => entry === 'german-flashcards' || entry === 'german-flashcards-rehearsal') || names[0]
    if (!name) throw new Error('empty study view has no IndexedDB database')
    const now = Date.now()
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('cards')) request.result.createObjectStore('cards', { keyPath: 'id' })
        if (!request.result.objectStoreNames.contains('settings')) request.result.createObjectStore('settings', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const tx = db.transaction('cards', 'readwrite')
      tx.objectStore('cards').put({
        id: 'install-check',
        de: 'Haus',
        en: 'house',
        article: 'das',
        example_de: 'Das Haus ist alt.',
        example_en: 'The house is old.',
        tags: [],
        tier: 1,
        created_at: now,
        updated_at: now,
        srs: { ease: 2.5, interval: 0, reps: 0, due: now - 1000 },
      })
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error)
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
    return name
  })
  if (!planted) return
  console.log(`installable: planted one synthetic due card in disposable ${planted}`)
  await page.reload({ waitUntil: 'load' })
  await dismissWelcome(page)
  const disabled = await page.locator('#start').isDisabled()
  if (disabled) throw new Error(`synthetic due card in ${planted} did not enable review`)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'de-pwa-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})
const page = context.pages()[0] || (await context.newPage())
const cdp = await context.newCDPSession(page)

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(BASE)).ok) break
    } catch { /* preview server is starting */ }
    if (attempt === 99) throw new Error(`Preview did not start at ${BASE}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await page.goto(BASE, { waitUntil: 'load' })
  await dismissWelcome(page)

  const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href')
  assert(manifestLink, 'no manifest link')
  const manifestUrl = new URL(manifestLink, BASE).href
  const manifest = await (await fetch(manifestUrl)).json()
  assert(manifest.name && manifest.short_name, 'name/short_name')
  assert(['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display), `display ${manifest.display}`)
  assert(manifest.start_url, 'start_url')
  assert(new URL(manifest.start_url, manifestUrl).pathname === new URL(BASE).pathname, 'manifest start_url escapes site base')
  assert(new URL(manifest.scope, manifestUrl).pathname === new URL(BASE).pathname, 'manifest scope escapes site base')
  const sizes = (manifest.icons || []).flatMap((i) => String(i.sizes).split(' '))
  assert(sizes.includes('192x192'), '192 icon')
  assert(sizes.includes('512x512'), '512 icon')

  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    await navigator.serviceWorker.ready
    return {
      controlling: Boolean(navigator.serviceWorker.controller || reg.active),
      scope: reg.scope,
      state: reg.active?.state ?? null,
    }
  })
  assert(sw.controlling, `SW not controlling: ${JSON.stringify(sw)}`)
  assert(new URL(sw.scope).pathname === new URL(BASE).pathname, 'service worker scope escapes site base')

  let errors = { installabilityErrors: [] }
  try {
    errors = await cdp.send('Page.getInstallabilityErrors')
  } catch (e) {
    console.warn('Page.getInstallabilityErrors unavailable:', e.message)
  }
  const list = errors.installabilityErrors || []
  const blocking = list.filter((e) => e.errorId !== 'already-installed')
  if (blocking.length) {
    throw new Error(`installability errors: ${JSON.stringify(blocking, null, 2)}`)
  }

  await plantDueCardWhenEmpty(page)
  await page.click('#start')
  await page.waitForSelector('#card')
  await page.locator('#card').tap()
  await page.waitForSelector('.grades:not([hidden])')
  const box = await page.locator('.grades').boundingBox()
  assert(box, 'grades missing')
  assert(box.y + box.height > 844 * 0.55, `grades not in thumb zone: y=${box.y} h=${box.height}`)
  const tabHidden = await page.locator('#tabbar').evaluate((el) => getComputedStyle(el).display === 'none')
  assert(tabHidden, 'tabbar should be hidden during review')
  const gbox = await page.locator('[data-grade="good"]').boundingBox()
  assert(gbox && gbox.height >= 56, `grade hit target ${gbox?.height}`)

  await page.goto(BASE, { waitUntil: 'load' })
  await dismissWelcome(page)
  await page.reload({ waitUntil: 'load' }) // let the installed worker control this tab
  await dismissWelcome(page)
  await context.setOffline(true)
  await page.reload({ waitUntil: 'load' })
  await dismissWelcome(page)

  console.log('installable: manifest + SW + offline reload + Chrome installability errors empty')
  console.log('mobile: grade bar in thumb zone, tabbar hidden in review')
  console.log(JSON.stringify({ manifest: manifest.short_name, sw, installabilityErrors: list }, null, 2))
} finally {
  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
}

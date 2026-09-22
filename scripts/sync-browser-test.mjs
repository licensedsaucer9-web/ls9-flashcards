import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'

const base = 'http://127.0.0.1:4174/'
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], {
  stdio: 'ignore',
})

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite did not start')
}

const config = {
  token: 'github_pat_test', owner: 'test', repo: 'data', path: 'data.json', branch: 'main',
}
const remote = {
  snapshot: null,
  sha: null,
  writes: 0,
  bodies: [],
  fail: false,
  failPutOnce: false,
  conflict: false,
  holdNext: false,
  held: null,
  release: null,
}

async function mockGithub(route) {
  const request = route.request()
  const reply = (status, body = {}) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (remote.fail) return reply(503, { message: 'offline' })
  if (request.method() === 'GET') {
    if (!remote.snapshot) return reply(404)
    return reply(200, {
      sha: remote.sha,
      content: Buffer.from(`${JSON.stringify(remote.snapshot)}\n`).toString('base64'),
    })
  }
  assert.equal(request.method(), 'PUT')
  remote.writes += 1
  const body = JSON.parse(request.postData())
  remote.bodies.push(request.postData().length)
  if (remote.failPutOnce) {
    remote.failPutOnce = false
    return reply(503, { message: 'temporary failure' })
  }
  if (remote.holdNext) {
    remote.holdNext = false
    remote.held?.()
    await new Promise((resolve) => { remote.release = resolve })
  }
  if (remote.conflict) {
    remote.conflict = false
    const extra = structuredClone(remote.snapshot.cards[1])
    extra.id = 'from-second-device'
    extra.de = 'anderswo'
    extra.updated_at = Date.now() + 100
    remote.snapshot.cards.push(extra)
    remote.sha = `sha-${remote.writes}-other`
    return reply(409, { message: 'conflict' })
  }
  if (body.sha && body.sha !== remote.sha) return reply(409, { message: 'stale sha' })
  remote.snapshot = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
  remote.sha = `sha-${remote.writes}`
  return reply(200, { content: { sha: remote.sha } })
}

async function configure(page) {
  await page.evaluate((cfg) => localStorage.setItem('german-flashcards.github', JSON.stringify(cfg)), config)
}

async function editCard(page, id, reps) {
  await page.evaluate(async ({ id, reps }) => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    const card = await db.getCard(id)
    card.srs.reps = reps
    card.updated_at = Date.now()
    await db.putCard(card)
    sync.schedulePush()
  }, { id, reps })
}

async function state(page) {
  return page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    return { settings: await db.getSettings(), status: sync.getSyncStatus() }
  })
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('https://api.github.com/**', mockGithub)
  const page = await context.newPage()
  await page.goto(base)
  await page.waitForSelector('[data-due-count]')
  await configure(page)
  await page.evaluate(async () => (await import('/src/sync.ts')).syncNow())
  assert(remote.snapshot.cards.length >= 400)
  assert(remote.bodies[0] > 64 * 1024, 'fixture must exceed keepalive limit')
  const cleanWrites = remote.writes
  await page.evaluate(async () => (await import('/src/sync.ts')).syncNow())
  assert.equal(remote.writes, cleanWrites, 'a clean pull must not make a new commit')

  await editCard(page, 'seed-08', 2)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await new Promise((resolve) => setTimeout(resolve, 1350))
  assert.equal(remote.writes, cleanWrites, 'hiding must cancel the pending full-snapshot upload')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  for (let i = 0; i < 100 && remote.snapshot.cards.find((card) => card.id === 'seed-08').srs.reps !== 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(remote.snapshot.cards.find((card) => card.id === 'seed-08').srs.reps, 2)

  await editCard(page, 'seed-06', 3)
  remote.failPutOnce = true
  await page.evaluate(async () => {
    try { await (await import('/src/sync.ts')).syncNow() } catch { /* failed PUT */ }
  })
  assert((await state(page)).settings.localRevision > (await state(page)).settings.acknowledgedRevision)
  await page.evaluate(async () => (await import('/src/sync.ts')).syncNow())
  assert.equal(remote.snapshot.cards.find((card) => card.id === 'seed-06').srs.reps, 3)

  // A failed foreground upload remains pending through pagehide and reload.
  await editCard(page, 'seed-01', 9)
  remote.fail = true
  await page.evaluate(async () => {
    try { await (await import('/src/sync.ts')).syncNow() } catch { /* offline */ }
  })
  const beforeHide = remote.writes
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  assert.equal(remote.writes, beforeHide, 'pagehide must not send a full-snapshot PUT')
  assert((await state(page)).settings.localRevision > (await state(page)).settings.acknowledgedRevision)
  await page.reload()
  await page.waitForSelector('[data-due-count]')
  remote.fail = false
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  let backedUp = false
  for (let i = 0; i < 100; i++) {
    const { settings } = await state(page)
    if (settings.localRevision === settings.acknowledgedRevision) {
      backedUp = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert(backedUp, 'foreground retry did not acknowledge the pending grade')
  assert.equal(remote.snapshot.cards.find((card) => card.id === 'seed-01').srs.reps, 9)
  assert.equal((await state(page)).settings.localRevision, (await state(page)).settings.acknowledgedRevision)
  assert.equal((await state(page)).status.state, 'ok')

  // A later edit while the PUT is in flight must require a second acknowledgment.
  await editCard(page, 'seed-02', 4)
  const held = new Promise((resolve) => { remote.held = resolve })
  remote.holdNext = true
  await page.evaluate(() => {
    window.pendingSyncTest = import('/src/sync.ts').then((sync) => sync.syncNow())
  })
  await held
  await editCard(page, 'seed-03', 7)
  remote.release()
  await page.evaluate(() => window.pendingSyncTest)
  assert.equal(remote.snapshot.cards.find((card) => card.id === 'seed-02').srs.reps, 4)
  assert.equal(remote.snapshot.cards.find((card) => card.id === 'seed-03').srs.reps, 7)
  assert.equal((await state(page)).settings.localRevision, (await state(page)).settings.acknowledgedRevision)

  // Conflict retry re-fetches the other device's changes before writing.
  await editCard(page, 'seed-04', 5)
  remote.conflict = true
  await page.evaluate(async () => (await import('/src/sync.ts')).syncNow())
  assert.equal(remote.snapshot.cards.find((card) => card.id === 'seed-04').srs.reps, 5)
  assert(remote.snapshot.cards.some((card) => card.id === 'from-second-device'))

  // Deletion and settings survive reseeding and reach a fresh second device.
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    await db.deleteCard('seed-05')
    const settings = await db.getSettings()
    await db.putSettings({ ...settings, direction: 'en-de' })
    sync.schedulePush()
    await sync.syncNow()
  })
  await page.reload()
  await page.waitForSelector('[data-due-count]')
  assert.equal(await page.evaluate(async () => (await import('/src/db.ts')).getCard('seed-05')), undefined)
  assert(remote.snapshot.deleted_ids['seed-05'])
  assert.equal(remote.snapshot.settings.direction, 'en-de')

  const other = await browser.newContext({ serviceWorkers: 'block' })
  await other.route('https://api.github.com/**', mockGithub)
  await other.addInitScript((cfg) => localStorage.setItem('german-flashcards.github', JSON.stringify(cfg)), config)
  const second = await other.newPage()
  await second.goto(base)
  await second.waitForSelector('[data-due-count]')
  assert.equal(await second.evaluate(async () => (await import('/src/db.ts')).getCard('seed-05')), undefined)
  assert.equal((await state(second)).settings.direction, 'en-de')
  assert.equal(await second.evaluate(async () => (await import('/src/db.ts')).getCard('seed-01')).then((card) => card.srs.reps), 9)

  const seeded = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const seed = (await import('/src/seed.ts')).seedCards()
    const fresh = { ...seed[0], id: 'seed-515', de: 'Zusatzwort' }
    const first = await db.insertMissingSeeds([seed[4], fresh])
    const second = await db.insertMissingSeeds([fresh])
    return { first, second, deleted: await db.getCard('seed-05'), reviewed: await db.getCard('seed-01') }
  })
  assert.equal(seeded.first, 1)
  assert.equal(seeded.second, 0)
  assert.equal(seeded.deleted, undefined)
  assert.equal(seeded.reviewed.srs.reps, 9)
  assert(await page.evaluate(async () => (await import('/src/db.ts')).getCard('from-second-device')))

  // Upgrade an old local settings record without losing an unacknowledged review.
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('german-flashcards', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['cards', 'settings'], 'readwrite')
      const request = tx.objectStore('cards').get('seed-07')
      request.onsuccess = () => {
        const card = request.result
        card.srs.reps = 11
        card.updated_at = Date.now()
        tx.objectStore('cards').put(card)
        tx.objectStore('settings').put({ id: 'settings', direction: 'en-de', sessionSize: 20, deletedIds: {} })
      }
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    await (await import('/src/sync.ts')).syncNow()
  })
  assert.equal(remote.snapshot.cards.find((card) => card.id === 'seed-07').srs.reps, 11)
  assert.equal((await state(page)).settings.localRevision, (await state(page)).settings.acknowledgedRevision)
  await other.close()
  await context.close()
  console.log('sync-browser-test: offline reload, large payload, in-flight edit, conflict, settings, tombstone, second device, legacy DB: ok')
} finally {
  if (browser) await browser.close()
  server.kill()
}

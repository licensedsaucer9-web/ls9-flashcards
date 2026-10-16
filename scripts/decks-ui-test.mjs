// Local device-study navigation acceptance; fresh browser storage, no live services.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'decks-ui-test-'))
let server
let browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4182, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
  const externalRequests = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    externalRequests.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  // A click can finish before an async handler opens its dialog. Await both the
  // response and click so the next interaction cannot handle the same dialog.
  const respondToDialog = async (selector, respond) => {
    const dialogOpened = page.waitForEvent('dialog')
    const clicked = page.click(selector)
    const dialog = await dialogOpened
    try {
      await respond(dialog)
    } finally {
      await clicked
    }
  }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:4182/')
  await page.waitForSelector('#start')
  // Establish existing study history before exercising navigation.
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const card = (await db.getAllCards())[0]
    await db.saveReview(card.id, 'good', crypto.randomUUID(), Date.now(), 'UTC')
    await db.putSettings({ tier: 3, sessionSize: 0, direction: 'en-de' })
  })
  // Upgrade real v2/v3 stores in isolated fixture databases; no cloud or account provisioning.
  const upgrades = await page.evaluate(async () => {
    const api = await import('/src/db.ts')
    const { bindStudyDatabase, clearStudyBinding } = await import('/src/study-lock.ts')
    const { settingsToDoc } = await import('/src/firestore-docs.ts')
    const { deckId: _deckId, ...existing } = (await api.getAllCards())[0]
    existing.srs = { ...existing.srs, due: 63 }
    const preferences = await api.getSettings()
    const { activeDeckId, ...oldSettings } = preferences
    // This isolated database has its own activity fixture, not the source event.
    oldSettings.pending = { ...oldSettings.pending, activity: {} }
    // Versions 2–4 predate deck-scoped pending marks. Do not inherit the
    // current app's ownership fields when constructing these legacy rows.
    for (const kind of ['cards', 'progress', 'tombstones']) {
      oldSettings.pending[kind] = Object.fromEntries(Object.entries(oldSettings.pending[kind])
        .map(([id, { deckId, ...mark }]) => [id, mark]))
    }
    const read = name => new Promise((resolve, reject) => {
      const req = indexedDB.open(name)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction([...db.objectStoreNames], 'readonly')
        const result = { version: db.version }
        for (const store of db.objectStoreNames) {
          const request = tx.objectStore(store).getAll()
          request.onsuccess = () => { result[store] = request.result }
        }
        tx.oncomplete = () => { db.close(); resolve(result) }
      }
    })
    const results = []
    try {
      for (const version of [2, 3, 4]) for (const assigned of [false, true]) {
        const name = `deck-upgrade-fixture-${version}-${assigned}`
        await new Promise((resolve, reject) => {
          const req = indexedDB.open(name, version)
          req.onupgradeneeded = () => {
            for (const store of ['cards', 'settings', 'activity']) req.result.createObjectStore(store, { keyPath: 'id' })
            req.transaction.objectStore('cards').put(existing)
            req.transaction.objectStore('settings').put({ ...oldSettings, deletedIds: { 'deleted-fixture': 63 }, ...(version >= 3 ? { activeDeckId: 'local-german' } : {}) })
            if (version >= 3) req.result.createObjectStore('decks', { keyPath: 'id' }).put({ id: 'local-german', name: 'German', targetLang: 'German', baseLang: 'English', articles: true, wordTypes: true, tiers: true, origin: 'original' })
            req.transaction.objectStore('activity').put({ id: '00000000-0000-4000-8000-000000000063', at: Date.now(), timeZone: 'UTC' })
          }
          req.onerror = () => reject(req.error)
          req.onsuccess = () => { req.result.close(); resolve() }
        })
        const before = await read(name)
        bindStudyDatabase({ uid: assigned ? 'fixture-account' : null, dbName: name })
        if (assigned) await api.recordAssignedDeck('fixture-cloud-deck')
        else await api.insertMissingSeeds([]) // The normal seed write upgrades device-study storage.
        const decks = await api.getDecks()
        const after = await read(name)
        await api.getDecks()
        const reopened = await read(name)
        const settings = await api.getSettings()
        const publicSettings = api.localUserFile([existing], settings).settings
        const cloudSettings = settingsToDoc(settings, settings.settingsUpdatedAt)
        let attached
        if (!assigned) {
          bindStudyDatabase({ uid: 'fixture-account', dbName: name })
          await api.recordAssignedDeck('fixture-cloud-deck')
          await api.recordAssignedDeck('fixture-cloud-deck')
          attached = await read(name)
        }
        results.push({ assigned, before, after, reopened, decks, publicSettings, cloudSettings, attached, due: (await api.getDueCards()).length, expectedDue: existing.srs.due <= Date.now() ? 1 : 0 })
      }
    } finally { clearStudyBinding() }
    return results
  })
  for (const result of upgrades) {
    const id = result.assigned ? 'fixture-cloud-deck' : 'local-german'
    assert.equal(result.after.version, 5)
    assert.equal(result.due, result.expectedDue, 'one-deck upgrade preserves due count')
    assert.deepEqual(result.after.cards, result.before.cards.map(card => ({ ...card, deckId: id })), 'upgrade only stamps deck ownership; exact cards and due dates survive')
    assert.deepEqual(result.after.activity, result.before.activity, 'upgrade retains exact streak events')
    assert.deepEqual(result.after.settings, [{ ...result.before.settings[0], activeDeckId: id, deletedDeckIds: { 'deleted-fixture': id } }], 'upgrade changes only local selection')
    assert.deepEqual(result.decks, [{ id, name: 'German', targetLang: 'German', baseLang: 'English', articles: true, supportsWordTypes: true, tiers: true, origin: 'original', direction: result.before.settings[0].direction, sessionSize: result.before.settings[0].sessionSize, tier: result.before.settings[0].tier, wordTypes: result.before.settings[0].wordTypes }])
    assert.deepEqual(result.reopened, result.after, 'reopening does not insert another deck')
    assert.equal(Object.hasOwn(result.publicSettings, 'activeDeckId'), false)
    assert.equal(Object.hasOwn(result.cloudSettings, 'activeDeckId'), false)
    if (result.attached) {
      assert.deepEqual(result.attached.decks, [{ ...result.decks[0], id: 'fixture-cloud-deck' }], 'learning an assignment keeps exactly one deck')
      assert.deepEqual(result.attached.cards, result.before.cards.map(card => ({ ...card, deckId: 'fixture-cloud-deck' })))
      assert.deepEqual(result.attached.activity, result.before.activity)
      assert.deepEqual(result.attached.settings, [{ ...result.before.settings[0], activeDeckId: 'fixture-cloud-deck', deletedDeckIds: { 'deleted-fixture': 'fixture-cloud-deck' } }])
    }
  }
  // Current offline writes do carry ownership; attaching the cloud assignment
  // must remap every record kind without changing its revision or ack state.
  const reassigned = await page.evaluate(async () => {
    const api = await import('/src/db.ts')
    const { bindStudyDatabase, clearStudyBinding } = await import('/src/study-lock.ts')
    const fixture = (await api.getAllCards())[0]
    try {
      bindStudyDatabase({ uid: 'fixture-account', dbName: 'deck-pending-assignment-fixture' })
      await api.putCard({ ...fixture, id: 'pending-kept' })
      await api.putCard({ ...fixture, id: 'pending-deleted' })
      await api.deleteCard('pending-deleted', Date.now())
      const before = await api.getSettings()
      await api.recordAssignedDeck('fixture-cloud-deck')
      await api.recordAssignedDeck('fixture-cloud-deck')
      return { before, after: await api.getSettings() }
    } finally { clearStudyBinding() }
  })
  for (const kind of ['cards', 'progress', 'tombstones']) {
    assert(Object.keys(reassigned.before.pending[kind]).length > 0, `${kind} fixture contains pending writes`)
    assert.deepEqual(reassigned.after.pending[kind], Object.fromEntries(
      Object.entries(reassigned.before.pending[kind]).map(([id, mark]) => {
        assert.equal(mark.deckId, 'local-german')
        return [id, { ...mark, deckId: 'fixture-cloud-deck' }]
      })), `${kind} assignment preserves revisions and remaps ownership`)
  }
  // Guest vocabulary copies must preserve another deck's tombstones and pending revisions.
  const guestCopy = await page.evaluate(async () => {
    const api = await import('/src/db.ts')
    const { bindStudyDatabase, clearStudyBinding } = await import('/src/study-lock.ts')
    const fixture = (await api.getAllCards())[0]
    const sourceName = 'guest-tombstone-source-64'
    const targetName = 'guest-tombstone-target-64'
    const ids = ['foreign-older-64', 'foreign-newer-64', 'active-deletion-64']
    const settingsRow = () => new Promise((resolve, reject) => {
      const req = indexedDB.open(targetName)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('settings', 'readonly')
        const row = tx.objectStore('settings').get('settings')
        tx.oncomplete = () => { db.close(); resolve(row.result) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
    try {
      bindStudyDatabase({ uid: null, dbName: sourceName })
      for (const id of ids) {
        await api.putCard({ ...fixture, id })
        await api.deleteCard(id, 64001)
      }
      bindStudyDatabase({ uid: null, dbName: targetName })
      await api.putSettings({ tier: 3 })
      await new Promise((resolve, reject) => {
        const req = indexedDB.open(targetName)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('settings', 'readwrite')
          const store = tx.objectStore('settings')
          const row = store.get('settings')
          row.onsuccess = () => {
            const settings = row.result
            settings.deletedIds = { [ids[0]]: 64000, [ids[1]]: 64002 }
            settings.deletedDeckIds = { [ids[0]]: 'other-deck', [ids[1]]: 'other-deck' }
            settings.pending.tombstones = { [ids[0]]: { revision: 7, acked: 6 }, [ids[1]]: { revision: 8, acked: 8 } }
            store.put(settings)
          }
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onabort = () => { db.close(); reject(tx.error) }
        }
      })
      const before = await settingsRow()
      const copies = []
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!await api.copyGuestDatabase(sourceName, 'vocabulary')) throw new Error('Guest copy failed')
        const after = await settingsRow()
        const cloud = await api.readCloudSnapshot()
        copies.push({ after, cloudDeleted: cloud.settings.deletedIds })
      }
      return { before, copies }
    } finally { clearStudyBinding() }
  })
  for (const { after, cloudDeleted } of guestCopy.copies) {
    for (const id of ['foreign-older-64', 'foreign-newer-64']) {
      assert.equal(after.deletedIds[id], guestCopy.before.deletedIds[id], 'guest copy preserves foreign deletion clock')
      assert.equal(after.deletedDeckIds[id], guestCopy.before.deletedDeckIds[id], 'guest copy preserves foreign tombstone owner')
      assert.deepEqual(after.pending.tombstones[id], guestCopy.before.pending.tombstones[id], 'guest copy preserves foreign pending revision')
      assert.equal(Object.hasOwn(cloudDeleted, id), false, 'guest copy cannot expose foreign tombstone to active-deck sync')
    }
    assert.equal(after.deletedDeckIds['active-deletion-64'], after.activeDeckId)
    assert.equal(cloudDeleted['active-deletion-64'], 64001, 'guest deletion still copies into active deck')
  }
  const snapshot = () => page.evaluate(async () => {
    const db = await import('/src/db.ts')
    return { cards: await db.getAllCards(), activity: await db.getReviewActivity() }
  })
  // A second deck exists only as a fixture: no deck-creation UI or live data.
  const isolation = await page.evaluate(async () => {
    const api = await import('/src/db.ts')
    const { activeUserSlug, dbNameForUser } = await import('/src/user.ts')
    const cards = await api.getAllCards()
    const due = (await api.getDueCards()).length
    const foreign = { ...cards[0], id: 'foreign-card-64', deckId: 'fixture-other-deck', de: 'FOREIGN_FIXTURE_64', srs: { ...cards[0].srs, due: 0 } }
    const mutate = work => new Promise((resolve, reject) => {
      const req = indexedDB.open(dbNameForUser(activeUserSlug()))
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['cards', 'settings'], 'readwrite')
        work(tx)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
    await mutate(tx => tx.objectStore('cards').put(foreign))
    const actual = await api.getAllCards()
    const result = {
      unchanged: JSON.stringify(actual) === JSON.stringify(cards),
      due, afterDue: (await api.getDueCards()).length,
      count: await api.countCards(),
      foreign: await api.getCard(foreign.id),
      foreignReview: await api.saveReview(foreign.id, 'good', crypto.randomUUID()),
    }
    await api.deleteCard(foreign.id)
    // Switch local selection directly: seeds must still belong to original German.
    await mutate(tx => {
      const req = tx.objectStore('settings').get('settings')
      req.onsuccess = () => tx.objectStore('settings').put({ ...req.result, activeDeckId: foreign.deckId })
    })
    const seed = { ...cards[0], id: 'seed-fixture-64', de: 'Seed fixture 64', en: 'Seed fixture 64' }
    result.seedAdded = await api.insertMissingSeeds([seed])
    result.otherCards = (await api.getAllCards()).map(card => card.id)
    await api.putCard({ ...seed, id: 'put-fixture-64', deckId: 'ignored-input-deck' })
    await api.putCards([{ ...seed, id: 'bulk-fixture-64', deckId: 'ignored-input-deck' }])
    result.writeDecks = [(await api.getCard('put-fixture-64')).deckId, (await api.getCard('bulk-fixture-64')).deckId]
    await mutate(tx => { tx.objectStore('cards').delete('put-fixture-64'); tx.objectStore('cards').delete('bulk-fixture-64') })
    await api.deleteCard(foreign.id, 64000)
    result.otherTombstone = (await api.readLocalState()).snapshot.deck.deleted_ids[foreign.id]
    await mutate(tx => {
      const req = tx.objectStore('settings').get('settings')
      req.onsuccess = () => tx.objectStore('settings').put({ ...req.result, activeDeckId: cards[0].deckId })
    })
    const state = await api.readLocalState()
    result.originalTombstone = state.snapshot.deck.deleted_ids[foreign.id]
    // Pulling the original deck/progress cannot erase or grade the other deck.
    await api.mergeDeckIntoDb(state.snapshot.deck)
    await api.mergeProgressIntoDb({ ...state.snapshot.user, progress: { ...state.snapshot.user.progress, [foreign.id]: { ...foreign.srs, due: 12345 } } })
    const cloud = await api.readCloudSnapshot()
    result.cloudHasForeign = cloud.cards.has(foreign.id) || Object.hasOwn(cloud.settings.deletedIds, foreign.id)
    await mutate(tx => tx.objectStore('cards').put(foreign))
    await api.mergeDeckIntoDb(state.snapshot.deck)
    await api.mergeProgressIntoDb({ ...state.snapshot.user, progress: { [foreign.id]: { ...foreign.srs, due: 12345, updated_at: Date.now() } } })
    await mutate(tx => {
      const req = tx.objectStore('cards').get(foreign.id)
      req.onsuccess = () => { result.preservedForeign = JSON.stringify(req.result) === JSON.stringify(foreign) }
    })
    result.seedDeck = (await api.getCard(seed.id)).deckId
    // Leave a foreign card present throughout UI navigation and review checks.
    await mutate(tx => { tx.objectStore('cards').delete(seed.id); tx.objectStore('cards').put(foreign) })
    return result
  })
  assert.equal(isolation.unchanged, true, 'foreign fixture leaves German cards and schedules unchanged')
  assert.equal(isolation.afterDue, isolation.due, 'foreign due card is absent from due counts')
  assert.equal(isolation.count, 514)
  assert.equal(isolation.foreign, undefined)
  assert.equal(isolation.foreignReview, null)
  assert.equal(isolation.seedAdded, 1)
  assert.deepEqual(isolation.otherCards, ['foreign-card-64'], 'seed insertion never targets second deck')
  assert.equal(isolation.seedDeck, 'local-german')
  assert.deepEqual(isolation.writeDecks, ['fixture-other-deck', 'fixture-other-deck'], 'single and bulk writes stamp active deck')
  assert.equal(isolation.otherTombstone, 64000)
  assert.equal(isolation.cloudHasForeign, false, 'sync snapshots exclude foreign deck records')
  assert.equal(isolation.preservedForeign, true, 'sync merges preserve foreign cards and schedules')
  assert.equal(isolation.originalTombstone, undefined, 'deletion stays with its own deck')
  const before = await snapshot()
  assert.equal(before.cards.length, 514)
  assert.equal(Object.keys(before.activity).length, 1)
  assert.deepEqual(await page.locator('#tabbar .tab').allTextContents(), ['Review', 'Decks', 'Cards', 'Settings'])
  async function tab(name, hash, heading) {
    await page.locator('#tabbar .tab').filter({ hasText: new RegExp(`^${name}$`) }).click()
    await page.waitForFunction(({ hash, heading }) => location.hash === hash && document.querySelector('h1')?.textContent === heading, { hash, heading })
    assert.equal(await page.locator('#tabbar .is-active').textContent(), name)
    assert.equal(await page.getByText('FOREIGN_FIXTURE_64', { exact: true }).count(), 0, 'foreign card never appears in UI')
  }
  // Real Chromium touch input exercises routing, native scrolling and click suppression.
  const touch = await context.newCDPSession(page)
  async function swipe(dx, dy = 0, { selector = 'h1', cancel = false } = {}) {
    const bounds = await page.waitForFunction(selector => {
      const el = document.querySelector(selector)
      if (!el) return null
      const { x, y, width, height } = el.getBoundingClientRect()
      return width && height ? { x, y, width, height } : null
    }, selector)
    const box = await bounds.jsonValue()
    const x = dx < 0 ? 280 : 100
    const y = box.y + box.height / 2
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let step = 1; step <= 5; step++) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5 }] })
    }
    await touch.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
  }
  async function activeTab(name, hash) {
    await page.waitForFunction(({ name, hash }) => location.hash === hash
      && document.querySelector('#tabbar .is-active')?.textContent === name, { name, hash }, { timeout: 5000 }).catch(async error => {
      throw new Error(`${name} ${hash}: actual ${page.url()}, active ${await page.locator('#tabbar .is-active').textContent()}`, { cause: error })
    })
  }
  await page.goto('http://127.0.0.1:4182/#/')
  await page.waitForSelector('#start')
  await swipe(140)
  await activeTab('Review', '#/') // No wrapping at the first tab.
  await swipe(-140)
  await activeTab('Decks', '#/decks')
  await page.waitForSelector('#new-deck')
  await swipe(-140)
  await activeTab('Cards', '#/deck')
  await page.waitForSelector('#search')
  // A horizontal drag in a text field must retain the current route.
  await swipe(-100, 0, { selector: '#search' })
  await activeTab('Cards', '#/deck')
  await swipe(-25)
  await activeTab('Cards', '#/deck')
  await swipe(-140, 0, { cancel: true })
  await activeTab('Cards', '#/deck')
  await swipe(-140)
  await activeTab('Settings', '#/settings')
  await swipe(-140)
  await activeTab('Settings', '#/settings') // No wrapping at the last tab.
  await page.goBack()
  await activeTab('Cards', '#/deck')
  await page.waitForSelector('#search')
  await swipe(140)
  await activeTab('Decks', '#/decks')
  await page.waitForSelector('#new-deck')
  await swipe(140)
  await activeTab('Review', '#/')
  // Mouse drags retain desktop behavior, even in this touch-capable browser.
  await page.mouse.move(280, 100)
  await page.mouse.down()
  await page.mouse.move(100, 100, { steps: 5 })
  await page.mouse.up()
  await activeTab('Review', '#/')
  await page.click('#start')
  await page.waitForSelector('#card')
  assert.equal(await page.locator('#tabbar').isVisible(), false)
  await swipe(-140, 0, { selector: '.topbar' })
  assert.equal(new URL(page.url()).hash, '#/review', 'study session ignores tab swipes')
  await page.click('#back')
  await page.waitForSelector('#start')
  await tab('Cards', '#/deck', 'Cards')
  for (const [link, ready, hash] of [
    ['#/card/new', '#form', '#/card/new'], ['#/import', '#paste', '#/import'],
  ]) {
    await page.click(`a[href="${link}"]`)
    await page.waitForSelector(ready)
    await swipe(-140)
    assert.equal(new URL(page.url()).hash, hash, 'hidden-tab screen ignores swipes')
    await page.click('#back')
    await page.waitForSelector('#search')
  }
  const scrollBefore = await page.evaluate(() => document.scrollingElement.scrollTop)
  await swipe(-65, -230, { selector: '.card-list li:nth-child(5) .card-row' })
  await activeTab('Cards', '#/deck')
  assert(await page.evaluate(before => document.scrollingElement.scrollTop > before, scrollBefore), 'vertical list gesture scrolls without changing tabs')
  await touch.detach()
  async function assertDeckCount(count) {
    assert.equal(await page.locator('#main .card-row').count(), 1)
    assert.equal(await page.locator('#main .de').textContent(), 'German')
    assert.equal(await page.locator('#main .en').textContent(), `${count} cards`)
    assert.equal(await page.locator('#main .badge').textContent(), 'Active')
    assert.equal(await page.locator('#main .card-row [data-rename]').count(), 1)
    assert.equal(await page.locator('#main .card-row [data-delete-deck]').count(), 0)
    assert.equal(await page.locator('[data-word-type]').count(), 4)
    assert.equal(await page.locator('[data-tier]').count(), 3)
    assert.deepEqual(await page.locator('#dir button').allTextContents(), ['German → English', 'English → German'])
    assert.equal(await page.locator('[data-session], #session-custom, #session-size').count(), 0, 'Decks has no session-size control')
  }
  await tab('Decks', '#/decks', 'Decks')
  await assertDeckCount(514)
  async function renameFixtureDeck(name) {
    await page.evaluate(async name => {
      const { dbNameForUser, activeUserSlug } = await import('/src/user.ts')
      await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbNameForUser(activeUserSlug()))
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('decks', 'readwrite')
          const stored = tx.objectStore('decks').getAll()
          stored.onsuccess = () => tx.objectStore('decks').put({ ...stored.result[0], name })
          tx.oncomplete = () => { db.close(); resolve() }
        }
      })
    }, name)
    await page.reload()
    await page.waitForSelector('#main .card-row')
    assert.equal(await page.locator('#main .de').textContent(), name, 'Decks renders the stored metadata')
  }
  await renameFixtureDeck('German fixture')
  await renameFixtureDeck('German')
  const settings = () => page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { direction, sessionSize, tier, wordTypes } = await db.getSettings()
    return { direction, sessionSize, tier, wordTypes }
  })
  const originalSettings = await settings()
  async function pickType(type, expected) {
    const previous = await settings()
    await page.locator(`[data-word-type="${type}"]`).click()
    await page.waitForFunction(async expected => {
      const db = await import('/src/db.ts')
      const selected = (await db.getSettings()).wordTypes
      const pressed = [...document.querySelectorAll('[data-word-type][aria-pressed="true"]')].map(button => button.dataset.wordType)
      return JSON.stringify(selected) === JSON.stringify(expected)
        && JSON.stringify(pressed) === JSON.stringify(expected.length ? expected : ['all'])
    }, expected)
    assert.deepEqual(await settings(), { ...previous, wordTypes: expected }, 'only the word-type preference changes')
    await page.waitForSelector(`[data-word-type="${expected.length ? expected.at(-1) : 'all'}"][aria-pressed="true"]`)
  }
  async function assertReviewQueue(typeLabel) {
    await tab('Review', '#/', 'LS9 Flashcards')
    assert.equal(await page.locator('[data-word-type], [data-tier], [data-dir]').count(), 0, 'Review home has no tier, word-type or direction controls')
    assert.equal(await page.locator('#session-custom').isVisible(), true)
    if (typeLabel) assert.match(await page.locator('.due-hero > .kicker').textContent(), new RegExp(typeLabel))
    const expected = await page.evaluate(async () => {
      const db = await import('/src/db.ts')
      const { selectReviewCandidates, sessionCount } = await import('/src/session.ts')
      const settings = await db.getSettings()
      const candidates = selectReviewCandidates(await db.getAllCards(), settings.tier, settings.wordTypes)
      return sessionCount(candidates.cards.length, settings.sessionSize)
    })
    assert.equal(Number(await page.locator('#start').getAttribute('data-session-count')), expected)
    await page.locator('#start').click()
    await page.waitForSelector('#card')
    assert.equal(Number(await page.locator('[data-remaining]').textContent()), expected, 'Decks preference controls the next review queue')
    assert.equal(await page.locator('[data-word-type], [data-tier], [data-dir]').count(), 0, 'active Review has no tier, word-type or direction controls')
    const faces = await page.evaluate(async () => {
      const db = await import('/src/db.ts')
      const { selectReviewCandidates } = await import('/src/session.ts')
      const settings = await db.getSettings()
      const candidates = selectReviewCandidates(await db.getAllCards(), settings.tier, settings.wordTypes).cards
      const front = document.querySelector('.front .word').textContent
      const back = document.querySelector('.back .word').textContent
      return { matches: candidates.some(card => settings.direction === 'en-de'
        ? front === card.en && back.endsWith(card.de)
        : front.endsWith(card.de) && back === card.en) }
    })
    assert.equal(faces.matches, true, 'the next review uses the saved tier and direction')
    if (typeLabel === 'Nouns') assert.equal(await page.locator('.front .word-type').textContent(), 'noun')
    await page.locator('#back').click()
    await page.waitForSelector('#start')
    return expected
  }
  assert.equal(await page.locator('[data-word-type="all"]').getAttribute('aria-pressed'), 'true')
  await pickType('noun', ['noun'])
  await page.reload()
  await page.waitForSelector('[data-word-type="noun"][aria-pressed="true"]')
  assert.deepEqual((await settings()).wordTypes, ['noun'], 'choice survives reload')
  await tab('Settings', '#/settings', 'Settings')
  assert.equal(await page.locator('[data-word-type], [data-tier], [data-dir], [data-session], #session-custom, #session-size').count(), 0, 'Settings has no study controls')
  assert.equal(await page.locator('#app-version').isVisible(), true)
  assert.equal(await page.locator('#sw-status').isVisible(), true)
  assert.match(await page.locator('#main').textContent(), /Install/)
  assert.match(await page.locator('#main').textContent(), /SM-2 with Again/)
  const nounQueue = await assertReviewQueue('Nouns')
  await tab('Decks', '#/decks', 'Decks')
  await pickType('verb', ['noun', 'verb'])
  await pickType('noun', ['verb'])
  await pickType('verb', [])
  assert.equal(await page.locator('[data-word-type="all"]').getAttribute('aria-pressed'), 'true', 'last deselection returns to All')
  await pickType('adj', ['adj'])
  await pickType('all', [])
  const allQueue = await assertReviewQueue()
  assert(allQueue > nounQueue, 'All restores the wider review queue')
  async function pickPreference(selector, patch) {
    const previous = await settings()
    await page.locator(selector).click()
    await page.waitForFunction(async ({ selector, patch }) => {
      const saved = await (await import('/src/db.ts')).getSettings()
      return Object.entries(patch).every(([key, value]) => saved[key] === value)
        && document.querySelector(selector)?.classList.contains('is-on')
    }, { selector, patch })
    assert.deepEqual(await settings(), { ...previous, ...patch }, 'only the selected preference changes')
  }
  await tab('Decks', '#/decks', 'Decks')
  await pickPreference('[data-tier="1"]', { tier: 1 })
  await pickPreference('[data-dir="de-en"]', { direction: 'de-en' })
  await page.reload()
  await page.waitForSelector('[data-dir="de-en"].is-on')
  assert.equal(await page.locator('[data-tier="1"].is-on').count(), 1, 'saved tier survives reload')
  const tierOneQueue = await assertReviewQueue()
  assert(tierOneQueue < allQueue, 'the saved tier narrows the next review')
  const savedBeforeBrowse = await page.evaluate(async () => (await import('/src/db.ts')).getSettings())
  await tab('Cards', '#/deck', 'Cards')
  const tierOneCards = await page.locator('.card-list .card-row').count()
  await page.click('[data-tier="3"]')
  assert.equal(await page.locator('.card-list .card-row').count(), 514, 'Cards can browse beyond the saved tier')
  assert(tierOneCards < 514)
  await page.locator('#search').fill('Haus')
  await page.click('[data-tier="2"]')
  assert.deepEqual(await page.evaluate(async () => (await import('/src/db.ts')).getSettings()), savedBeforeBrowse,
    'Cards tier/search filters do not write preferences, clocks or pending markers')
  assert.equal(await assertReviewQueue(), tierOneQueue, 'Cards browsing does not change the next review')
  await tab('Decks', '#/decks', 'Decks')
  assert.equal(await page.locator('[data-tier="1"].is-on').count(), 1)
  await pickPreference('[data-tier="2"]', { tier: 2 })
  const tierTwoQueue = await assertReviewQueue()
  assert(tierTwoQueue > tierOneQueue && tierTwoQueue < allQueue, 'tier 2 is cumulative')
  await tab('Decks', '#/decks', 'Decks')
  await pickPreference('[data-tier="3"]', { tier: 3 })
  await pickPreference('[data-dir="en-de"]', { direction: 'en-de' })
  assert.equal(await assertReviewQueue(), allQueue)
  assert.deepEqual(await settings(), originalSettings, 'unrelated preferences survive tier and direction changes')
  assert.deepEqual(await snapshot(), before, 'filter changes and review entry preserve every card, schedule and streak event')
  await tab('Decks', '#/decks', 'Decks')
  const boxes = await page.locator('#tabbar .tab').evaluateAll(tabs => tabs.map(tab => {
    const { x, y, width, height } = tab.getBoundingClientRect()
    return { x, y, width, height }
  }))
  assert(boxes.every(box => box.y === boxes[0].y && box.width > 0 && box.height > 0), 'four tabs share one visible row')
  if (process.env.DECKS_SCREENSHOT) await page.screenshot({ path: process.env.DECKS_SCREENSHOT, fullPage: true })
  await tab('Cards', '#/deck', 'Cards')
  assert(await page.locator('.card-list .card-row').count() > 0)
  await page.locator('.card-list .card-row').first().click()
  await page.waitForSelector('#form')
  assert.match(await page.evaluate(() => location.hash), /^#\/card\/.+/)
  assert.equal(await page.locator('#tabbar .is-active').textContent(), 'Cards')
  const editedId = await page.evaluate(() => location.hash.split('/')[2])
  await page.locator('[name="en"]').fill('Synthetic navigation edit')
  await page.locator('#form [type="submit"]').click()
  await page.waitForSelector('#search')
  assert.equal(await page.evaluate(() => location.hash), '#/deck')
  await page.locator('a[href="#/import"]').click()
  await page.waitForSelector('#paste')
  assert.equal(await page.evaluate(() => location.hash), '#/import')
  assert.equal(await page.locator('#tabbar .is-active').textContent(), 'Cards')
  await page.locator('#paste').fill('de,en,article,type\nNavigationstest,synthetic navigation import,none,other')
  await page.locator('#run').click()
  await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('1 new cards'))
  await tab('Decks', '#/decks', 'Decks')
  await assertDeckCount(515)
  await page.reload()
  await page.waitForSelector('#main .card-row')
  await assertDeckCount(515)
  const after = await snapshot()
  const allCount = await assertReviewQueue()
  const eligible = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { inSelectedWordTypes } = await import('/src/word-types.ts')
    const cards = (await db.getAllCards()).filter(card => card.srs.due <= Date.now())
    return { all: cards.length, typed: cards.filter(card => inSelectedWordTypes(card, ['noun', 'verb', 'adj'])).length }
  })
  assert.equal(allCount, eligible.all, 'All includes every due card, including the imported untyped fixture')
  assert(eligible.all > eligible.typed, 'fixture contains a due untyped card')
  assert.deepEqual(after.activity, before.activity, 'navigation/edit/import preserve streak events')
  for (const card of before.cards) {
    const saved = after.cards.find(c => c.id === card.id)
    assert(saved, 'every existing German card survives')
    assert.deepEqual(saved.srs, card.srs, 'existing due dates and schedules survive')
    if (card.id !== editedId) assert.deepEqual(saved, card, 'untouched German cards retain all fields')
    else assert.equal(saved.en, 'Synthetic navigation edit')
  }
  await tab('Settings', '#/settings', 'Settings')
  await page.locator('#tabbar [data-tab="home"]').click()
  await page.waitForSelector('#start')
  assert.equal(await page.locator('#tabbar .is-active').textContent(), 'Review')
  await page.locator('#start').click()
  await page.waitForSelector('#card')
  assert.equal(await page.evaluate(() => location.hash), '#/review')
  assert.equal(await page.locator('#tabbar').isVisible(), false)
  await page.locator('#card').click()
  assert.equal(await page.locator('[data-grade="good"]').isVisible(), true)
  await page.locator('#back').click()
  await page.waitForSelector('#start')
  assert.deepEqual(await snapshot(), after, 'entering/flipping/leaving Review does not mutate study data')
  // A local-only fixture with no typed cards exercises Review's empty-match recovery.
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.putCards((await db.getAllCards()).map(card => ({ ...card, tags: ['other'] })))
  })
  const untypedFixture = await snapshot()
  await tab('Decks', '#/decks', 'Decks')
  await pickType('noun', ['noun'])
  await tab('Review', '#/', 'LS9 Flashcards')
  assert.equal(await page.locator('[data-word-type]').count(), 0)
  assert.match(await page.locator('.due-hero > .kicker').textContent(), /Nouns/)
  assert.equal(await page.locator('#start').isDisabled(), true)
  await page.locator('#show-all-types').click()
  await page.waitForFunction(() => document.querySelector('#start')?.disabled === false && !document.querySelector('#show-all-types'))
  assert.deepEqual(await settings(), originalSettings, 'empty-match All button clears only wordTypes')
  await tab('Decks', '#/decks', 'Decks')
  assert.equal(await page.locator('[data-word-type="all"]').getAttribute('aria-pressed'), 'true')
  assert.deepEqual(await snapshot(), untypedFixture, 'empty-match recovery preserves cards, schedules and streaks')
  // Study preferences belong to the selected deck, including the Review size control.
  await tab('Review', '#/', 'LS9 Flashcards')
  await page.click('[data-session="20"]')
  await page.waitForFunction(() => document.querySelector('[data-session="20"]')?.classList.contains('is-on'))
  await tab('Decks', '#/decks', 'Decks')
  await page.fill('#new-deck [name="name"]', 'French fixture')
  await page.fill('#new-deck [name="targetLang"]', 'French')
  await page.click('#new-deck [type="submit"]')
  await page.waitForSelector('#session-custom')
  assert.deepEqual(await settings(), { direction: 'de-en', sessionSize: 20, tier: 3, wordTypes: [] })
  // Exercise actual editor and import writes on the second deck using a German pair.
  const sharedPair = untypedFixture.cards[0]
  await tab('Cards', '#/deck', 'Cards')
  await page.click('a[href="#/card/new"]')
  await page.waitForSelector('#form')
  await page.fill('[name="de"]', 'éditeur')
  await page.fill('[name="en"]', 'editor')
  await page.click('#form [type="submit"]')
  await page.waitForSelector('#search')
  await page.click('a[href="#/import"]')
  await page.waitForSelector('#paste')
  assert((await page.locator('#main').textContent()).includes('Import into French fixture'))
  const csvCell = value => `"${value.replaceAll('"', '""')}"`
  await page.fill('#paste', `front,back\n${csvCell(sharedPair.de)},${csvCell(sharedPair.en)}\nbonjour,hello`)
  await page.click('#run')
  await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('2 new cards'))
  await page.click('#run')
  await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('0 new cards'))
  const secondDeck = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    return { id: (await db.getActiveDeck()).id, cards: await db.getAllCards() }
  })
  assert.equal(secondDeck.cards.length, 3, 'editor plus two CSV rows; repeated import skips duplicates')
  assert(secondDeck.cards.every(card => card.deckId === secondDeck.id && card.srs.reps === 0 && card.srs.due <= Date.now()), 'second-deck cards have ownership and are immediately due')
  assert(secondDeck.cards.some(card => card.de === sharedPair.de && card.en === sharedPair.en), 'same pair exists in both decks')
  await tab('Review', '#/', 'French fixture')
  await page.fill('#session-custom', '5')
  await page.locator('#session-custom').dispatchEvent('change')
  await page.waitForFunction(async () => (await (await import('/src/db.ts')).getSettings()).sessionSize === 5)
  await tab('Decks', '#/decks', 'Decks')
  await page.click('[data-switch="local-german"]')
  await page.waitForSelector('#start')
  assert.equal((await settings()).sessionSize, 20)
  assert.equal(await page.locator('[data-session="20"].is-on').count(), 1)
  await tab('Decks', '#/decks', 'Decks')
  await page.click('[data-switch]')
  await page.waitForSelector('#session-custom')
  await page.reload()
  await page.waitForSelector('#session-custom')
  assert.equal((await settings()).sessionSize, 5)
  assert.equal(await page.locator('#session-custom').inputValue(), '5')
  await tab('Decks', '#/decks', 'Decks')
  await page.click('[data-switch="local-german"]')
  await page.waitForSelector('#start')
  assert.deepEqual(await snapshot(), untypedFixture, 'deck creation and settings switches preserve German cards, schedules and activity')
  // Language labels follow metadata; persisted directions retain their legacy keys.
  await tab('Decks', '#/decks', 'Decks')
  await page.fill('#new-deck [name="name"]', 'Spanish')
  await page.fill('#new-deck [name="targetLang"]', 'Spanish')
  await page.click('#new-deck [type="submit"]')
  await page.waitForSelector('#session-custom')
  await tab('Cards', '#/deck', 'Cards')
  assert.equal(await page.locator('#search').getAttribute('placeholder'), 'Search Spanish or English')
  await page.click('a[href="#/card/new"]')
  await page.waitForSelector('#form')
  for (const [field, label] of [['de', 'Spanish'], ['en', 'English'], ['example_de', 'Example (Spanish)'], ['example_en', 'Example (English)']]) {
    assert.equal((await page.locator(`[name="${field}"]`).locator('..').textContent()).trim(), label)
  }
  await page.fill('[name="de"]', 'hola')
  await page.fill('[name="en"]', 'hello')
  assert.equal(await page.locator('[name="article"], [name="wordType"], [name="tier"]').count(), 0, 'new decks hide all extra editor fields')
  await page.click('#form [type="submit"]')
  await page.waitForSelector('#search')
  await tab('Decks', '#/decks', 'Decks')
  assert.deepEqual(await page.locator('#dir button').allTextContents(), ['Spanish → English', 'English → Spanish'])
  async function assertLanguageFaces(front, back) {
    await tab('Review', '#/', 'Spanish')
    await page.click('#start')
    await page.waitForSelector('#card')
    assert.equal(await page.locator('.front .prompt').textContent(), front)
    assert.equal(await page.locator('.back .prompt').textContent(), back)
    assert.equal(await page.locator('.front .word').textContent(), front === 'Spanish' ? 'hola' : 'hello')
    await page.click('#back')
    await page.waitForSelector('#start')
    await tab('Decks', '#/decks', 'Decks')
  }
  await assertLanguageFaces('Spanish', 'English')
  await pickPreference('[data-dir="en-de"]', { direction: 'en-de' })
  await assertLanguageFaces('English', 'Spanish')
  await page.click('[data-switch="local-german"]')
  await page.waitForSelector('#start')
  await tab('Decks', '#/decks', 'Decks')
  await pickPreference('[data-dir="de-en"]', { direction: 'de-en' })
  await pickPreference('[data-dir="en-de"]', { direction: 'en-de' })
  const germanWrite = await page.evaluate(async () => {
    const { settingsToDoc } = await import('/src/firestore-docs.ts')
    const settings = await (await import('/src/db.ts')).getSettings()
    const doc = settingsToDoc(settings, settings.settingsUpdatedAt)
    return { direction: doc.direction }
  })
  assert.deepEqual(germanWrite, { direction: 'en-de' })
  await tab('Cards', '#/deck', 'Cards')
  assert.equal(await page.locator('#search').getAttribute('placeholder'), 'Search German or English')
  assert.deepEqual(await snapshot(), untypedFixture, 'language UI preserves German cards, schedules and activity')
  // Capability switches hide controls without discarding filters or card metadata.
  await tab('Decks', '#/decks', 'Decks')
  assert.equal(await page.locator('[data-feature]:checked').count(), 3, 'original German deck enables every extra')
  await pickPreference('[data-tier="1"]', { tier: 1 })
  await pickType('noun', ['noun'])
  async function feature(key, enabled) {
    await page.locator(`[data-feature="${key}"]`).setChecked(enabled)
    await page.waitForFunction(async ({ key, enabled }) => {
      const deck = await (await import('/src/db.ts')).getActiveDeck()
      return deck[key] === enabled && document.querySelector(`[data-feature="${key}"]`)?.checked === enabled
        && (key !== 'tiers' || !!document.querySelector('[data-tier]') === enabled)
        && (key !== 'supportsWordTypes' || !!document.querySelector('[data-word-type]') === enabled)
    }, { key, enabled })
  }
  for (const key of ['articles', 'supportsWordTypes', 'tiers']) await feature(key, false)
  await page.reload()
  await page.waitForSelector('[data-feature="articles"]')
  assert.equal(await page.locator('[data-feature]:checked, [data-tier], [data-word-type]').count(), 0)
  const disabledSettings = await settings()
  assert.equal(disabledSettings.tier, 1)
  assert.deepEqual(disabledSettings.wordTypes, ['noun'], 'hidden filter selection is retained')
  await tab('Review', '#/', 'LS9 Flashcards')
  const totalDue = await page.evaluate(async () => (await (await import('/src/db.ts')).getAllCards()).filter(c => c.srs.due <= Date.now()).length)
  assert.equal(Number(await page.locator('[data-due-count]').textContent()), totalDue, 'disabled filters include every due card')
  await page.click('[data-session="0"]')
  await page.waitForFunction(() => document.querySelector('[data-session="0"]')?.classList.contains('is-on'))
  await page.click('#start')
  await page.waitForSelector('#card')
  assert.equal(Number(await page.locator('[data-remaining]').textContent()), totalDue)
  await page.click('#card')
  assert.equal(await page.locator('[data-grade="wrong_gender"], .article, .word-type').count(), 0)
  await page.click('#back')
  await page.waitForSelector('#start')
  await tab('Cards', '#/deck', 'Cards')
  assert.equal(await page.locator('[data-tier]').count(), 0)
  assert.equal(await page.locator('.card-list .card-row').count(), untypedFixture.cards.length)
  await page.locator('.card-list .card-row').first().click()
  await page.waitForSelector('#form')
  assert.equal(await page.locator('[name="article"], [name="wordType"], [name="tier"]').count(), 0)
  await page.click('#form [type="submit"]')
  await page.waitForSelector('#search')
  const hiddenEdit = await snapshot()
  for (const card of untypedFixture.cards) {
    const saved = hiddenEdit.cards.find(c => c.id === card.id)
    assert.equal(saved.article, card.article)
    assert.deepEqual(saved.tags, card.tags)
    assert.equal(saved.tier, card.tier)
    assert.deepEqual(saved.srs, card.srs)
  }
  assert.deepEqual(hiddenEdit.activity, untypedFixture.activity)
  // Simulate a foreground merge after the editor captures its initial card.
  await page.locator('.card-list .card-row').first().click()
  await page.waitForSelector('#form')
  const mergedCard = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const id = decodeURIComponent(location.hash.split('/').at(-1))
    const card = await db.getCard(id)
    const fresh = {
      ...card,
      article: card.article === 'das' ? 'die' : 'das',
      tags: ['verb', 'adj', 'merged-tag'],
      tier: card.tier === 2 ? 1 : 2,
      srs: { ...card.srs, due: Date.now() + 86400000 },
      updated_at: Date.now(),
    }
    await db.putCard(fresh)
    return fresh
  })
  await page.locator('[name="en"]').fill('Edited while extras are hidden')
  await page.locator('[name="tags"]').fill('edited-tag')
  await page.click('#form [type="submit"]')
  await page.waitForSelector('#search')
  const savedAfterMerge = await page.evaluate(async id => (await import('/src/db.ts')).getCard(id), mergedCard.id)
  assert.equal(savedAfterMerge.en, 'Edited while extras are hidden')
  assert.equal(savedAfterMerge.article, mergedCard.article, 'hidden article preserves foreground metadata')
  assert.deepEqual(savedAfterMerge.tags, ['verb', 'adj', 'edited-tag'], 'hidden types preserve foreground metadata while visible tags remain editable')
  assert.equal(savedAfterMerge.tier, mergedCard.tier, 'hidden tier preserves foreground metadata')
  assert.deepEqual(savedAfterMerge.srs, mergedCard.srs, 'editing preserves foreground progress')
  await tab('Decks', '#/decks', 'Decks')
  for (const key of ['articles', 'supportsWordTypes', 'tiers']) await feature(key, true)
  assert.equal(await page.locator('[data-word-type]').count(), 4, 'enabling Word types restores chips')
  await pickType('all', [])
  await pickPreference('[data-tier="3"]', { tier: 3 })
  // A noun still offers Gender, and none never does.
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const cards = await db.getAllCards()
    const noun = cards.find(c => c.article !== 'none')
    await db.putSettings({ sessionSize: 1 })
    await db.putCards(cards.map(c => ({ ...c, srs: { ...c.srs, due: c.id === noun.id ? 0 : Date.now() + 86400000 } })))
  })
  await tab('Review', '#/', 'LS9 Flashcards')
  await page.click('#start')
  await page.waitForSelector('#card')
  await page.click('#card')
  assert.equal(await page.locator('[data-grade="wrong_gender"]').isVisible(), true, 'German noun offers Gender')
  await page.click('#back')
  await page.waitForSelector('#start')
  await tab('Decks', '#/decks', 'Decks')
  const spanishId = await page.evaluate(async () => (await (await import('/src/db.ts')).getDecks()).find(d => d.name === 'Spanish').id)
  await page.locator(`[data-switch="${spanishId}"]`).click()
  await page.waitForSelector('#session-custom')
  await tab('Decks', '#/decks', 'Decks')
  assert.equal(await page.locator('[data-feature]:checked, [data-word-type], [data-tier]').count(), 0, 'new deck starts with all extras off')
  await feature('articles', true)
  await feature('supportsWordTypes', true)
  await feature('tiers', true)
  await tab('Cards', '#/deck', 'Cards')
  await page.click('a[href="#/card/new"]')
  await page.waitForSelector('#form')
  assert.equal(await page.locator('[name="article"]').inputValue(), 'none', 'enabling Articles does not supply an article')
  assert.deepEqual(await page.locator('[name="article"] option').evaluateAll(options => options.map(o => o.value)), ['der', 'die', 'das', 'none'])
  await page.click('#back')
  await page.waitForSelector('#search')
  const newDeckCards = await page.evaluate(async () => (await (await import('/src/db.ts')).getAllCards()))
  assert.equal(newDeckCards.length, 1)
  assert(newDeckCards.every(c => c.article === 'none'), 'switches do not fill existing articles')
  await tab('Review', '#/', 'Spanish')
  await page.click('#start')
  await page.waitForSelector('#card')
  await page.click('#card')
  assert.equal(await page.locator('[data-grade="wrong_gender"]').count(), 0, 'article none hides Gender even with Articles on')
  // Rename and delete through the UI; compare exact retained storage, including due dates.
  await page.click('#back')
  await page.waitForSelector('#start')
  await tab('Decks', '#/decks', 'Decks')
  const retained = () => page.evaluate(async () => {
    const { activeUserSlug, dbNameForUser } = await import('/src/user.ts')
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbNameForUser(activeUserSlug()))
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction([...db.objectStoreNames], 'readonly')
        const result = {}
        for (const store of db.objectStoreNames) {
          const read = tx.objectStore(store).getAll()
          read.onsuccess = () => { result[store] = read.result }
        }
        tx.oncomplete = () => { db.close(); resolve(result) }
      }
    })
  })
  assert.equal(await page.locator('[data-delete-deck="local-german"]').count(), 0, 'original has no delete control')
  const originalName = await page.evaluate(async () => (await (await import('/src/db.ts')).getActiveDeck()).name)
  await respondToDialog(`[data-rename="${spanishId}"]`, dialog => dialog.accept('Renamed Spanish'))
  await page.getByText('Renamed Spanish', { exact: true }).waitFor()
  await page.reload()
  await page.getByText('Renamed Spanish', { exact: true }).waitFor()
  assert.equal(originalName, 'Spanish')
  // Original decks can also be renamed, without changing their protected origin.
  await respondToDialog('[data-rename="local-german"]', dialog => dialog.accept('German study'))
  await page.getByText('German study', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-delete-deck="local-german"]').count(), 0)
  const beforeDelete = await retained()
  let deleteMessage
  await respondToDialog(`[data-delete-deck="${spanishId}"]`, async dialog => {
    deleteMessage = dialog.message()
    await dialog.dismiss()
  })
  assert.match(deleteMessage, /Renamed Spanish/)
  assert.match(deleteMessage, /1 card/)
  assert.deepEqual(await retained(), beforeDelete, 'cancelling deletion writes nothing')
  await respondToDialog(`[data-delete-deck="${spanishId}"]`, dialog => dialog.accept())
  await page.locator(`[data-delete-deck="${spanishId}"]`).waitFor({ state: 'detached' })
  const deleted = await retained()
  assert.deepEqual(deleted.decks, beforeDelete.decks.filter(d => d.id !== spanishId), 'only deleted deck preferences and metadata disappear')
  assert.deepEqual(deleted.cards, beforeDelete.cards.filter(c => c.deckId !== spanishId), 'all retained cards and schedules survive exactly')
  assert.deepEqual(deleted.activity, beforeDelete.activity, 'deleting a studied deck retains every streak event')
  assert.equal(deleted.settings[0].activeDeckId, 'local-german', 'deleting active deck selects a remaining deck')
  const removedIds = beforeDelete.cards.filter(c => c.deckId === spanishId).map(c => c.id)
  const expectedSettings = structuredClone(beforeDelete.settings[0])
  expectedSettings.activeDeckId = 'local-german'
  delete expectedSettings.pending.extraSettings?.[spanishId]
  for (const id of removedIds) {
    delete expectedSettings.pending.cards[id]
    delete expectedSettings.pending.progress[id]
  }
  assert.deepEqual(deleted.settings, [expectedSettings], 'original settings, pending work and activity markers survive')
  await page.reload()
  await page.getByText('German study', { exact: true }).waitFor()
  assert.deepEqual(await retained(), deleted, 'deleted deck and cards stay absent after reload without reseeding')
  // Delete an inactive deck with a card tombstone, preserving original selection.
  const frenchId = secondDeck.id
  await page.evaluate(async id => {
    const api = await import('/src/db.ts')
    await api.switchActiveDeck(id)
    await api.deleteCard((await api.getAllCards())[0].id)
    await api.switchActiveDeck('local-german')
  }, frenchId)
  await page.reload()
  await page.locator(`[data-delete-deck="${frenchId}"]`).waitFor()
  await respondToDialog(`[data-delete-deck="${frenchId}"]`, dialog => dialog.accept())
  await page.locator(`[data-delete-deck="${frenchId}"]`).waitFor({ state: 'detached' })
  const finalState = await retained()
  assert.equal(finalState.decks.length, 1)
  assert.equal(await page.locator('[data-delete-deck]').count(), 0)
  assert.equal(finalState.settings[0].activeDeckId, 'local-german')
  assert(!Object.values(finalState.settings[0].deletedDeckIds ?? {}).includes(frenchId), 'deleted deck tombstones are removed locally')
  assert.deepEqual(finalState.cards, deleted.cards.filter(c => c.deckId !== frenchId))
  assert.deepEqual(finalState.activity, deleted.activity)
  const guards = await page.evaluate(async () => {
    const api = await import('/src/db.ts')
    const { bindStudyDatabase, clearStudyBinding } = await import('/src/study-lock.ts')
    const original = await api.deleteLocalDeck('local-german')
    const blank = await api.renameDeck('local-german', '   ')
    const tooLong = await api.renameDeck('local-german', 'x'.repeat(61))
    try {
      bindStudyDatabase({ uid: null, dbName: 'last-local-deck-fixture-70' })
      await api.createLocalDeck('Only local', 'French')
      // Isolate the last-deck guard from the original-deck guard.
      const req = indexedDB.open('last-local-deck-fixture-70')
      await new Promise((resolve, reject) => {
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('decks', 'readwrite')
          tx.objectStore('decks').delete('local-german')
          tx.oncomplete = () => { db.close(); resolve() }
        }
      })
      const only = await api.getActiveDeck()
      return { original, blank, tooLong, last: await api.deleteLocalDeck(only.id), count: (await api.getDecks()).length }
    } finally { clearStudyBinding() }
  })
  assert.deepEqual(guards, { original: false, blank: false, tooLong: false, last: false, count: 1 })
  assert.deepEqual(errors, [], 'no browser errors')
  assert.deepEqual(externalRequests, [], 'no external service access')
  console.log('decks-ui: v2/v3 card and tombstone upgrades, deck-isolated reads/writes/counts/sync, original-only seed insertion, four ordered tabs, native touch swipes, boundaries, history, vertical scrolling, hidden-screen and mouse guards, distinct routes, deck count, Decks-only saved tier/direction/word-type controls, unsaved Cards filters, Review-only session size, Settings content, persisted review filters, All/last deselection, empty-match recovery, edit/import, German cards/schedules/streak preservation: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

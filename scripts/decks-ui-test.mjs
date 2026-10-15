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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  const externalRequests = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    externalRequests.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
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
      for (const version of [2, 3]) for (const assigned of [false, true]) {
        const name = `deck-upgrade-fixture-${version}-${assigned}`
        await new Promise((resolve, reject) => {
          const req = indexedDB.open(name, version)
          req.onupgradeneeded = () => {
            for (const store of ['cards', 'settings', 'activity']) req.result.createObjectStore(store, { keyPath: 'id' })
            req.transaction.objectStore('cards').put(existing)
            req.transaction.objectStore('settings').put({ ...oldSettings, deletedIds: { 'deleted-fixture': 63 }, ...(version === 3 ? { activeDeckId: 'local-german' } : {}) })
            if (version === 3) req.result.createObjectStore('decks', { keyPath: 'id' }).put({ id: 'local-german', name: 'German', targetLang: 'German', baseLang: 'English', articles: true, wordTypes: true, tiers: true, origin: 'original' })
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
    assert.equal(result.after.version, 4)
    assert.equal(result.due, result.expectedDue, 'one-deck upgrade preserves due count')
    assert.deepEqual(result.after.cards, result.before.cards.map(card => ({ ...card, deckId: id })), 'upgrade only stamps deck ownership; exact cards and due dates survive')
    assert.deepEqual(result.after.activity, result.before.activity, 'upgrade retains exact streak events')
    assert.deepEqual(result.after.settings, [{ ...result.before.settings[0], activeDeckId: id, deletedDeckIds: { 'deleted-fixture': id } }], 'upgrade changes only local selection')
    assert.deepEqual(result.decks, [{ id, name: 'German', targetLang: 'German', baseLang: 'English', articles: true, wordTypes: true, tiers: true, origin: 'original' }])
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
  assert.deepEqual(await page.locator('#tabbar .tab').allTextContents(), ['Review', 'Cards', 'Decks', 'Settings'])
  async function tab(name, hash, heading) {
    await page.locator('#tabbar .tab').filter({ hasText: new RegExp(`^${name}$`) }).click()
    await page.waitForFunction(({ hash, heading }) => location.hash === hash && document.querySelector('h1')?.textContent === heading, { hash, heading })
    assert.equal(await page.locator('#tabbar .is-active').textContent(), name)
    assert.equal(await page.getByText('FOREIGN_FIXTURE_64', { exact: true }).count(), 0, 'foreign card never appears in UI')
  }
  async function assertDeckCount(count) {
    assert.equal(await page.locator('#main .card-row').count(), 1)
    assert.equal(await page.locator('#main .de').textContent(), 'German')
    assert.equal(await page.locator('#main .en').textContent(), `${count} cards`)
    assert.equal(await page.locator('#main .badge').textContent(), 'Active')
    assert.equal(await page.locator('#main .card-row a, #main .card-row button, #main .card-row input').count(), 0)
    assert.equal(await page.locator('[data-word-type]').count(), 4)
    assert.equal(await page.locator('[data-tier]').count(), 3)
    assert.deepEqual(await page.locator('#dir button').allTextContents(), ['DE → EN', 'EN → DE'])
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
    await page.locator(`[data-word-type="${type}"]`).click()
    await page.waitForFunction(async expected => {
      const db = await import('/src/db.ts')
      const selected = (await db.getSettings()).wordTypes
      const pressed = [...document.querySelectorAll('[data-word-type][aria-pressed="true"]')].map(button => button.dataset.wordType)
      return JSON.stringify(selected) === JSON.stringify(expected)
        && JSON.stringify(pressed) === JSON.stringify(expected.length ? expected : ['all'])
    }, expected)
    assert.deepEqual(await settings(), { ...originalSettings, wordTypes: expected }, 'only the word-type preference changes')
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
  assert.deepEqual(errors, [], 'no browser errors')
  assert.deepEqual(externalRequests, [], 'no external service access')
  console.log('decks-ui: v2/v3 card and tombstone upgrades, deck-isolated reads/writes/counts/sync, original-only seed insertion, four tabs, distinct routes, deck count, Decks-only saved tier/direction/word-type controls, unsaved Cards filters, Review-only session size, Settings content, persisted review filters, All/last deselection, empty-match recovery, edit/import, German cards/schedules/streak preservation: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

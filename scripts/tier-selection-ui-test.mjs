// Exact review buckets, persisted preferences and cloud merges in disposable IndexedDB.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'tier-selection-'))
let server, browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4189, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, serviceWorkers: 'block' })
  const external = [], errors = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    external.push(route.request().url()); return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://127.0.0.1:4189/')
  await page.waitForSelector('#start')
  const pressed = () => page.locator('#tier-chips [aria-pressed="true"]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.tier)))
  assert.deepEqual(await pressed(), [1], 'fresh legacy Tier 1 retains its scope')
  const before = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.putSettings({ tier: 3, sessionSize: 0 })
    return { cards: await db.getAllCards(), activity: await db.getReviewActivity() }
  })
  await page.reload(); await page.waitForSelector('#start')
  assert.deepEqual(await pressed(), [1, 2, 3], 'legacy Tier 3 keeps tiers 1-3 and does not add tier 4')
  const pick = async (tier, expected) => {
    await page.click(`[data-tier="${tier}"]`)
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#tier-chips [aria-pressed="true"]')].map(n => Number(n.dataset.tier))) === JSON.stringify(expected), expected)
  }
  await pick(1, [2, 3]); await pick(2, [3])
  assert.equal(await page.locator('[data-due-count]').textContent(), '264', 'Tier 3 excludes the first 250 words')
  assert.equal(await page.locator('[data-tier="3"]').textContent(), 'T3: 264', 'pill reads T<n>: <due>')
  assert.equal(await page.locator('[data-tier="3"]').getAttribute('aria-label'), 'Tier 3, 264 due')
  assert.equal(await page.locator('[data-tier="1"]').textContent(), 'T1: 100')
  assert.equal(await page.locator('[data-tier="4"]').textContent(), 'T4: 250', 'the German deck offers tier 4')
  const rows = await page.locator('[data-tier]').evaluateAll(nodes => new Set(nodes.map(n => Math.round(n.getBoundingClientRect().top))).size)
  assert.equal(rows, 1, 'pills share one row at mobile width')
  await page.reload(); await page.waitForSelector('#start')
  assert.deepEqual(await pressed(), [3], 'exact selection survives reload')
  await page.click('#start'); await page.waitForSelector('#card')
  assert.equal(await page.locator('[data-remaining]').textContent(), '264', 'actual study session uses exact buckets')
  await page.click('#back'); await page.waitForSelector('#start')
  await pick(2, [2, 3])
  assert.equal(await page.locator('[data-due-count]').textContent(), '414')
  await page.click('[data-word-type="verb"]')
  await page.waitForSelector('[data-word-type="verb"][aria-pressed="true"]')
  const expectedVerbs = await page.evaluate(async () => {
    const cards = await (await import('/src/db.ts')).getAllCards()
    const { inSelectedWordTypes } = await import('/src/word-types.ts')
    return cards.filter(c => (c.tier === 2 || c.tier === 3) && inSelectedWordTypes(c, ['verb'])).length
  })
  assert.equal(Number(await page.locator('[data-due-count]').textContent()), expectedVerbs, 'tier and word-type filters intersect')
  await page.click('[data-word-type="all"]'); await page.waitForSelector('[data-word-type="all"][aria-pressed="true"]')
  await pick(2, [3]); await pick(3, [1, 2, 3, 4])
  assert.equal(await page.locator('[data-due-count]').textContent(), '764', 'last deselection returns to all tiers')
  assert.match(await page.locator('.due-hero .kicker').textContent(), /All tiers/)
  await pick(1, [2, 3, 4]); await pick(2, [3, 4]); await pick(3, [4])
  assert.equal(await page.locator('[data-due-count]').textContent(), '250', 'Tier 4 can be studied on its own')
  await page.reload(); await page.waitForSelector('#start')
  assert.deepEqual(await pressed(), [4], 'Tier 4 alone survives reload')
  await page.click('#start'); await page.waitForSelector('#card')
  assert.equal(await page.locator('[data-remaining]').textContent(), '250', 'the Tier 4 session holds only tier 4 cards')
  await page.click('#back'); await page.waitForSelector('#start')
  await pick(1, [1, 4])
  assert.equal(await page.locator('[data-due-count]').textContent(), '350', 'Tier 4 combines with other tiers')
  // Remote exact selections and old-client cumulative settings both replace the prior scope.
  for (const [selectedTiers, tier, count, expected] of [[[1, 3], 3, 364, [1, 3]], [[3, 4], 4, 514, [3, 4]], [undefined, 4, 764, [1, 2, 3, 4]], [undefined, 2, 250, [1, 2]]]) {
    await page.evaluate(async ({ selectedTiers, tier }) => {
      const db = await import('/src/db.ts')
      const { settingsToDoc, docsToFiles } = await import('/src/firestore-docs.ts')
      const at = (await db.getSettings()).settingsUpdatedAt + 1000
      const settings = { direction: 'de-en', sessionSize: 0, tier, wordTypes: [], ...(selectedTiers ? { selectedTiers } : {}) }
      const remote = docsToFiles({ cards: [], progress: [], settings: settingsToDoc(settings, at) }, 'fixture', at).user
      await db.mergeProgressIntoDb(remote)
    }, { selectedTiers, tier })
    await page.reload(); await page.waitForSelector('#start')
    assert.deepEqual(await pressed(), expected)
    assert.equal(Number(await page.locator('[data-due-count]').textContent()), count)
  }
  const isolated = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.putSettings({ tier: 3, selectedTiers: [2, 3] })
    const original = (await db.getActiveDeck()).id
    const extra = await db.createLocalDeck('Other subject', 'Example')
    await db.putSettings({ tier: 3, selectedTiers: [3] })
    await db.switchActiveDeck(original)
    const originalSelection = (await db.getSettings()).selectedTiers
    await db.switchActiveDeck(extra.id)
    const extraSelection = (await db.getSettings()).selectedTiers
    await db.switchActiveDeck(original)
    return { originalSelection, extraSelection, cards: await db.getAllCards(), activity: await db.getReviewActivity() }
  })
  assert.deepEqual(isolated.originalSelection, [2, 3])
  assert.deepEqual(isolated.extraSelection, [3], 'each deck keeps its own exact selection')
  assert.deepEqual(isolated.cards, before.cards, 'filtering and preference merges preserve every card and schedule')
  assert.deepEqual(isolated.activity, before.activity)

  // An account created before tier 4: its database holds only the original 514 words, with
  // edits, schedules and a seed deletion. Opening the app runs the normal seed update.
  const rewound = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { dbNameForUser, activeUserSlug } = await import('/src/user.ts')
    const mutate = (change) => new Promise((resolve, reject) => {
      const req = indexedDB.open(dbNameForUser(activeUserSlug()))
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const tx = req.result.transaction(['cards', 'settings'], 'readwrite')
        change(tx)
        tx.oncomplete = () => { req.result.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
    const cards = await db.getAllCards()
    const edited = { ...cards.find(c => c.id === 'seed-01'), en: 'man (edited)', updated_at: 5000 }
    const studied = { ...cards.find(c => c.id === 'seed-02'), srs: { ease: 2.6, interval: 9, reps: 4, due: Date.now() + 9 * 86400000, updated_at: 6000 } }
    await mutate(tx => {
      for (const card of cards) if (card.tier === 4 && card.id !== 'seed-600') tx.objectStore('cards').delete(card.id)
      tx.objectStore('cards').put(edited)
      tx.objectStore('cards').put(studied)
    })
    await db.deleteCard('seed-600')
    return { count: (await db.getAllCards()).length, edited, studied }
  })
  assert.equal(rewound.count, 514, 'fixture starts as a pre-tier-4 database')
  await page.reload(); await page.waitForSelector('#start')
  const updated = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const cards = await db.getAllCards()
    const { dbNameForUser, activeUserSlug } = await import('/src/user.ts')
    const settings = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbNameForUser(activeUserSlug()))
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const get = req.result.transaction('settings').objectStore('settings').get('settings')
        get.onsuccess = () => { req.result.close(); resolve(get.result) }
      }
    })
    return {
      count: cards.length,
      tier4: cards.filter(c => c.tier === 4).length,
      deletedSeed: cards.some(c => c.id === 'seed-600'),
      edited: cards.find(c => c.id === 'seed-01'),
      studied: cards.find(c => c.id === 'seed-02'),
      newCard: cards.find(c => c.id === 'seed-515'),
      pending: Boolean(settings.pending.cards['seed-515'] && settings.pending.progress['seed-515']),
    }
  })
  assert.equal(updated.count, 763, 'the seed update adds the missing tier 4 words')
  assert.equal(updated.tier4, 249)
  assert.equal(updated.deletedSeed, false, 'a deleted tier 4 seed stays deleted')
  assert.deepEqual(updated.edited, rewound.edited, 'a user edit survives the seed update')
  assert.deepEqual(updated.studied, rewound.studied, 'a schedule survives the seed update')
  assert.equal(updated.newCard.de, 'Wäscheklammer'); assert.equal(updated.newCard.srs.reps, 0)
  assert.equal(updated.pending, true, 'new tier 4 cards are queued for upload')
  assert.equal(await page.locator('[data-tier="4"]').textContent(), 'T4: 249')
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('tier selection UI: exact/disjoint buckets incl. tier 4, legacy scopes, reload, actual queue, type intersection, last deselection, cloud adapters/merge, deck isolation and the tier 4 seed update: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

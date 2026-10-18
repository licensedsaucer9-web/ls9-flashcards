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
  assert.deepEqual(await pressed(), [1, 2, 3], 'legacy Tier 3 becomes all three buckets')
  const pick = async (tier, expected) => {
    await page.click(`[data-tier="${tier}"]`)
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#tier-chips [aria-pressed="true"]')].map(n => Number(n.dataset.tier))) === JSON.stringify(expected), expected)
  }
  await pick(1, [2, 3]); await pick(2, [3])
  assert.equal(await page.locator('[data-due-count]').textContent(), '264', 'Tier 3 excludes the first 250 words')
  assert.match(await page.locator('[data-tier="3"]').textContent(), /264 · 264 due/)
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
    return cards.filter(c => c.tier !== 1 && inSelectedWordTypes(c, ['verb'])).length
  })
  assert.equal(Number(await page.locator('[data-due-count]').textContent()), expectedVerbs, 'tier and word-type filters intersect')
  await page.click('[data-word-type="all"]'); await page.waitForSelector('[data-word-type="all"][aria-pressed="true"]')
  await pick(2, [3]); await pick(3, [1, 2, 3])
  assert.equal(await page.locator('[data-due-count]').textContent(), '514', 'last deselection returns to all tiers')
  // Remote exact selections and old-client cumulative settings both replace the prior scope.
  for (const [selectedTiers, tier, count, expected] of [[[1, 3], 3, 364, [1, 3]], [undefined, 2, 250, [1, 2]]]) {
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
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('tier selection UI: exact/disjoint buckets, legacy scopes, reload, actual queue, type intersection, last deselection, cloud adapters/merge and deck isolation: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

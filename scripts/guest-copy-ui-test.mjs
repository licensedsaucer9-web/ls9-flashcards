// Guest-to-account copy pairs the original deck with the original deck (#109); fresh browser storage, no live services.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'guest-copy-ui-test-'))
let server
let browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, server: { host: '127.0.0.1', port: 4195, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:4195/')
  await page.waitForSelector('#start')

  const runs = await page.evaluate(async () => {
    const api = await import('/src/db.ts')
    const { bindStudyDatabase, clearStudyBinding } = await import('/src/study-lock.ts')
    const german = (id, due) => ({
      id, de: `de-${id}`, en: `en-${id}`, article: null, example_de: '', example_en: '', tags: [], rank: 1, tier: 1,
      created_at: 1, updated_at: 1, srs: { ease: 2.5, interval: due, reps: 3, due },
    })
    const rows = name => new Promise((resolve, reject) => {
      const req = indexedDB.open(name)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['cards', 'settings', 'decks'], 'readonly')
        const cards = tx.objectStore('cards').getAll()
        const settings = tx.objectStore('settings').get('settings')
        const decks = tx.objectStore('decks').getAll()
        tx.oncomplete = () => { db.close(); resolve({ cards: cards.result, settings: settings.result, decks: decks.result }) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
    // Seed a database: German cards, then an optional starter deck that stays open.
    const seed = async (name, starter, tag) => {
      bindStudyDatabase({ uid: null, dbName: name })
      await api.putCard(german(`g-only-${tag}`, 40))
      await api.putCard(german('g-shared', tag === 'guest' ? 99 : 5))
      let deck = null
      if (starter) {
        deck = await api.addStarterDeck(starter)
        const cards = (await api.getAllCards()).filter(card => card.deckId === deck.id)
        await api.saveReview(cards[0].id, 'good', crypto.randomUUID(), Date.now(), 'UTC')
      }
      return deck
    }
    const out = []
    try {
      // The guest was last studying French, as in the reported scenario.
      let index = 0
      for (const mode of ['vocabulary', 'progress']) {
        for (const targetStarter of [null, 'fr', 'es']) {
          const guest = `guest-${index}`
          const account = `account-${index++}`
          await seed(guest, 'fr', 'guest')
          await seed(account, targetStarter, 'account')
          const before = await rows(account)
          bindStudyDatabase({ uid: null, dbName: account })
          const copied = await api.copyGuestDatabase(guest, mode)
          out.push({ mode, targetStarter, copied, before, after: await rows(account), guest: await rows(guest) })
        }
      }
      return out
    } finally { clearStudyBinding() }
  })

  for (const run of runs) {
    const label = `${run.mode}, account has ${run.targetStarter ?? 'no starter deck'}`
    assert.equal(run.copied, true, `${label}: copy ran`)
    const original = run.after.decks.find(deck => deck.origin === 'original').id
    const guestFrench = run.guest.decks.find(deck => deck.starter === 'fr').id
    const guestFrenchIds = new Set(run.guest.cards.filter(card => card.deckId === guestFrench).map(card => card.id))
    const inOriginal = run.after.cards.filter(card => card.deckId === original)
    assert.ok(guestFrenchIds.size > 100, `${label}: fixture guest has a French deck`)
    // 1. The guest's open French deck never lands in the German deck.
    assert.deepEqual(inOriginal.filter(card => guestFrenchIds.has(card.id)).map(card => card.id), [],
      `${label}: no guest French card in the German deck`)
    // 2. The guest's German progress is what arrives, in the German deck.
    const shared = run.after.cards.find(card => card.id === 'g-shared')
    assert.equal(shared.deckId, original, `${label}: German card stays in the German deck`)
    assert.equal(shared.srs.due, 99, `${label}: guest German progress copied`)
    const guestOnly = run.after.cards.find(card => card.id === 'g-only-guest')
    if (run.mode === 'vocabulary') assert.equal(guestOnly?.deckId, original, `${label}: guest-only German card copied`)
    else assert.equal(guestOnly, undefined, `${label}: progress mode copies no vocabulary`)
    // 3. The account's own other decks are untouched.
    const others = cards => cards.filter(card => card.deckId !== original).map(card => [card.id, card.deckId, card.srs])
    assert.deepEqual(others(run.after.cards), others(run.before.cards), `${label}: account's other decks untouched`)
    // 4. Pending marks name the German deck, so a sync of another open deck cannot pick them up.
    const fresh = Object.entries(run.after.settings.pending.progress).filter(([, mark]) => mark.revision > run.before.settings.localRevision)
    assert.ok(fresh.length > 0, `${label}: copy recorded pending progress`)
    for (const [, mark] of fresh) assert.equal(mark.deckId, original, `${label}: pending progress scoped to the German deck`)
    // 5. Which deck is open does not change.
    assert.equal(run.after.settings.activeDeckId, run.before.settings.activeDeckId, `${label}: open deck unchanged`)
    // 6. The guest database stays in place.
    assert.ok(run.guest.cards.some(card => card.id === 'g-shared' && card.srs.due === 99), `${label}: guest database left in place`)
  }
  assert.deepEqual(errors, [], 'no page errors')
  console.log('guest copy: original deck pairs with original deck whichever deck is open on either side: ok')
} finally {
  await browser?.close()
  await server?.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

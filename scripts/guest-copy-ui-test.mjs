// Guest-to-account copy (#109): original deck pairs with original deck, and the French and Spanish
// starter decks copy into the account's own starter decks. Fresh browser storage, no live services.
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

  const { runs, ids, seedEn } = await page.evaluate(async () => {
    const api = await import('/src/db.ts')
    const { bindStudyDatabase, clearStudyBinding } = await import('/src/study-lock.ts')
    const { starterCards, starterDeckId } = await import('/src/starter-decks.ts')
    const seedIds = { fr: starterCards('fr').map(card => card.id), es: starterCards('es').map(card => card.id) }
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
    const review = async (language, index) => {
      await api.saveReview(seedIds[language][index], 'good', crypto.randomUUID(), Date.now(), 'UTC')
    }
    // The device: German deck, then French (reviewed, edited, extended, one card deleted, own session size),
    // then Spanish (reviewed). It was last studying French.
    const seedGuest = async name => {
      bindStudyDatabase({ uid: null, dbName: name })
      await api.putCard(german('g-only-guest', 40))
      await api.putCard(german('g-shared', 99))
      const french = await api.addStarterDeck('fr')
      await review('fr', 0)
      const edit = (await api.getAllCards()).find(card => card.id === seedIds.fr[1])
      await api.putCard({ ...edit, en: 'edited on the device', updated_at: 5 })
      await api.putCard({ ...german('custom-fr', 7), de: 'custom' })
      await api.deleteCard(seedIds.fr[2], 6001)
      await api.putSettings({ sessionSize: 7 })
      await api.addStarterDeck('es')
      await review('es', 0)
      await api.switchActiveDeck(french.id)
    }
    // The account: German deck, optionally a starter deck with progress on a card the device never studied.
    const seedAccount = async (name, starter) => {
      bindStudyDatabase({ uid: null, dbName: name })
      await api.putCard(german('g-only-account', 40)) // German cards first: new cards join the open deck
      await api.putCard(german('g-shared', 5))
      if (starter) {
        await api.addStarterDeck(starter)
        await review(starter, starter === 'fr' ? 3 : 5)
      }
    }
    const out = []
    try {
      let index = 0
      for (const mode of ['vocabulary', 'progress']) {
        for (const starter of [null, 'fr', 'es']) {
          const guest = `guest-${index}`
          const account = `account-${index++}`
          await seedGuest(guest)
          await seedAccount(account, starter)
          const before = await rows(account)
          const frId = await starterDeckId(account, 'fr')
          const esId = await starterDeckId(account, 'es')
          bindStudyDatabase({ uid: null, dbName: account })
          const copied = await api.copyGuestDatabase(guest, mode)
          out.push({ mode, starter, copied, frId, esId, before, after: await rows(account), guest: await rows(guest) })
        }
      }
      return { runs: out, ids: seedIds, seedEn: starterCards('fr')[1].en }
    } finally { clearStudyBinding() }
  })

  const card = (rows, id) => rows.cards.find(item => item.id === id)
  for (const run of runs) {
    const label = `${run.mode}, account ${run.starter ? `has ${run.starter} open` : 'has no starter deck'}`
    assert.equal(run.copied, true, `${label}: copy ran`)
    const vocabulary = run.mode === 'vocabulary'
    const original = run.after.decks.find(deck => deck.origin === 'original').id
    const inDeck = id => run.after.cards.filter(item => item.deckId === id)
    const guestFrench = run.guest.decks.find(deck => deck.starter === 'fr').id

    // German deck: only the device's German deck arrives; no French card ever lands in it.
    assert.ok(run.guest.cards.filter(item => item.deckId === guestFrench).length > 100, `${label}: fixture guest has a French deck`)
    assert.deepEqual(inDeck(original).filter(item => ids.fr.includes(item.id) || item.id === 'custom-fr').map(item => item.id), [],
      `${label}: no French card in the German deck`)
    assert.equal(card(run.after, 'g-shared').srs.due, 99, `${label}: guest German progress copied`)
    assert.equal(card(run.after, 'g-shared').deckId, original, `${label}: German card stays in the German deck`)
    assert.equal(card(run.after, 'g-only-guest')?.deckId, vocabulary ? original : undefined, `${label}: German vocabulary only in vocabulary mode`)

    // French deck: the account's own starter deck (its ID is derived from the account, not the device).
    assert.notEqual(run.frId, guestFrench, `${label}: account and device French decks have different IDs`)
    const french = run.after.decks.find(deck => deck.id === run.frId)
    assert.equal(french?.starter, 'fr', `${label}: account has its French deck`)
    assert.deepEqual(card(run.after, ids.fr[0]).srs, card(run.guest, ids.fr[0]).srs, `${label}: reviewed French card's schedule copied`)
    assert.equal(card(run.after, ids.fr[0]).deckId, run.frId, `${label}: French card lives in the account's French deck`)
    assert.equal(card(run.after, ids.fr[1]).en, vocabulary ? 'edited on the device' : seedEn, `${label}: French edit only in vocabulary mode`)
    assert.equal(card(run.after, 'custom-fr')?.deckId, vocabulary ? run.frId : undefined, `${label}: custom French card only in vocabulary mode`)
    if (vocabulary) {
      assert.equal(card(run.after, ids.fr[2]), undefined, `${label}: French card deleted on the device is deleted`)
      assert.equal(run.after.settings.deletedDeckIds[ids.fr[2]], run.frId, `${label}: tombstone owned by the account's French deck`)
      assert.ok(run.after.settings.pending.tombstones[ids.fr[2]], `${label}: deletion pending upload`)
    } else {
      assert.ok(card(run.after, ids.fr[2]), `${label}: progress mode deletes nothing`)
    }
    assert.equal(inDeck(run.frId).length, ids.fr.length, `${label}: French deck size (one card deleted, one added, or neither)`)
    const progressMark = run.after.settings.pending.progress[ids.fr[0]]
    assert.equal(progressMark?.deckId, run.frId, `${label}: French progress mark names the French deck`)
    assert.equal(french.sessionSize, 7, `${label}: device's French preferences copied`)
    assert.ok(run.after.settings.pending.extraSettings?.[run.frId], `${label}: French preferences pending upload`)
    if (run.starter === 'fr') {
      // Progress the device never touched stays.
      assert.deepEqual(card(run.after, ids.fr[3]).srs, card(run.before, ids.fr[3]).srs, `${label}: account's own French progress kept`)
    }

    // Spanish deck, same rules.
    const spanish = run.after.decks.find(deck => deck.id === run.esId)
    assert.equal(spanish?.starter, 'es', `${label}: account has its Spanish deck`)
    assert.deepEqual(card(run.after, ids.es[0]).srs, card(run.guest, ids.es[0]).srs, `${label}: reviewed Spanish card's schedule copied`)
    assert.equal(card(run.after, ids.es[0]).deckId, run.esId, `${label}: Spanish card lives in the account's Spanish deck`)
    if (run.starter === 'es') {
      assert.deepEqual(card(run.after, ids.es[5]).srs, card(run.before, ids.es[5]).srs, `${label}: account's own Spanish progress kept`)
    }

    // Which deck is open does not change, and nothing else is created.
    assert.equal(run.after.settings.activeDeckId, run.before.settings.activeDeckId, `${label}: open deck unchanged`)
    assert.deepEqual(run.after.decks.map(deck => deck.id).sort(),
      [...new Set([...run.before.decks.map(deck => deck.id), run.frId, run.esId])].sort(), `${label}: only the two starter decks are added`)
    // The device's database stays in place.
    assert.ok(card(run.guest, ids.fr[0]).srs.reps > 0, `${label}: device database left in place`)
  }
  assert.deepEqual(errors, [], 'no page errors')
  console.log('guest copy: German deck pairs with German deck; French and Spanish decks copy into the account\'s own: ok')
} finally {
  await browser?.close()
  await server?.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

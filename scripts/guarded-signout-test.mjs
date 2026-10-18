// Exercise the real account UI and IndexedDB with synthetic Google sessions.
// Only Auth and the import lookup are replaced; no live account is accessed.
import assert from 'node:assert/strict'
import { testStreakUI } from './streak-ui-test.mjs'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { card, srs } from './migration-fixtures.mjs'

const authKey = 'guarded-signout-test.user'
const importedKey = 'guarded-signout-test.imported'
const authModule = '\0guarded-signout-auth'
const cacheDir = mkdtempSync(join(tmpdir(), 'guarded-signout-test-'))
Object.assign(process.env, {
  BASE: '/', VITE_SYNC_BACKEND: 'firebase', VITE_REHEARSAL_PREVIEW: 'true',
  VITE_FIREBASE_API_KEY: 'synthetic-key', VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
  VITE_FIREBASE_PROJECT_ID: 'flashcards-ls9-auth-test', VITE_FIREBASE_APP_ID: 'synthetic-app',
  VITE_FIREBASE_AUTH_EMULATOR: '', VITE_FIREBASE_FIRESTORE_EMULATOR: '',
})

const fakeAuth = `
  const key = ${JSON.stringify(authKey)};
  const user = { uid: 'synthetic-user', displayName: 'Test account' };
  const auth = { currentUser: localStorage.getItem(key) ? user : null };
  const observers = new Set();
  function emit() { for (const observer of observers) queueMicrotask(() => observer(auth.currentUser)); }
  export const browserLocalPersistence = {};
  export function getAuth() { return auth; }
  export async function setPersistence() {}
  export function onAuthStateChanged(_auth, observer) {
    observers.add(observer);
    queueMicrotask(() => observer(auth.currentUser));
    return () => observers.delete(observer);
  }
  export class GoogleAuthProvider {}
  export async function signInWithPopup() {
    window.signInCalls = (window.signInCalls || 0) + 1;
    if (window.failSignIn) throw Object.assign(new Error('Synthetic popup cancellation'), { code: 'auth/popup-closed-by-user' });
    localStorage.setItem(key, '1'); auth.currentUser = user; emit();
  }
  export async function signOut() {
    window.signOutCalls = (window.signOutCalls || 0) + 1;
    if (window.failSignOut) throw new Error('Synthetic sign-out failure');
    localStorage.removeItem(key); auth.currentUser = null; emit();
  }
  export function connectAuthEmulator() { throw new Error('Unexpected emulator connection'); }
`

let server
let browser
const pageErrors = []
const externalRequests = []
try {
  server = await createServer({
    cacheDir,
    server: { host: '127.0.0.1', port: 4181, strictPort: true },
    optimizeDeps: { include: ['firebase/app', 'firebase/firestore'], exclude: ['firebase/auth'], noDiscovery: true },
    plugins: [{
      name: 'synthetic-guarded-account', enforce: 'pre',
      resolveId(id) { if (id === 'firebase/auth') return authModule },
      load(id) {
        if (id === authModule) return fakeAuth
        if (id.endsWith('/src/provision.ts')) return `
          export async function provisionAccount(_db, _uid, options) {
            window.provisionCalls = (window.provisionCalls || 0) + 1;
            if (options.requiredLegacyDeckId !== 'legacy-german') throw new Error('Missing rehearsal guard');
            if (localStorage.getItem(${JSON.stringify(importedKey)})) return { deckId: 'legacy-german', personal: false };
            throw Object.assign(new Error('Synthetic import guard'), { code: 'rehearsal/import-required' });
          }
        `
      },
    }],
  })
  await server.listen()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  async function newPage(restored = false, imported = false, harness = false) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
      hasTouch: true, serviceWorkers: 'block' })
    await context.addInitScript(({ authKey, importedKey, restored, imported }) => {
      if (restored) localStorage.setItem(authKey, '1')
      if (imported) localStorage.setItem(importedKey, '1')
    }, { authKey, importedKey, restored, imported })
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
      externalRequests.push(route.request().url())
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`http://127.0.0.1:4181/${harness ? 'scripts/migration-harness.html' : ''}`)
    return page
  }
  async function seedLocalWork(page) {
    return page.evaluate(async ({ fixture }) => {
      const db = await import('/src/db.ts')
      await db.putCard(fixture)
      await db.putSettings({ direction: 'en-de', sessionSize: 10, tier: 2 })
      localStorage.setItem('german-flashcards.github', 'synthetic-legacy-token-sentinel')
      return (await import('/src/study-lock.ts')).captureStudyLock().dbName
    }, { fixture: { ...card('sign-out-card'), srs: srs() } })
  }
  async function snapshot(page, dbName) {
    return page.evaluate(async ({ dbName, authKey, importedKey }) => {
      const request = indexedDB.open(dbName)
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const read = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const tx = db.transaction(['cards', 'settings'], 'readonly')
      const [cards, settings] = await Promise.all([
        read(tx.objectStore('cards').getAll()), read(tx.objectStore('settings').getAll()),
      ])
      db.close()
      const preferences = Object.fromEntries(Object.entries(localStorage)
        .filter(([key]) => key !== authKey && key !== importedKey))
      return { cards, settings, preferences }
    }, { dbName, authKey, importedKey })
  }
  async function assertSignedOut(page) {
    await page.waitForFunction((key) => !localStorage.getItem(key), authKey)
    await page.waitForFunction(() => document.getElementById('sign-out-account')?.hidden)
    assert.equal(await page.evaluate(async () => (await import('/src/study-lock.ts')).captureStudyLock().uid), null)
    assert.equal(await page.locator('#google-sign-in').isVisible(), true, 'sign-out restores the sign-in action')
    assert.equal(await page.locator('#google-session').isVisible(), false)
  }
  async function assertGuardedSession(page) {
    assert.equal(await page.locator('#google-sign-in').isVisible(), false, 'authenticated users must not see Continue with Google')
    assert.equal(await page.locator('#google-session').isVisible(), true)
    assert.equal(await page.locator('#google-session').textContent(), 'Signed in to Google')
    assert.equal(await page.locator('#sign-out-account').isVisible(), true)
    assert.match(await page.locator('#auth-error').textContent(), /waiting for its verified import/)
  }

  // The issue's exact path: a fresh welcome, Google login, import guard, sign-out.
  const fresh = await newPage()
  await fresh.waitForSelector('#guest-study')
  const emptyDevice = await fresh.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { dbName } = (await import('/src/study-lock.ts')).captureStudyLock()
    const decks = await db.getDecks()
    return { decks: decks.length, hasWork: await db.localDatabaseHasWork(dbName) }
  })
  assert.deepEqual(emptyDevice, { decks: 1, hasWork: false },
    'deck metadata alone must not skip welcome or offer a device-data copy')
  assert.equal(await fresh.locator('#sign-out-account').isVisible(), false)
  assert.equal(await fresh.locator('#google-session').isVisible(), false)
  await fresh.click('#google-sign-in')
  await fresh.waitForFunction(() => document.getElementById('auth-error')?.textContent.includes('waiting for its verified import'))
  await assertGuardedSession(fresh)
  const calls = await fresh.evaluate(() => ({ signIn: window.signInCalls, provision: window.provisionCalls }))
  await fresh.evaluate(() => document.getElementById('google-sign-in').click())
  assert.deepEqual(await fresh.evaluate(() => ({ signIn: window.signInCalls, provision: window.provisionCalls })), calls,
    'a stale sign-in click must not open Google or retry the import guard')
  const guestDb = await seedLocalWork(fresh)
  const before = await snapshot(fresh, guestDb)
  assert(before.settings[0].localRevision > before.settings[0].acknowledgedRevision)
  await fresh.click('#sign-out-account')
  await assertSignedOut(fresh)
  assert.equal(await fresh.locator('[id^="choice-"]').count(), 0, 'guest changes must not prompt about an account upload')
  assert.deepEqual(await snapshot(fresh, guestDb), before, 'welcome sign-out preserves local cards, settings, and preferences')
  assert.equal(await fresh.locator('#auth-error').textContent(), '')
  await fresh.click('#guest-study')
  await fresh.waitForSelector('[data-due-count]')

  // A restored, still-guarded session must also expose sign-out and allow retry.
  const restored = await newPage(true)
  await restored.waitForSelector('#sign-out-account')
  await assertGuardedSession(restored)
  await restored.evaluate(() => { window.failSignOut = true })
  await restored.click('#sign-out-account')
  await restored.waitForFunction(() => document.getElementById('auth-error')?.textContent.includes('Google sign-out failed'))
  assert.equal(await restored.locator('#sign-out-account').isEnabled(), true)
  assert.equal(await restored.locator('#google-sign-in').isVisible(), false)
  assert.equal(await restored.locator('#google-session').isVisible(), true)
  assert.equal(await restored.evaluate((key) => localStorage.getItem(key), authKey), '1')
  await restored.evaluate(() => { window.failSignOut = false })
  await restored.click('#sign-out-account')
  await assertSignedOut(restored)

  // Choosing local study keeps the Google session; Settings must still sign out.
  const settings = await newPage(true)
  await settings.waitForSelector('#guest-study')
  await settings.click('#guest-study')
  await settings.waitForSelector('[data-due-count]')
  const settingsDb = await seedLocalWork(settings)
  await settings.goto('http://127.0.0.1:4181/#/settings')
  await settings.waitForSelector('#sign-out-account')
  await assertGuardedSession(settings)
  assert.equal(await settings.locator('#tier-chips, #dir, #session-size, #session-chips, #session-custom, #type-chips').count(), 0)
  assert.equal(await settings.locator('#app-version').isVisible(), true)
  assert.equal(await settings.locator('#sw-status').isVisible(), true)
  assert.match(await settings.locator('#main').textContent(), /Install/)
  assert.match(await settings.locator('#main').textContent(), /SM-2 with Again/)
  const settingsBefore = await snapshot(settings, settingsDb)
  await settings.click('#sign-out-account')
  await assertSignedOut(settings)
  assert.deepEqual(await snapshot(settings, settingsDb), settingsBefore, 'settings sign-out preserves local study data')

  // Popup cancellation leaves a useful sign-in action; its next attempt reaches
  // the guarded state, and signing out permits another Google sign-in.
  const cancelled = await newPage()
  await cancelled.waitForSelector('#guest-study')
  await cancelled.evaluate(() => { window.failSignIn = true })
  await cancelled.click('#google-sign-in')
  await cancelled.waitForFunction(() => document.getElementById('auth-error')?.textContent.includes('auth/popup-closed-by-user'))
  assert.equal(await cancelled.locator('#google-sign-in').isVisible(), true)
  assert.equal(await cancelled.locator('#google-sign-in').isEnabled(), true)
  assert.equal(await cancelled.locator('#google-sign-in').textContent(), 'Continue with Google')
  assert.equal(await cancelled.locator('#google-session').isVisible(), false)
  assert.equal(await cancelled.locator('#sign-out-account').isVisible(), false)
  await cancelled.evaluate(() => { window.failSignIn = false })
  await cancelled.click('#google-sign-in')
  await cancelled.waitForFunction(() => document.getElementById('auth-error')?.textContent.includes('waiting for its verified import'))
  await assertGuardedSession(cancelled)
  await cancelled.click('#sign-out-account')
  await assertSignedOut(cancelled)
  await cancelled.click('#google-sign-in')
  await cancelled.waitForFunction(() => document.getElementById('auth-error')?.textContent.includes('waiting for its verified import'))
  await assertGuardedSession(cancelled)

  // A verified import still releases welcome and binds the account normally.
  const verified = await newPage(false, true, true)
  await verified.evaluate(async () => {
    document.body.innerHTML = '<main id="main"></main>'
    const cloud = await import('/src/cloud-on.ts')
    const hooks = { setTabs() {}, toast() {}, ensureSeed: async () => 0, onIdentityChanged() {} }
    void cloud.prepareAccount(hooks).then(() => {
      document.getElementById('main').innerHTML = cloud.accountPanelHtml()
      cloud.bindAccountPanel(hooks)
    })
  })
  await verified.waitForSelector('#google-sign-in')
  await verified.click('#google-sign-in')
  await verified.waitForSelector('#sync-now-account')
  assert.equal(await verified.locator('#google-sign-in').count(), 0)
  assert.equal(await verified.evaluate(async () => (await import('/src/study-lock.ts')).captureStudyLock().uid), 'synthetic-user')

  // Ordinary account sign-out must retain its pending-change confirmation.
  const account = await newPage(true, true, true)
  await account.evaluate(async () => {
    document.body.innerHTML = '<main id="main"></main>'
    const cloud = await import('/src/cloud-on.ts')
    function render() {
      document.getElementById('main').innerHTML = cloud.accountPanelHtml()
      cloud.bindAccountPanel(hooks)
    }
    const hooks = { setTabs() {}, toast() {}, ensureSeed: async () => 0, onIdentityChanged: render }
    await cloud.prepareAccount(hooks)
    render()
  })
  const accountDb = await seedLocalWork(account)
  const accountBefore = await snapshot(account, accountDb)
  await account.click('#sign-out-account')
  await account.waitForSelector('#choice-stay')
  await account.click('#choice-stay')
  await account.waitForSelector('#sign-out-account')
  assert.equal(await account.evaluate((key) => localStorage.getItem(key), authKey), '1')
  await account.click('#sign-out-account')
  await account.waitForSelector('#choice-sign-out')
  await account.click('#choice-sign-out')
  await account.waitForFunction((key) => !localStorage.getItem(key), authKey)
  assert.deepEqual(await snapshot(account, accountDb), accountBefore, 'confirmed account sign-out preserves pending account data')

  // Caught-up review uses real IndexedDB and the regular grading UI (#56).
  const ahead = await newPage()
  await ahead.click('#guest-study')
  await ahead.waitForSelector('#start')
  await ahead.evaluate(async ({ fixture }) => {
    const db = await import('/src/db.ts')
    const day = 86400000
    const now = Date.now()
    const seeds = (await db.getAllCards()).map((c) => ({ ...c, tags: [], article: 'none', srs: { ...c.srs, due: now + 50 * day } }))
    const future = (id, de, days) => ({ ...fixture, id, de, article: 'none', tags: ['verb'], tier: 1,
      srs: { ...fixture.srs, due: now + days * day } })
    await db.putCards([...seeds, future('ahead-later', 'später', 3), future('ahead-first', 'früh', 1), future('ahead-next', 'bald', 2),
      { ...future('outside-tier', 'außerhalb', 1), tier: 2, srs: { ...fixture.srs, due: now - 1 } },
      { ...future('outside-type', 'Haus', 1), article: 'das', tags: ['noun'], srs: { ...fixture.srs, due: now - 1 } }])
    await db.putSettings({ tier: 1, wordTypes: ['verb'], sessionSize: 2, direction: 'de-en' })
  }, { fixture: { ...card('ahead'), srs: srs() } })
  await ahead.click('[data-tab="home"]')
  await ahead.reload()
  await ahead.waitForSelector('[data-tier="1"].is-on')
  await ahead.click('[data-tab="home"]')
  await ahead.waitForFunction(() => document.querySelector('#start')?.textContent === 'Review 2 cards ahead')
  assert.equal(await ahead.locator('[data-due-count]').textContent(), '0')
  assert.equal(await ahead.locator('#start').isEnabled(), true)
  assert.equal(await ahead.locator('#start').getAttribute('data-session-count'), '2')
  const beforeAhead = await ahead.evaluate(async () => (await import('/src/db.ts')).getCard('ahead-first'))
  await ahead.click('#start')
  await ahead.waitForFunction(() => document.querySelector('.front .word')?.textContent === 'früh')
  assert.match(await ahead.locator('.review-meta').textContent(), /Review ahead/)
  assert.equal(await ahead.locator('[data-remaining]').textContent(), '2')
  await ahead.click('#card')
  await ahead.click('[data-grade="good"]')
  await ahead.waitForFunction(() => document.querySelector('.front .word')?.textContent === 'bald')
  const afterAhead = await ahead.evaluate(async () => (await import('/src/db.ts')).getCard('ahead-first'))
  assert.equal(afterAhead.srs.reps, beforeAhead.srs.reps + 1, 'early grading saves through the ordinary SRS path')
  assert(afterAhead.srs.due > beforeAhead.srs.due)
  assert(afterAhead.srs.updated_at > beforeAhead.srs.updated_at)
  assert.equal(afterAhead.updated_at, beforeAhead.updated_at, 'a review does not change vocabulary timestamps')
  await ahead.click('#card')
  await ahead.click('[data-grade="good"]')
  await ahead.waitForSelector('#home')
  assert.equal(await ahead.locator('.due-label').textContent(), 'Review ahead complete')
  await ahead.click('#home')
  await ahead.waitForSelector('#start')
  await ahead.reload()
  await ahead.waitForSelector('#start')
  assert.equal(await ahead.locator('[data-due-count]').textContent(), '0')
  assert.deepEqual(await ahead.evaluate(async () => (await import('/src/db.ts')).getCard('ahead-first')), afterAhead,
    'early progress persists across a reload')

  await ahead.click('#session-custom')
  assert.equal(await ahead.locator('#session-number').inputValue(), '5')
  await ahead.click('#session-cancel')
  assert.equal(await ahead.locator('#session-custom').textContent(), '2', 'Cancel preserves a legacy size outside the five-card steps')
  await ahead.click('#session-custom')
  await ahead.selectOption('#session-number', '5')
  await ahead.locator('.session-dialog [type="submit"]').click()
  await ahead.waitForFunction(() => document.getElementById('start')?.dataset.sessionCount === '3')
  await ahead.click('[data-session="0"]')
  await ahead.waitForFunction(() => document.getElementById('start')?.dataset.sessionCount === '3')
  await ahead.evaluate(() => { location.hash = '/review' })
  await ahead.waitForFunction(() => document.querySelector('.front .word')?.textContent === 'später')
  assert.equal(await ahead.locator('[data-remaining]').textContent(), '3', 'All and direct navigation use the future queue')
  await ahead.click('#back')
  await ahead.waitForSelector('#start')

  // Due cards are never padded with future cards, even with All selected.
  await ahead.click('[data-tab="home"]')
  await ahead.click('[data-word-type="all"]')
  await ahead.waitForSelector('[data-word-type="all"][aria-pressed="true"]')
  await ahead.click('[data-tab="home"]')
  await ahead.waitForFunction(() => document.querySelector('[data-due-count]')?.textContent === '1')
  assert.equal(await ahead.locator('#start').getAttribute('data-session-count'), '1')
  await ahead.click('#start')
  await ahead.waitForFunction(() => document.querySelector('.front .word')?.textContent === 'das Haus')
  assert.equal(await ahead.locator('[data-remaining]').textContent(), '1')
  assert.doesNotMatch(await ahead.locator('.review-meta').textContent(), /Review ahead/)
  await ahead.click('#back')
  await ahead.waitForSelector('#start')

  // A tier with genuinely no cards still cannot start, including direct navigation.
  await ahead.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.putCards((await db.getAllCards()).map((c) => ({ ...c, tier: 3 })))
  })
  await ahead.click('[data-tab="home"]')
  await ahead.reload()
  await ahead.waitForSelector('[data-tier="1"].is-on')
  await ahead.click('[data-tab="home"]')
  await ahead.waitForFunction(() => document.getElementById('start')?.disabled)
  assert.equal(await ahead.locator('#start').getAttribute('data-session-count'), '0')
  await ahead.evaluate(() => { location.hash = '/review' })
  await ahead.waitForFunction(() => location.hash === '#/' && document.getElementById('start')?.disabled)

  await testStreakUI(newPage)
  assert.deepEqual(pageErrors, [], 'no unhandled browser errors')
  assert.deepEqual(externalRequests, [], 'the test must not access live Firebase or Google')
  console.log('account-ui: account guards/sign-out, data preservation, review ahead, due-only sessions, caps/All, empty tier: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

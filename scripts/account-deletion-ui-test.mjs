// Settings → Delete account in the real app with synthetic Google sessions. Auth, provisioning,
// sync and the Firestore deletion are replaced; account-deletion-emulator-test.mjs covers the
// real deletion against the rules. No live account is accessed.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { card, srs } from './migration-fixtures.mjs'

const UID = 'synthetic-user'
const authKey = 'account-deletion-test.user'
const redirectKey = 'account-deletion-test.redirect'
const markerKey = 'german-flashcards.account-deletion'
const authModule = '\0account-deletion-auth'
const cacheDir = mkdtempSync(join(tmpdir(), 'account-deletion-ui-test-'))
Object.assign(process.env, {
  BASE: '/', VITE_SYNC_BACKEND: 'firebase', VITE_REHEARSAL_PREVIEW: '',
  VITE_FIREBASE_API_KEY: 'synthetic-key', VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
  VITE_FIREBASE_PROJECT_ID: 'demo-account-deletion', VITE_FIREBASE_APP_ID: 'synthetic-app',
  VITE_FIREBASE_AUTH_EMULATOR: '', VITE_FIREBASE_FIRESTORE_EMULATOR: '',
})

const fakeAuth = `
  const key = ${JSON.stringify(authKey)};
  const redirectKey = ${JSON.stringify(redirectKey)};
  const user = { uid: ${JSON.stringify(UID)}, displayName: 'Test account' };
  const auth = { currentUser: localStorage.getItem(key) ? user : null };
  const observers = new Set();
  const count = (name) => { window[name] = (window[name] || 0) + 1 };
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
  export async function signInWithPopup() { localStorage.setItem(key, '1'); auth.currentUser = user; emit(); }
  export async function signOut() { count('signOutCalls'); localStorage.removeItem(key); auth.currentUser = null; emit(); }
  export function connectAuthEmulator() { throw new Error('Unexpected emulator connection'); }
  export async function getRedirectResult() {
    const back = localStorage.getItem(redirectKey);
    localStorage.removeItem(redirectKey);
    return back === 'signed-in' ? { user } : null;
  }
  export async function reauthenticateWithPopup(target) {
    count('reauthCalls');
    if (target !== user) throw new Error('Re-authenticated a different user');
    if (window.reauthHold) await window.reauthHold;
    if (window.reauthFail) throw Object.assign(new Error('Synthetic re-authentication failure'), { code: window.reauthFail });
  }
  export async function reauthenticateWithRedirect() { count('redirectCalls'); }
  export async function deleteUser(target) {
    count('deleteUserCalls');
    if (target !== user) throw new Error('Deleted a different user');
    if (window.deleteUserFail) throw Object.assign(new Error('Synthetic delete failure'), { code: window.deleteUserFail });
    localStorage.removeItem(key); auth.currentUser = null; emit();
  }
`

let server
let browser
const pageErrors = []
const externalRequests = []
try {
  server = await createServer({
    cacheDir,
    server: { host: '127.0.0.1', port: 4187, strictPort: true },
    optimizeDeps: { include: ['firebase/app', 'firebase/firestore'], exclude: ['firebase/auth'], noDiscovery: true },
    plugins: [{
      name: 'synthetic-account-deletion', enforce: 'pre',
      resolveId(id) { if (id === 'firebase/auth') return authModule },
      load(id) {
        if (id === authModule) return fakeAuth
        if (id.endsWith('/src/cloud-sync.ts')) return `
          import * as real from '/src/cloud-sync.ts?real';
          export const cloudTransport = real.cloudTransport;
          export const sendFeedback = real.sendFeedback;
          export async function cloudSyncPass() { return 'synced' }
        `
        if (id.endsWith('/src/provision.ts')) return `
          export async function provisionAccount(_db, uid) {
            window.provisionCalls = (window.provisionCalls || 0) + 1;
            return { deckId: uid, personal: true, created: false };
          }
        `
        // The marker bookkeeping is real; the page scripts what the Firestore deletion does.
        if (id.endsWith('/src/account-deletion.ts')) return `
          export * from '/src/account-deletion.ts?real';
          export async function deleteAccountData(_db, uid, options) {
            window.deletionRuns = [...(window.deletionRuns || []), { uid, budget: options.budget, known: options.knownDeckIds }];
            const outcome = window.deletionOutcome || { state: 'done', deleted: 3 };
            if (outcome.error) throw Object.assign(new Error('Synthetic deletion failure'), { code: outcome.error });
            if (outcome.deleted) options.onBatch?.(outcome.deleted);
            return outcome;
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    externalRequests.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const marker = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), markerKey)
  const calls = () => page.evaluate(() => ({
    reauth: window.reauthCalls || 0, redirect: window.redirectCalls || 0, deleteUser: window.deleteUserCalls || 0,
    runs: (window.deletionRuns || []).length, provision: window.provisionCalls || 0,
  }))
  const accountDbExists = () => page.evaluate(async (uid) => (await indexedDB.databases()).some((db) => db.name === `german-flashcards:account:${uid}`), UID)
  async function openSettings() {
    await page.evaluate(() => { location.hash = '#/settings' })
    await page.waitForSelector('#app-version')
  }
  async function signIn() {
    await openSettings()
    await page.click('#google-sign-in')
    await answerCopyPrompt()
    await page.waitForSelector('#delete-account')
  }
  // The device's guest cards prompt a copy on each new sign-in; these tests never copy.
  async function answerCopyPrompt() {
    await page.waitForSelector('#choice-not-now, #delete-account')
    if (await page.locator('#choice-not-now').count()) {
      await page.click('#choice-not-now')
      await openSettings()
    }
  }
  async function openConfirm() {
    await page.click('#delete-account')
    await page.waitForSelector('#delete-confirm')
  }
  async function confirmDelete() {
    await openConfirm()
    await page.fill('#delete-confirm', 'DELETE')
    await page.click('#delete-account-confirm')
  }

  // Signed out: no Delete account.
  await page.goto('http://127.0.0.1:4187/')
  await page.click('#guest-study')
  await page.waitForSelector('[data-due-count]')
  await openSettings()
  assert.equal(await page.locator('#delete-account').count(), 0, 'signed-out settings have no Delete account')

  // Signed in: a danger card, a typed confirmation, and Cancel deletes nothing.
  await signIn()
  await page.evaluate(async ({ fixture, uid }) => {
    const db = await import('/src/db.ts')
    await db.putCard(fixture)
    localStorage.setItem('german-flashcards.copy-choice', JSON.stringify({ [uid]: { 'german-flashcards': 'skip' }, other: { 'german-flashcards': 'skip' } }))
  }, { fixture: { ...card('deletion-card'), srs: srs() }, uid: UID })
  assert.equal(await accountDbExists(), true)
  assert.equal(await page.locator('#delete-account-setting.danger-zone').isVisible(), true, 'Delete account sits in a danger card')
  await openConfirm()
  const explained = await page.locator('#main').textContent()
  for (const text of [/review progress/, /decks you created/, /sign-in account/, /this device/, /feedback you sent/, /can’t be undone/]) {
    assert.match(explained, text, `the confirmation explains ${text}`)
  }
  assert.equal(await page.locator('#delete-account-confirm').isDisabled(), true)
  await page.fill('#delete-confirm', 'delete')
  assert.equal(await page.locator('#delete-account-confirm').isDisabled(), true, 'lowercase does not confirm')
  await page.fill('#delete-confirm', 'DELETE')
  assert.equal(await page.locator('#delete-account-confirm').isEnabled(), true)
  await page.click('#delete-account-cancel')
  await page.waitForSelector('#delete-account')
  assert.deepEqual(await calls(), { reauth: 0, redirect: 0, deleteUser: 0, runs: 0, provision: 1 })

  // Closing the Google re-authentication deletes nothing.
  await page.evaluate(() => { window.reauthFail = 'auth/popup-closed-by-user' })
  await confirmDelete()
  await page.waitForFunction(() => document.getElementById('delete-status')?.textContent.includes('Nothing was deleted'))
  assert.equal((await calls()).runs, 0)
  assert.equal(await marker(), null, 'a cancelled confirmation leaves no marker')
  await page.click('#delete-account-cancel')

  // Cancel while Google is still open: a confirmation that succeeds afterwards deletes nothing.
  await page.evaluate(() => {
    window.reauthFail = ''
    window.reauthHold = new Promise((resolve) => { window.releaseReauth = resolve })
  })
  await page.waitForSelector('#delete-account')
  await confirmDelete()
  await page.waitForFunction(() => document.getElementById('delete-status')?.textContent.includes('Confirm with Google'))
  await page.click('#delete-account-cancel')
  await page.waitForSelector('#delete-account')
  await page.evaluate(() => { window.reauthHold = null; window.releaseReauth() })
  await page.waitForTimeout(300)
  assert.equal((await calls()).runs, 0, 'a confirmation finishing after Cancel deletes nothing')
  assert.equal((await calls()).deleteUser, 0)
  assert.equal(await marker(), null, 'a cancelled confirmation leaves no marker')
  assert.equal(await page.locator('#delete-account').isVisible(), true, 'still signed in on Settings')

  // The daily budget stops the run: signed out, told when it continues, marker kept.
  await page.evaluate(() => { window.reauthFail = ''; window.deletionOutcome = { state: 'budget', deleted: 10000 } })
  await page.waitForSelector('#delete-account')
  await confirmDelete()
  await page.waitForSelector('#deletion-notice')
  assert.match(await page.locator('#deletion-notice').textContent(), /midnight Pacific/)
  assert.equal(await page.locator('#google-sign-in').isVisible(), true, 'the stopped run signs out')
  assert.equal((await calls()).deleteUser, 0, 'the Auth user stays while data remains')
  const stopped = await marker()
  assert.equal(stopped.uid, UID)
  assert.equal(stopped.phase, 'data')
  assert.equal(stopped.deletedToday, 10000)
  assert.equal(await accountDbExists(), true, 'the device copy stays until the account is gone')
  const run = await page.evaluate(() => window.deletionRuns[0])
  assert.equal(run.uid, UID)
  assert.equal(run.budget, 10000)

  // The next sign-in resumes without asking again, with today's budget already spent.
  await page.evaluate(() => { window.deletionOutcome = { state: 'budget', deleted: 0 } })
  const before = await calls()
  await page.click('#google-sign-in')
  await page.waitForFunction((n) => (window.deletionRuns || []).length === n + 1, before.runs)
  await page.waitForSelector('#deletion-notice')
  assert.equal(await page.evaluate(() => window.deletionRuns.at(-1).budget), 0, 'the same Pacific day has no budget left')
  assert.equal((await calls()).provision, before.provision, 'a resumed deletion does not provision the account again')

  // A new day: the resumed run finishes, then the Auth user, then this device's copy.
  await page.evaluate((k) => {
    const m = JSON.parse(localStorage.getItem(k))
    localStorage.setItem(k, JSON.stringify({ ...m, day: '2000-01-01' }))
  }, markerKey)
  await page.evaluate(() => { window.deletionOutcome = { state: 'done', deleted: 42 } })
  await page.click('#google-sign-in')
  await page.waitForFunction(() => document.getElementById('deletion-notice')?.textContent.includes('Your account was deleted'))
  assert.equal(await page.evaluate(() => window.deletionRuns.at(-1).budget), 10000, 'a new Pacific day has a fresh budget')
  assert.equal((await calls()).deleteUser, 1)
  assert.equal(await marker(), null, 'a finished deletion clears its marker')
  assert.equal(await accountDbExists(), false, 'the account database is deleted')
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('german-flashcards.copy-choice'))),
    { other: { 'german-flashcards': 'skip' } }, 'only the deleted account\'s copy answers are forgotten')
  assert.equal(await page.locator('#google-sign-in').isVisible(), true, 'the user ends signed out')
  assert.equal(await page.locator('#delete-account').count(), 0)

  // A stale sign-in needs a fresh Google confirmation before the Auth user can go.
  await page.evaluate(() => { window.deletionOutcome = undefined; window.deleteUserFail = 'auth/requires-recent-login' })
  await signIn()
  await confirmDelete()
  await page.waitForSelector('#delete-account-reauth')
  assert.equal((await marker()).phase, 'auth', 'the marker records that only the Auth user is left')
  await page.evaluate(() => { window.deleteUserFail = '' })
  const runs = (await calls()).runs
  // Finishing later while Google is still open: a confirmation that succeeds afterwards does not resume.
  await page.evaluate(() => { window.reauthHold = new Promise((resolve) => { window.releaseReauth = resolve }) })
  await page.click('#delete-account-reauth')
  await page.click('#delete-account-later')
  await page.waitForSelector('#google-sign-in')
  await page.evaluate(() => { window.reauthHold = null; window.releaseReauth() })
  await page.waitForTimeout(300)
  assert.equal((await calls()).deleteUser, 2, 'a confirmation finishing after "finish later" does not delete the Auth user')
  assert.equal((await calls()).runs, runs)
  assert.equal((await marker()).phase, 'auth', 'the marker still resumes at the next sign-in')
  await page.evaluate(() => { window.deleteUserFail = 'auth/requires-recent-login' })
  await page.click('#google-sign-in')
  await page.waitForSelector('#delete-account-reauth')
  await page.evaluate(() => { window.deleteUserFail = '' })
  await page.click('#delete-account-reauth')
  await page.waitForFunction(() => document.getElementById('deletion-notice')?.textContent.includes('Your account was deleted'))
  assert.equal((await calls()).runs, runs, 'confirmed-gone data is not deleted again')
  assert.equal(await marker(), null)

  // A blocked popup falls back to a redirect; returning without signing in cancels.
  await page.evaluate(() => { window.reauthFail = 'auth/popup-blocked' })
  await signIn()
  await confirmDelete()
  await page.waitForFunction(() => window.redirectCalls === 1)
  assert.equal((await marker()).phase, 'confirm')
  await page.reload()
  await openSettings()
  await page.waitForSelector('#deletion-notice')
  assert.match(await page.locator('#deletion-notice').textContent(), /cancelled/)
  assert.equal(await marker(), null)
  assert.equal(await page.evaluate(() => window.deletionRuns), undefined, 'a cancelled redirect deletes nothing')

  // Returning from a completed redirect continues the deletion.
  await page.evaluate(() => { window.reauthFail = 'auth/popup-blocked' })
  await page.waitForSelector('#delete-account')
  await confirmDelete()
  await page.waitForFunction(() => window.redirectCalls === 1)
  await page.evaluate((k) => localStorage.setItem(k, 'signed-in'), redirectKey)
  await page.reload()
  await page.waitForFunction(() => window.deleteUserCalls === 1)
  assert.equal(await page.evaluate(() => window.deletionRuns.length), 1)
  await openSettings()
  await page.waitForFunction(() => document.getElementById('deletion-notice')?.textContent.includes('Your account was deleted'))
  assert.equal(await marker(), null)

  assert.deepEqual(pageErrors, [], 'no unhandled browser errors')
  assert.deepEqual(externalRequests, [], 'the test must not access live Firebase or Google')
  console.log('account-deletion-ui: danger card, typed confirmation, re-authentication, budget stop/resume, redirect, device cleanup: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

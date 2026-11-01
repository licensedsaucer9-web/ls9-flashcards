import { getApps, initializeApp } from 'firebase/app'
import {
  browserLocalPersistence,
  connectAuthEmulator,
  deleteUser,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithPopup,
  reauthenticateWithRedirect,
  setPersistence,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth'
import {
  connectFirestoreEmulator,
  initializeFirestore,
  memoryLocalCache,
  type Firestore,
} from 'firebase/firestore'
import type { AccountHooks } from './account-hooks.ts'
import {
  clearDeletionMarker, deleteAccountData, readDeletionMarker, remainingBudget, startDeletionMarker, writeDeletionMarker,
  type DeletionMarker,
} from './account-deletion.ts'
import { copyAlreadyDecided, forgetCopyDecisions, rememberCopyDecision, sessionCopyMode, type CopyDecision } from './copy-choice.ts'
import { includeGuestVocabulary } from './guest-copy.ts'
import { setCloudFirestore } from './cloud-handle.ts'
import { publicFirebaseWeb } from './firebase-web.ts'
import { acknowledgePending, copyGuestDatabase, recordAssignedDeck, getSettings, importLegacyData, localDatabaseHasWork } from './db.ts'
import { esc } from './dom.ts'
import { provisionAccount } from './provision.ts'
import { cancelPopupWhenPageReturns, deckOpenFailure, QUOTA_DECK_MESSAGE, quotaCode, retryableDeckOpen } from './sign-in-flow.ts'
import { bindStudyDatabase, captureStudyLock } from './study-lock.ts'
import type { NeedsFixing } from './record-sync.ts'
import { forgetNeedsFixing, getSyncStatus, onSyncStatus, syncNow } from './sync.ts'
import { accountDatabaseName, currentLocalDatabaseName } from './user.ts'
import { rehearsalNote, rehearsalPreview, storagePrefix } from './rehearsal.ts'
import type { LocalDeck } from './types.ts'

const GUEST_KEY = `${storagePrefix}.device-study`

export const accountSignIn: boolean = true

let hooks: AccountHooks | null = null
let auth: Auth | null = null
let firestore: Firestore | null = null
let booted = false
let ticketId = 0
let welcomeRelease: (() => void) | null = null
let choiceRelease: ((id: string) => void) | null = null
let label = 'Signed in'
let pendingError = ''
let popupBusy = false
let popupStartedAt = 0
let popupGeneration = 0
let recoverPopup: (() => void) | null = null
let freshPersonalDeck = false
let deckOpenFailed = false
let deleting = false
/** Bumped when a deletion screen is left, so a Google confirmation finishing later deletes nothing. */
let reauthAttempt = 0
/** Outcome of an account deletion. Survives the sign-out that follows, unlike pendingError. */
let deletionNotice = ''
const prompted = new Set<string>()

function iosHomeScreen(): boolean {
  return typeof navigator !== 'undefined'
    && 'standalone' in navigator
    && (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer = 0
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(Object.assign(new Error('The deck did not open in time'), { code: 'deadline-exceeded' }))
    }, ms)
  })
  return Promise.race([work, timeout]).finally(() => window.clearTimeout(timer))
}

export function takeFreshPersonalDeck(): boolean {
  const fresh = freshPersonalDeck
  freshPersonalDeck = false
  return fresh
}

function showOpeningDeck(): void {
  deckOpenFailed = false
  document.getElementById('open-deck-retry')?.remove()
  const session = document.getElementById('google-session')
  if (session) {
    session.hidden = false
    session.textContent = 'Opening your deck…'
  }
  const error = document.getElementById('auth-error')
  if (error) error.textContent = ''
  pendingError = ''
}

function bindDeckRetry(): void {
  const button = document.getElementById('open-deck-retry')
  button?.addEventListener('click', () => {
    const user = auth?.currentUser
    if (!user) return
    ;(button as HTMLButtonElement).disabled = true
    void adoptUser(user)
  })
}

function showDeckOpenFailure(error: unknown): void {
  const code = authCode(error)
  const message = deckOpenFailure(code)
  deckOpenFailed = true
  pendingError = message
  signedInNote()
  const el = document.getElementById('auth-error')
  if (el) el.textContent = message
  else hooks?.toast(message)
  if (!document.getElementById('open-deck-retry')) {
    const stack = document.querySelector('#main .stack')
    if (stack && auth?.currentUser) {
      const button = document.createElement('button')
      button.id = 'open-deck-retry'
      button.className = 'primary'
      button.type = 'button'
      button.textContent = 'Open my deck'
      stack.prepend(button)
      bindDeckRetry()
    }
  }
}

async function openProvisionedAccount(user: User): Promise<{ deckId: string; personal: boolean; created: boolean }> {
  if (!firestore) throw Object.assign(new Error('missing config'), { code: 'missing-config' })
  const options = { requiredLegacyDeckId: rehearsalPreview ? 'legacy-german' : undefined }
  const first = provisionAccount(firestore, user.uid, options)
  try {
    return await withTimeout(first, 12000)
  } catch (error) {
    if (!retryableDeckOpen(authCode(error))) throw error
    // A timeout means the same create may still commit. Wait for that call so
    // a brand-new deck is still recognized and can be painted from the seed.
    if (authCode(error) === 'deadline-exceeded') return await withTimeout(first, 8000)
    return await withTimeout(provisionAccount(firestore, user.uid, options), 12000)
  }
}

function signedInNote(): void {
  const session = document.getElementById('google-session')
  if (session) session.textContent = 'Signed in to Google'
}

function authCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code)
  return 'unknown-error'
}

function showAuthError(error: unknown): void {
  const code = authCode(error)
  const message = code === 'missing-config'
    ? 'Google sign-in is not configured on this build. Cards on this device were left as they are.'
    : code === 'rehearsal/import-required'
      ? 'This test account is waiting for its verified import. You can study on this device until then.'
      : `Sign-in stopped (${code}). Cards on this device were left as they are.`
  pendingError = message
  signedInNote()
  const el = document.getElementById('auth-error')
  if (el) el.textContent = message
  else hooks?.toast(message)
}

function updateGoogleSessionControls(): void {
  const authenticated = Boolean(auth?.currentUser)
  const signInButton = document.getElementById('google-sign-in')
  if (signInButton) signInButton.hidden = authenticated
  const sessionNote = document.getElementById('google-session')
  if (sessionNote) sessionNote.hidden = !authenticated
  const signOutButton = document.getElementById('sign-out-account')
  if (signOutButton) signOutButton.hidden = !authenticated
}

function cancelChoice(id: string): void {
  const release = choiceRelease
  choiceRelease = null
  release?.(id)
}

function presentChoice(message: string, buttons: Array<[string, string, string]>): Promise<string> {
  const main = document.querySelector('#main')
  if (!main) return Promise.resolve('stay')
  const actions = buttons
    .map(([id, text, kind]) => `<button class="${kind}" type="button" id="choice-${id}">${esc(text)}</button>`)
    .join('')
  main.innerHTML = `
    <section class="screen">
      <header class="topbar"><h1>Account</h1></header>
      <div class="due-hero">
        <p class="due-label">${esc(message)}</p>
        <div class="stack">${actions}</div>
      </div>
    </section>
  `
  return new Promise((resolve) => {
    choiceRelease = resolve
    for (const [id] of buttons) {
      document.getElementById(`choice-${id}`)?.addEventListener('click', () => {
        choiceRelease = null
        resolve(id)
      })
    }
  })
}

async function askToCopy(personal: boolean): Promise<'skip' | 'progress' | 'vocabulary'> {
  hooks?.setTabs(false)
  const first = await presentChoice(
    personal
      ? 'Copy this device’s review progress and settings, including the French and Spanish decks, into this account? Word-list edits are copied too. Decks you created stay on this device. Not now leaves those cards on this device.'
      : 'Copy this device’s review progress and settings, including the French and Spanish decks, into this account? Decks you created stay on this device. Not now leaves those cards on this device.',
    [
      ['copy', 'Copy', 'primary'],
      ['not-now', 'Not now', 'secondary'],
    ],
  )
  if (first !== 'copy') return 'skip'
  if (includeGuestVocabulary(personal, false)) return 'vocabulary'
  const second = await presentChoice(
    'This account uses a shared deck. Copy this device’s word list too? Those edits can be published to everyone on that deck.',
    [
      ['words', 'Copy word list', 'primary'],
      ['progress', 'Progress only', 'secondary'],
    ],
  )
  if (second === 'words' && includeGuestVocabulary(false, true)) return 'vocabulary'
  if (second === 'progress') return 'progress'
  return 'skip'
}

async function applyCopy(
  guestName: string,
  mode: 'skip' | 'progress' | 'vocabulary',
  ticket: number,
): Promise<void> {
  if (!hooks) return
  if (mode === 'skip') return
  await copyGuestDatabase(guestName, mode)
  if (ticket !== ticketId) return
}

async function adoptGuest(): Promise<void> {
  const ticket = ++ticketId
  cancelChoice('not-now')
  prompted.clear()
  pendingError = ''
  const error = document.getElementById('auth-error')
  if (error) error.textContent = ''
  bindStudyDatabase({ uid: null, dbName: currentLocalDatabaseName() })
  if (ticket !== ticketId) return
  if (booted) hooks?.onIdentityChanged()
}

async function adoptUser(user: User): Promise<void> {
  popupGeneration += 1
  popupBusy = false
  recoverPopup = null
  const ticket = ++ticketId
  if (deleting) return
  const marker = readMarker()
  if (marker && marker.uid === user.uid && marker.phase !== 'confirm') {
    // An interrupted deletion continues before anything provisions the account again.
    await runAccountDeletion(user)
    return
  }
  showOpeningDeck()
  if (!firestore) {
    showAuthError({ code: 'missing-config' })
    return
  }
  let deckId = ''
  let personal = false
  let created = false
  let quotaReached = false
  try {
    const provisioned = await openProvisionedAccount(user)
    deckId = provisioned.deckId
    personal = provisioned.personal
    created = provisioned.created
  } catch (error) {
    if (ticket !== ticketId) return
    const code = authCode(error)
    if (code === 'rehearsal/import-required' || code === 'missing-config') {
      showAuthError(error)
      return
    }
    // Out of daily reads: an account this device has opened before keeps studying from its own copy.
    // Its deck assignment is already recorded there, and sync resumes after the reset.
    quotaReached = quotaCode(code) && await withTimeout(localDatabaseHasWork(accountDatabaseName(user.uid)), 4000).catch(() => false)
    if (ticket !== ticketId) return
    if (!quotaReached) {
      showDeckOpenFailure(error)
      return
    }
  }
  if (ticket !== ticketId) return
  label = user.displayName || user.email || 'Signed in'
  const dbName = accountDatabaseName(user.uid)
  const guestName = currentLocalDatabaseName()
  // The answer is kept per account and device database. Reopening must reach
  // study without asking again, and must not copy that database over the account.
  const choiceId = `${user.uid}\0${guestName}`
  const alreadyDecided = copyAlreadyDecided(localStorage, user.uid, guestName)
  let chosen: CopyDecision | null = null
  // A preassigned shared deck is a legacy migration. Named profiles are
  // recovered through the reviewed mapping, not the generic guest prompt.
  // A guest-database read that stalls must not leave the new account on the
  // welcome screen; that device's cards stay where they are.
  if (personal && !alreadyDecided && !prompted.has(choiceId)) {
    prompted.add(choiceId)
    try {
      if (await withTimeout(localDatabaseHasWork(guestName), 4000)) chosen = await askToCopy(personal)
    } catch {
      chosen = null
    }
  }
  if (ticket !== ticketId) return
  const mode = sessionCopyMode(alreadyDecided, chosen)
  bindStudyDatabase({ uid: user.uid, dbName })
  await recordAssignedDeck(deckId)
  if (ticket !== ticketId) return
  await applyCopy(guestName, mode, ticket)
  if (ticket !== ticketId) return
  if (chosen) rememberCopyDecision(localStorage, user.uid, guestName, chosen)
  freshPersonalDeck = created && personal
  pendingError = ''
  deckOpenFailed = false
  welcomeRelease?.()
  welcomeRelease = null
  if (quotaReached) hooks?.toast(QUOTA_DECK_MESSAGE)
  if (booted && hooks) {
    const paint = () => hooks?.onIdentityChanged()
    if (freshPersonalDeck) {
      freshPersonalDeck = false
      void hooks.ensureSeed().then(paint, paint)
    } else paint()
    void syncNow().catch(() => {
      /* Pending records stay on this account until the next try. */
    })
  }
}

function startGoogleSignIn(): void {
  if (!auth) {
    showAuthError({ code: 'missing-config' })
    return
  }
  if (auth.currentUser) return
  deletionNotice = ''
  if (popupBusy) {
    if (Date.now() - popupStartedAt < 800) return
    if (recoverPopup) recoverPopup()
    else if (!auth?.currentUser && Date.now() - popupStartedAt > 8000) {
      popupBusy = false
      showAuthError({ code: 'auth/popup-closed-by-user' })
      const stuck = document.getElementById('google-sign-in')
      if (stuck) stuck.textContent = 'Continue with Google'
    }
    return
  }
  const mine = ++popupGeneration
  popupBusy = true
  popupStartedAt = Date.now()
  const button = document.getElementById('google-sign-in')
  if (button) button.textContent = 'Opening Google sign-in…'
  const provider = new GoogleAuthProvider()
  const watcher = new AbortController()
  let backgroundAt = 0
  let grace = 0
  const recover = () => {
    if (!popupBusy || mine !== popupGeneration || auth?.currentUser) return
    window.clearTimeout(grace)
    watcher.abort()
    popupBusy = false
    recoverPopup = null
    showAuthError({ code: 'auth/popup-closed-by-user' })
    if (button) button.textContent = 'Continue with Google'
  }
  // Only the installed iPhone app lacks a popup window. Safari's Google sheet
  // backgrounds this page for the whole sign-in, so a return is not a cancel.
  if (cancelPopupWhenPageReturns(iosHomeScreen())) {
    recoverPopup = recover
    const markBackground = () => {
      if (!backgroundAt) backgroundAt = Date.now()
    }
    const markForeground = () => {
      if (!popupBusy || document.visibilityState === 'hidden' || !backgroundAt) return
      if (Date.now() - backgroundAt < 400) return
      window.clearTimeout(grace)
      grace = window.setTimeout(recover, 8000)
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') markBackground()
      else markForeground()
    }, { signal: watcher.signal })
    window.addEventListener('blur', markBackground, { signal: watcher.signal })
    window.addEventListener('focus', markForeground, { signal: watcher.signal })
    window.addEventListener('pageshow', markForeground, { signal: watcher.signal })
  }
  void signInWithPopup(auth, provider)
    .then(() => {
      if (mine !== popupGeneration) return
      pendingError = ''
    })
    .catch((error: unknown) => {
      if (!popupBusy) return
      const code = authCode(error)
      if (code === 'auth/popup-blocked' || code === 'auth/web-storage-unsupported') {
        pendingError = deckOpenFailure(code)
        const el = document.getElementById('auth-error')
        if (el) el.textContent = pendingError
        else hooks?.toast(pendingError)
        return
      }
      showAuthError(error)
    })
    .finally(() => {
      window.clearTimeout(grace)
      watcher.abort()
      popupBusy = false
      recoverPopup = null
      if (button && document.body.contains(button)) button.textContent = 'Continue with Google'
    })
}

function emulatorHost(value: string): string {
  return value.startsWith('http://') || value.startsWith('https://') ? value : `http://${value}`
}

function readConfig(): { apiKey: string; authDomain: string; projectId: string; appId: string } | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID
  const appId = import.meta.env.VITE_FIREBASE_APP_ID
  // A partial env is the emulator and must not fall through to production.
  if (apiKey || authDomain || projectId || appId) {
    if (!apiKey || !authDomain || !projectId || !appId) return null
    if (rehearsalPreview && projectId !== 'flashcards-ls9-auth-test') return null
    return { apiKey, authDomain, projectId, appId }
  }
  if (rehearsalPreview) return null
  return publicFirebaseWeb
}

async function initAccount(config: { apiKey: string; authDomain: string; projectId: string; appId: string }): Promise<void> {
  const app = getApps()[0] ?? initializeApp(config)
  auth = getAuth(app)
  firestore = initializeFirestore(app, { localCache: memoryLocalCache() })
  setCloudFirestore(firestore)
  const authEmulator = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR
  if (authEmulator) connectAuthEmulator(auth, emulatorHost(authEmulator), { disableWarnings: true })
  const storeEmulator = import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR
  if (storeEmulator) {
    const [host, portText] = storeEmulator.split(':')
    connectFirestoreEmulator(firestore, host, Number(portText))
  }
  await setPersistence(auth, browserLocalPersistence)
  await settleDeletionRedirect(auth)
  await new Promise<void>((resolve, reject) => {
    let first = true
    onAuthStateChanged(auth!, (user) => {
      updateGoogleSessionControls()
      void (async () => {
        if (user) await adoptUser(user)
        else await adoptGuest()
        if (first) {
          first = false
          resolve()
        }
      })().catch((error: unknown) => {
        if (first) {
          first = false
          reject(error)
        } else {
          showAuthError(error)
        }
      })
    }, reject)
  })
}

async function showWelcome(googleReady: boolean): Promise<void> {
  hooks?.setTabs(false)
  const main = document.querySelector('#main')
  if (!main) return
  main.innerHTML = `
    <section class="screen">
      <header class="topbar"><h1>LS9 Flashcards</h1></header>
      <div class="due-hero">
        <p class="kicker">Welcome</p>
        ${rehearsalNote()}
        <p class="due-label">Study with spaced repetition. Sign in and this account’s cards follow you. You can also study on this device without an account.</p>
        <p class="note" id="google-session" hidden>Signed in to Google</p>
        <div class="stack">
          <button class="primary" type="button" id="google-sign-in" ${googleReady ? '' : 'disabled'}>Continue with Google</button>
          ${deckOpenFailed ? '<button class="primary" type="button" id="open-deck-retry">Open my deck</button>' : ''}
          <button class="secondary" type="button" id="guest-study">Study on this device</button>
          <button class="danger" type="button" id="sign-out-account" ${auth?.currentUser ? '' : 'hidden'}>Sign out of Google</button>
        </div>
        <p class="note" id="auth-error">${esc(pendingError || (googleReady ? '' : 'Google sign-in is not configured on this build.'))}</p>
        ${deletionNoticeHtml()}
      </div>
    </section>
  `
  updateGoogleSessionControls()
  bindSignOutButton()
  bindDeckRetry()
  document.getElementById('guest-study')?.addEventListener('click', () => {
    localStorage.setItem(GUEST_KEY, '1')
    welcomeRelease?.()
    welcomeRelease = null
  })
  document.getElementById('google-sign-in')?.addEventListener('click', () => {
    if (!googleReady || !auth) {
      showAuthError({ code: 'missing-config' })
      return
    }
    startGoogleSignIn()
  })
  await new Promise<void>((resolve) => {
    welcomeRelease = resolve
  })
}

async function maybeWelcome(googleReady: boolean): Promise<void> {
  if (captureStudyLock().uid) return
  const hasWork = await localDatabaseHasWork(currentLocalDatabaseName())
  if (hasWork || localStorage.getItem(GUEST_KEY) === '1') return
  await showWelcome(googleReady)
}

async function confirmSignOut(): Promise<void> {
  if (!auth) return
  // Guarded Google sessions still study locally. Only the bound account's
  // pending changes need an account sign-out confirmation.
  const signedIn = Boolean(captureStudyLock().uid)
  const settings = signedIn ? await getSettings() : null
  if (settings && settings.localRevision > settings.acknowledgedRevision) {
    const stuck = getSyncStatus().needsFixing.length
    // Sync now cannot clear records the server refused, so point at the list instead.
    const choice = await presentChoice(
      stuck
        ? `${stuck === 1 ? '1 change' : `${stuck} changes`} can’t sync until fixed or kept on this device; see Needs fixing under Account. Your latest changes stay on this device for this account. They are not deleted and they are not uploaded as the next account.`
        : 'Your latest changes stay on this device for this account. They are not deleted and they are not uploaded as the next account.',
      [
        stuck ? ['fix', 'Review what needs fixing', 'secondary'] : ['sync', 'Sync now', 'secondary'],
        ['sign-out', 'Sign out', 'danger'],
        ['stay', 'Stay signed in', 'secondary'],
      ],
    )
    if (choice === 'fix') {
      location.hash = '#/settings'
      hooks?.onIdentityChanged()
      return
    }
    if (choice === 'sync') {
      await syncAccountNow()
      hooks?.onIdentityChanged()
      return
    }
    if (choice !== 'sign-out') {
      hooks?.onIdentityChanged()
      return
    }
  }
  await signOut(auth)
}

function bindSignOutButton(): void {
  const button = document.getElementById('sign-out-account') as HTMLButtonElement | null
  button?.addEventListener('click', () => {
    button.disabled = true
    void confirmSignOut()
      .catch(() => {
        pendingError = 'Google sign-out failed. Try again. Cards on this device were left as they are.'
        const error = document.getElementById('auth-error')
        if (error) error.textContent = pendingError
        else hooks?.toast(pendingError)
      })
      .finally(() => { button.disabled = false })
  })
}

export async function prepareAccount(next: AccountHooks): Promise<void> {
  hooks = next
  // A profile list names german-flashcards:<slug> while the schedule still
  // lives in the original database. Import before the sign-in offer looks.
  await importLegacyData(currentLocalDatabaseName())
  bindStudyDatabase({ uid: null, dbName: currentLocalDatabaseName() })
  const config = readConfig()
  if (!config) {
    await maybeWelcome(false)
    return
  }
  try {
    await initAccount(config)
  } catch (error) {
    showAuthError(error)
  }
  await removeDeletedDeviceCopy()
  await maybeWelcome(true)
}

export function markAccountBooted(): void {
  booted = true
}

export function accountHomeNote(): string {
  const account = !captureStudyLock().uid
    ? 'On this device · <a href="#/settings">sign in</a>'
    : `${esc(label)} · <a href="#/settings">account</a>`
  return `${rehearsalNote()}${account}`
}

export function accountBadge(): string {
  return captureStudyLock().uid ? label : 'This device'
}

export function accountSyncText(): string {
  if (!captureStudyLock().uid) return 'This device only'
  return getSyncStatus().message || 'Saved on this device'
}

export function accountPanelHtml(): string {
  const signedIn = Boolean(captureStudyLock().uid)
  if (!signedIn) {
    return `
      <div class="setting">
        ${rehearsalNote()}
        <p class="kicker" style="margin:0">Account</p>
        <p class="note">Studying on this device. Signing in does not upload these cards unless you agree.</p>
        <p class="note" id="sync-line">${esc(accountSyncText())}</p>
        <p class="note" id="google-session" hidden>Signed in to Google</p>
        <button class="primary" type="button" id="google-sign-in">Continue with Google</button>
        <button class="danger" type="button" id="sign-out-account" ${auth?.currentUser ? '' : 'hidden'}>Sign out of Google</button>
        <p class="note" id="auth-error">${esc(pendingError)}</p>
        ${deletionNoticeHtml()}
      </div>
    `
  }
  return `
    <div class="setting">
      ${rehearsalNote()}
      <p class="kicker" style="margin:0">Account</p>
      <p class="note">${esc(label)}</p>
      <p class="note" id="sync-line">${esc(accountSyncText())}</p>
      <div id="needs-fixing">${needsFixingHtml()}</div>
      <button class="secondary" type="button" id="sync-now-account">Sync now</button>
      <button class="danger" type="button" id="sign-out-account">Sign out</button>
      <p class="note" id="auth-error">${esc(pendingError)}</p>
      ${deletionNoticeHtml()}
    </div>
    <div class="setting danger-zone" id="delete-account-setting">
      <p class="kicker" style="margin:0">Delete account</p>
      <p class="note">Permanently delete this account, its cloud data and this device’s copy of it.</p>
      <button class="danger" type="button" id="delete-account">Delete account</button>
    </div>
  `
}

function needsFixingHtml(): string {
  const items = getSyncStatus().needsFixing
  if (!items.length) return ''
  const rows = items.map((entry, index) => {
    const name = entry.item.kind === 'card' || entry.item.kind === 'progress'
      ? `<a href="#/card/${encodeURIComponent(entry.item.id)}">${esc(entry.label)}</a>`
      : esc(entry.label)
    const why = entry.problem ? `${entry.problem}. Edit it to fix` : `refused by the server (${entry.code})`
    return `<li>${name}${entry.item.kind === 'progress' ? ' (schedule)' : ''}: ${esc(why)}
      <button class="secondary" type="button" data-keep-local="${index}">Keep on this device only</button></li>`
  }).join('')
  return `
    <p class="kicker" style="margin:0">Needs fixing</p>
    <p class="note">These changes can’t sync, so the account stays unsynced. Edit a card to queue it again, or keep a change on this device only; other devices won’t get it.</p>
    <ul class="needs-fixing">${rows}</ul>
  `
}

/** Stop retrying one refused revision. A later edit of the same record is queued as usual. */
async function keepOnDevice(entry: NeedsFixing): Promise<void> {
  const lock = captureStudyLock()
  if (!lock.uid) return
  const applied = await acknowledgePending(entry.item, { uid: lock.uid, generation: lock.generation })
  if (!applied) {
    hooks?.toast('Not changed: the deck or account changed. Try again.')
    return
  }
  forgetNeedsFixing(entry)
  await syncAccountNow()
}

function bindNeedsFixing(): void {
  const box = document.getElementById('needs-fixing')
  if (!box) return
  box.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-keep-local]')
    const entry = button ? getSyncStatus().needsFixing[Number(button.dataset.keepLocal)] : undefined
    if (!button || !entry) return
    button.disabled = true
    void keepOnDevice(entry).catch(() => {
      hooks?.toast('Not changed. Try again.')
    }).finally(() => { button.disabled = false })
  })
  let painted = needsFixingHtml()
  const stop = onSyncStatus(() => {
    if (!box.isConnected) {
      stop()
      return
    }
    const html = needsFixingHtml()
    if (html !== painted) box.innerHTML = painted = html
  })
}

export function bindAccountPanel(panelHooks: AccountHooks): void {
  hooks = panelHooks
  updateGoogleSessionControls()
  document.getElementById('google-sign-in')?.addEventListener('click', () => {
    startGoogleSignIn()
  })
  document.getElementById('sync-now-account')?.addEventListener('click', () => {
    void syncAccountNow()
  })
  bindSignOutButton()
  bindNeedsFixing()
  document.getElementById('delete-account')?.addEventListener('click', () => {
    void confirmAccountDeletion()
  })
}

export async function syncAccountNow(): Promise<void> {
  if (!captureStudyLock().uid) return
  try {
    await syncNow()
  } catch {
    /* Status stays on this device until the records are acknowledged. */
  }
}

function deletionNoticeHtml(): string {
  return deletionNotice ? `<p class="note" id="deletion-notice" role="status">${esc(deletionNotice)}</p>` : ''
}

function readMarker(): DeletionMarker | null {
  try {
    return readDeletionMarker(localStorage)
  } catch {
    return null
  }
}

/** Without the marker an interrupted deletion could not resume, so a failed write stops the run. */
function saveMarker(marker: DeletionMarker): void {
  writeDeletionMarker(localStorage, marker)
}

/** Re-authentication through a redirect returns here. A cancelled redirect deletes nothing. */
async function settleDeletionRedirect(current: Auth): Promise<void> {
  const marker = readMarker()
  if (!marker) return
  const result = await getRedirectResult(current).catch(() => null)
  if (marker.phase !== 'confirm') return
  if (result?.user.uid === marker.uid) {
    saveMarker({ ...marker, phase: 'data' })
    return
  }
  clearDeletionMarker(localStorage)
  deletionNotice = 'Account deletion was cancelled. Nothing was deleted.'
}

/** Popups fail in some browsers and installed apps; a redirect works there. */
function redirectInstead(code: string): boolean {
  return code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment'
}

function reauthProblem(code: string): string {
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Google sign-in was closed.'
  if (code === 'auth/user-mismatch') return 'Choose the Google account you are signed in with.'
  return `Google sign-in stopped (${code}).`
}

/** `user.delete()` needs a recent sign-in, so deletion always starts by confirming with Google. */
async function reauthenticate(user: User, marker: DeletionMarker): Promise<'ok' | 'redirect' | 'left' | string> {
  const provider = new GoogleAuthProvider()
  const attempt = ++reauthAttempt
  const left = () => attempt !== reauthAttempt || auth?.currentUser?.uid !== user.uid
  try {
    await reauthenticateWithPopup(user, provider)
    return left() ? 'left' : 'ok'
  } catch (error) {
    if (left()) return 'left'
    const code = authCode(error)
    if (!redirectInstead(code)) return reauthProblem(code)
    saveMarker(marker)
    await reauthenticateWithRedirect(user, provider)
    return 'redirect'
  }
}

function deletionScreen(title: string, body: string): HTMLElement | null {
  hooks?.setTabs(false)
  const main = document.querySelector<HTMLElement>('#main')
  if (!main) return null
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar"><h1>${esc(title)}</h1></header>
      <div class="setting danger-zone">${body}</div>
    </section>
  `
  return main
}

async function confirmAccountDeletion(): Promise<void> {
  const user = auth?.currentUser
  if (!user || captureStudyLock().uid !== user.uid || deleting) return
  const main = deletionScreen('Delete account', `
    <p class="kicker" style="margin:0">This permanently deletes</p>
    <ul class="note">
      <li>Your review progress, deck settings and review history</li>
      <li>The cards and word edits in your own deck and in decks you created</li>
      <li>Your sign-in account, ${esc(label)}</li>
      <li>This account’s copy on this device</li>
    </ul>
    <p class="note">Kept: feedback you sent, and a shared deck’s word list for its other members. This can’t be undone. Sign out on your other devices first so they don’t upload this account’s cards again.</p>
    <label for="delete-confirm">Type DELETE to confirm</label>
    <input type="text" id="delete-confirm" autocomplete="off" autocapitalize="characters" spellcheck="false" />
    <p class="note">Google then asks you to sign in again.</p>
    <button class="danger" type="button" id="delete-account-confirm" disabled>Delete account</button>
    <button class="secondary" type="button" id="delete-account-cancel">Cancel</button>
    <p class="note" id="delete-status" role="status" aria-live="polite"></p>
  `)
  if (!main) return
  const input = document.getElementById('delete-confirm') as HTMLInputElement
  const confirm = document.getElementById('delete-account-confirm') as HTMLButtonElement
  const status = document.getElementById('delete-status') as HTMLElement
  input.addEventListener('input', () => { confirm.disabled = input.value.trim() !== 'DELETE' })
  document.getElementById('delete-account-cancel')?.addEventListener('click', () => {
    reauthAttempt += 1
    hooks?.onIdentityChanged()
  })
  confirm.addEventListener('click', () => {
    if (input.value.trim() !== 'DELETE' || auth?.currentUser?.uid !== user.uid) return
    confirm.disabled = true
    status.textContent = 'Confirm with Google…'
    void (async () => {
      const marker = { ...startDeletionMarker(user.uid, Date.now(), readMarker()), phase: 'confirm' as const }
      const outcome = await reauthenticate(user, marker)
      if (outcome === 'redirect' || outcome === 'left') return
      if (outcome !== 'ok') {
        status.textContent = `${outcome} Nothing was deleted.`
        confirm.disabled = false
        return
      }
      await runAccountDeletion(user)
    })().catch((error: unknown) => {
      status.textContent = `Account deletion stopped (${authCode(error)}). Nothing was deleted.`
      confirm.disabled = false
    })
  })
  input.focus()
}

async function localCloudDeckIds(dbName: string): Promise<string[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    if (!db.objectStoreNames.contains('decks')) return []
    const decks = await new Promise<LocalDeck[]>((resolve, reject) => {
      const request = db.transaction('decks', 'readonly').objectStore('decks').getAll()
      request.onsuccess = () => resolve(request.result as LocalDeck[])
      request.onerror = () => reject(request.error)
    })
    return decks.filter((deck) => deck.origin !== 'original').map((deck) => deck.cloudId ?? deck.id)
  } finally {
    db.close()
  }
}

function deleteLocalDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/** This device's copy of the account: its database and its copy-prompt answers. */
async function removeDeviceCopy(uid: string): Promise<boolean> {
  try {
    forgetCopyDecisions(localStorage, uid)
    await withTimeout(deleteLocalDatabase(accountDatabaseName(uid)), 5000)
    return true
  } catch {
    return false
  }
}

/** After the cloud data is confirmed gone, a device copy left by an interrupted run goes at the next launch. */
async function removeDeletedDeviceCopy(): Promise<void> {
  const marker = readMarker()
  if (!marker || marker.phase !== 'auth' || auth?.currentUser?.uid === marker.uid) return
  await removeDeviceCopy(marker.uid)
}

/** Leave the account; the marker resumes the deletion when it signs in on this device again. */
async function stopDeletion(message: string): Promise<void> {
  deletionNotice = message
  if (auth?.currentUser) await signOut(auth).catch(() => {})
  endDeletionScreen()
}

function endDeletionScreen(): void {
  deleting = false
  hooks?.toast(deletionNotice)
  welcomeRelease?.()
  welcomeRelease = null
  if (!booted) return
  if (location.hash !== '#/settings') location.hash = '#/settings'
  hooks?.onIdentityChanged()
}

function showReauthForAuthDelete(user: User, message: string): void {
  deletionScreen('Delete account', `
    <p class="note">${esc(message)}</p>
    <button class="danger" type="button" id="delete-account-reauth">Confirm with Google</button>
    <button class="secondary" type="button" id="delete-account-later">Sign out and finish later</button>
    <p class="note" id="delete-status" role="status" aria-live="polite"></p>
  `)
  const button = document.getElementById('delete-account-reauth') as HTMLButtonElement | null
  const status = document.getElementById('delete-status')
  button?.addEventListener('click', () => {
    button.disabled = true
    void (async () => {
      const marker = readMarker() ?? startDeletionMarker(user.uid, Date.now(), null)
      const outcome = await reauthenticate(user, marker)
      if (outcome === 'redirect' || outcome === 'left') return
      if (outcome !== 'ok') {
        if (status) status.textContent = outcome
        button.disabled = false
        return
      }
      deleting = false
      await runAccountDeletion(user)
    })().catch((error: unknown) => {
      if (status) status.textContent = `Google sign-in stopped (${authCode(error)}).`
      button.disabled = false
    })
  })
  document.getElementById('delete-account-later')?.addEventListener('click', () => {
    reauthAttempt += 1
    void stopDeletion('Your cloud data is deleted. Sign in on this device again to delete the sign-in account.')
  })
}

/**
 * Firestore data first, in budgeted batches; the Auth user only after a pass found
 * nothing left; this device's copy last. Every step is recorded in the marker, so a
 * closed tab, a lost connection or a spent daily budget resumes at the next sign-in.
 */
async function runAccountDeletion(user: User): Promise<void> {
  if (!firestore || deleting) return
  deleting = true
  const uid = user.uid
  const knownDeckIds = await withTimeout(localCloudDeckIds(accountDatabaseName(uid)), 4000).catch(() => [])
  // Stop study and sync writing to the account while it is deleted.
  ticketId += 1
  bindStudyDatabase({ uid: null, dbName: currentLocalDatabaseName() })
  deletionScreen('Deleting account', `
    <p class="note" id="delete-progress" role="status" aria-live="polite">Deleting your cloud data…</p>
  `)
  const progress = (text: string) => {
    const el = document.getElementById('delete-progress')
    if (el) el.textContent = text
  }
  let marker = startDeletionMarker(uid, Date.now(), readMarker())
  try {
    if (marker.phase !== 'auth') {
      const today = remainingBudget({ ...marker, phase: 'data' }, Date.now())
      marker = today.marker
      saveMarker(marker)
      let deleted = 0
      const result = await deleteAccountData(firestore, uid, {
        budget: today.remaining,
        knownDeckIds,
        onBatch: (count) => {
          deleted += count
          marker = { ...marker, deletedToday: marker.deletedToday + count }
          saveMarker(marker)
          progress(`Deleting your cloud data… ${deleted} records deleted.`)
        },
      })
      if (result.state === 'budget') {
        await stopDeletion(`Deleted ${marker.deletedToday} cloud records today. To stay within the free daily cloud limit, the rest is deleted after midnight Pacific time: sign in on this device again then to continue.`)
        return
      }
      marker = { ...marker, phase: 'auth' }
      saveMarker(marker)
    }
  } catch (error) {
    const code = authCode(error)
    await stopDeletion(quotaCode(code)
      ? 'Daily cloud limit reached. Your account is partly deleted; sign in on this device again after midnight Pacific time to continue.'
      : `Account deletion stopped (${code}). Your account is partly deleted; sign in on this device again to continue.`)
    return
  }
  progress('Cloud data deleted. Deleting your sign-in account…')
  try {
    await deleteUser(user)
  } catch (error) {
    const code = authCode(error)
    if (code === 'auth/requires-recent-login') {
      showReauthForAuthDelete(user, 'Your cloud data is deleted. Confirm with Google once more to delete the sign-in account.')
      return
    }
    await stopDeletion(`Your cloud data is deleted, but the sign-in account was not (${code}). Sign in on this device again to finish.`)
    return
  }
  // A device copy that could not be removed now goes at the next launch.
  if (await removeDeviceCopy(uid)) clearDeletionMarker(localStorage)
  deletionNotice = 'Your account was deleted. You are signed out.'
  endDeletionScreen()
}

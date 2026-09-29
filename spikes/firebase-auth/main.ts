import { initializeApp } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from 'firebase/auth'

const signInButton = document.querySelector<HTMLButtonElement>('#sign-in')!
const signOutButton = document.querySelector<HTMLButtonElement>('#sign-out')!
const status = document.querySelector<HTMLElement>('#status')!
const project = document.querySelector<HTMLElement>('#project')!
const uid = document.querySelector<HTMLElement>('#uid')!
const connection = document.querySelector<HTMLElement>('#connection')!
const errorBox = document.querySelector<HTMLElement>('#error')!

function showError(error: unknown): void {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'unknown-error'
  // Error messages may contain account details. The code is enough to record
  // cancellation, blocked popups, or configuration failures for this check.
  errorBox.textContent = `Sign-in failed: ${code}`
  errorBox.hidden = false
  status.textContent = 'Sign-in failed; existing session, if any, is unchanged.'
}

function updateConnection(): void {
  connection.textContent = navigator.onLine ? 'online' : 'offline'
}

updateConnection()
window.addEventListener('online', updateConnection)
window.addEventListener('offline', updateConnection)

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

if (Object.values(config).some((value) => !value)) {
  status.textContent = 'Firebase configuration is missing. See docs/firebase-setup.md.'
} else {
  project.textContent = config.projectId
  const app = initializeApp(config)
  const auth = getAuth(app)
  const provider = new GoogleAuthProvider()
  let initialAuthState = true
  let popupPending = false
  let attempt = 0
  let startedAt = 0
  let recoverPending: (() => void) | null = null

  function showSignedOutOrIn(user: { uid: string } | null): void {
    status.textContent = user
      ? initialAuthState ? 'Signed in; session restored after reopening.' : 'Signed in.'
      : 'Signed out.'
    initialAuthState = false
  }

  function releasePopupControls(): void {
    popupPending = false
    recoverPending = null
    signInButton.disabled = false
    signInButton.textContent = 'Continue with Google'
    signOutButton.disabled = !auth.currentUser
  }

  void setPersistence(auth, browserLocalPersistence)
    .then(() => {
      onAuthStateChanged(auth, (user) => {
        uid.textContent = user?.uid ?? '—'
        if (user) errorBox.hidden = true
        signInButton.disabled = false
        signOutButton.disabled = popupPending || !user
        // Keep the "Opening Google sign-in…" line until this attempt settles.
        // A later auth event still updates the UID above.
        if (popupPending) return
        showSignedOutOrIn(user)
      }, showError)
    })
    .catch(showError)

  signInButton.addEventListener('click', () => {
    // Invoke popup directly from the user gesture. Do not await other work here.
    if (popupPending) {
      // A quick second tap is the same gesture. A later tap means the Google
      // window was dismissed and Firebase never settled.
      if (Date.now() - startedAt < 800) return
      recoverPending?.()
      return
    }
    const mine = ++attempt
    startedAt = Date.now()
    popupPending = true
    signOutButton.disabled = true
    errorBox.hidden = true
    status.textContent = 'Opening Google sign-in…'
    const watcher = new AbortController()
    let backgroundAt = 0
    let grace = 0
    const recover = () => {
      if (mine !== attempt) return
      window.clearTimeout(grace)
      watcher.abort()
      attempt += 1
      showError({ code: 'auth/popup-closed-by-user' })
      releasePopupControls()
    }
    recoverPending = recover
    // On an installed iPhone PWA, Firebase opens the handler with a synthetic
    // link click and keeps no window handle, so closing that window never
    // rejects signInWithPopup. Recover once this page is back in front.
    const markBackground = () => {
      if (!backgroundAt) backgroundAt = Date.now()
    }
    const markForeground = () => {
      if (mine !== attempt || !backgroundAt || document.visibilityState === 'hidden') return
      if (Date.now() - backgroundAt < 400) return
      window.clearTimeout(grace)
      grace = window.setTimeout(recover, 1200)
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') markBackground()
      else markForeground()
    }, { signal: watcher.signal })
    window.addEventListener('blur', markBackground, { signal: watcher.signal })
    window.addEventListener('focus', markForeground, { signal: watcher.signal })
    window.addEventListener('pageshow', markForeground, { signal: watcher.signal })
    void signInWithPopup(auth, provider)
      .then(({ user }) => {
        uid.textContent = user.uid
        if (mine !== attempt) return
        errorBox.hidden = true
        status.textContent = 'Signed in.'
      })
      .catch((error: unknown) => {
        if (mine !== attempt) return
        showError(error)
      })
      .finally(() => {
        window.clearTimeout(grace)
        watcher.abort()
        if (mine !== attempt) return
        releasePopupControls()
      })
  })

  signOutButton.addEventListener('click', () => {
    errorBox.hidden = true
    void signOut(auth).catch(showError)
  })
}

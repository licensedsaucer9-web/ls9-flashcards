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
  const app = initializeApp(config)
  const auth = getAuth(app)
  const provider = new GoogleAuthProvider()
  let initialAuthState = true

  void setPersistence(auth, browserLocalPersistence)
    .then(() => {
      onAuthStateChanged(auth, (user) => {
        uid.textContent = user?.uid ?? '—'
        status.textContent = user
          ? initialAuthState ? 'Signed in; session restored after reopening.' : 'Signed in.'
          : 'Signed out.'
        initialAuthState = false
        signInButton.disabled = false
        signOutButton.disabled = !user
      }, showError)
    })
    .catch(showError)

  signInButton.addEventListener('click', () => {
    // Invoke popup directly from the user gesture. Do not await other work here.
    errorBox.hidden = true
    status.textContent = 'Opening Google sign-in…'
    void signInWithPopup(auth, provider).catch(showError)
  })

  signOutButton.addEventListener('click', () => {
    errorBox.hidden = true
    void signOut(auth).catch(showError)
  })
}

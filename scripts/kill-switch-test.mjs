// The retired-preview worker (#118) deletes only its own scope's caches, unregisters, and sends tabs home.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../retired/kill-switch-sw.js', import.meta.url), 'utf8')
const scope = 'https://example.test/site/auth-spike/'
const caches = new Set([
  `workbox-precache-v2-${scope}`,                       // this scope: removed
  'workbox-precache-v2-https://example.test/site/',     // the real app: kept
  'workbox-precache-v2-https://example.test/site/auth-spike/rehearsal/', // nested scope: kept
])
const listeners = {}
const navigated = []
let unregistered = false
const self = {
  registration: { scope, unregister: async () => { unregistered = true; return true } },
  addEventListener: (type, fn) => { listeners[type] = fn },
  skipWaiting: () => {},
  clients: { matchAll: async () => [{ navigate: async url => { navigated.push(url) } }] },
}
new Function('self', 'caches', source)(self, {
  keys: async () => [...caches],
  delete: async name => caches.delete(name),
})
let waiting
listeners.activate({ waitUntil: promise => { waiting = promise } })
await waiting
assert.deepEqual([...caches].sort(), [
  'workbox-precache-v2-https://example.test/site/',
  'workbox-precache-v2-https://example.test/site/auth-spike/rehearsal/',
])
assert.equal(unregistered, true)
assert.deepEqual(navigated, ['https://example.test/site/'])
console.log('kill-switch worker: removes only its own scope: ok')

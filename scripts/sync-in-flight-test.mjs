// Regression: a deck switch while a cloud sync pass is in flight must rerun the pass and must not leave
// the Syncing badge stuck. Drives the real src/sync.ts loop; only the cloud backend module is swapped
// for a controllable stub through a Node loader hook.
import assert from 'node:assert/strict'
import { register } from 'node:module'

const stubSource = `
export const cloudTransport = true
export async function cloudSyncPass(control) { return globalThis.__syncPassStub(control) }
`
const stubUrl = 'data:text/javascript,' + encodeURIComponent(stubSource)
const hooksSource = `
const STUB = ${JSON.stringify(stubUrl)}
export async function resolve(specifier, context, next) {
  if (specifier === './sync-backend.ts' && context.parentURL?.endsWith('/src/sync.ts')) {
    return { url: STUB, shortCircuit: true, format: 'module' }
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooksSource))

globalThis.window = { setTimeout, clearTimeout }
globalThis.document = { visibilityState: 'visible' }
const { bindStudyDatabase, captureStudyLock } = await import('../src/study-lock.ts')
const { syncNow, getSyncStatus } = await import('../src/sync.ts')

const passes = []
globalThis.__syncPassStub = async () => {
  passes.push(captureStudyLock().dbName)
  if (passes.length === 1) {
    // The deck switch lands while the first pass is still awaiting the backend.
    await new Promise(resolve => setImmediate(resolve))
    bindStudyDatabase({ uid: 'user-1', dbName: 'deck-b' })
  }
  return 'synced'
}

bindStudyDatabase({ uid: 'user-1', dbName: 'deck-a' })
await syncNow()

assert.deepEqual(passes, ['deck-a', 'deck-b'], 'the pass is rerun against the newly bound deck database')
const status = getSyncStatus()
assert.notEqual(status.state, 'syncing', 'the Syncing badge must not stay stuck after a deck switch')
assert.equal(status.state, 'ok')
assert.equal(status.message, 'Synced')
console.log('sync in-flight deck switch: ok')

// A selection made after sync has completed must immediately clear the old badge.
const { deckSelectionChanged, pauseSync } = await import('../src/sync.ts')
deckSelectionChanged(false)
assert.deepEqual(getSyncStatus(), { state: 'idle', message: 'On this device', at: null, needsFixing: [] })
assert.equal(passes.length, 2, 'selecting a local deck does not start cloud work')
deckSelectionChanged(true)
assert.equal(getSyncStatus().state, 'waiting', 'returning to German schedules pending sync')
pauseSync()
console.log('idle deck selection status: ok')

// Refused records are listed until a pass syncs them, and a deck switch drops the old deck's list (#113).
const refused = [{ item: { kind: 'card', id: 'long', contentRevision: 3, tombstoneRevision: 0 }, code: 'permission-denied', label: 'long', problem: null }]
globalThis.__syncPassStub = async () => ({ state: 'rejected', message: 'long rejected', items: refused })
await syncNow()
assert.equal(getSyncStatus().state, 'error')
assert.deepEqual(getSyncStatus().needsFixing, refused, 'the rejected records are listed')
globalThis.__syncPassStub = async () => 'pending'
await syncNow()
assert.deepEqual(getSyncStatus().needsFixing, refused, 'a pass that stopped early keeps the list')
globalThis.__syncPassStub = async () => 'synced'
await syncNow()
assert.deepEqual(getSyncStatus().needsFixing, [], 'a synced pass clears the list')
globalThis.__syncPassStub = async () => ({ state: 'rejected', message: 'long rejected', items: refused })
await syncNow()
deckSelectionChanged(true)
pauseSync()
assert.deepEqual(getSyncStatus().needsFixing, [], 'a deck switch clears the previous deck list')
console.log('needs-fixing list: ok')

// Signing out or switching account starts no pass, but the old account's list must not stay (#113 review).
globalThis.__syncPassStub = async () => ({ state: 'rejected', message: 'long rejected', items: refused })
await syncNow()
assert.deepEqual(getSyncStatus().needsFixing, refused)
const { clearStudyBinding } = await import('../src/study-lock.ts')
clearStudyBinding()
assert.deepEqual(getSyncStatus().needsFixing, [], 'signing out hides the previous account list')
bindStudyDatabase({ uid: 'user-2', dbName: 'deck-a' })
assert.deepEqual(getSyncStatus().needsFixing, [], 'the next account does not see the previous account list')
let listedDuringPass
globalThis.__syncPassStub = async () => {
  listedDuringPass = getSyncStatus().needsFixing
  return 'pending'
}
await syncNow()
assert.deepEqual(listedDuringPass, [], 'a pass for the new account does not carry the old list')
assert.deepEqual(getSyncStatus().needsFixing, [], 'a pass that stops early does not revive the old list')
console.log('needs-fixing list across accounts: ok')

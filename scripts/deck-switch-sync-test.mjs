// Real cloud orchestration + IndexedDB in two tabs; only cloud transport is stubbed.
// Disposable browser storage, synthetic cards, and no external requests.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'deck-switch-sync-'))
let server, browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({ cacheDir, plugins: [{
    name: 'isolated-cloud-transport', enforce: 'pre',
    configureServer(server) {
      // Exercise explicit passes without main.ts foreground handlers racing
      // them when Playwright changes the visible tab. UI coverage lives in
      // decks-ui-test.mjs; these pages only host the real DB/sync modules.
      server.middlewares.use('/__deck-switch-sync-fixture', (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><title>Deck sync fixture</title>')
      })
    },
    load(id) {
      if (id.endsWith('/src/sync-backend.ts')) return `export * from './cloud-sync.ts'`
      if (id.endsWith('/src/cloud-handle.ts')) return 'export function cloudFirestore() { return {} }'
      if (id.endsWith('/src/cloud-push.ts')) return `
        export async function accountDeckId() { return 'fixture-original' }
        export async function ensureExtraDeck() {}
        export async function pullDeckCards() { return [] }
        export async function pullCloud(_db, _uid, _deckId, extra) {
          globalThis.pullStarted = true
          if (globalThis.waitForPull) await new Promise(resolve => { globalThis.releasePull = resolve })
          return extra ? (globalThis.extraDocs ?? { cards: [], progress: [], activity: [], settings: { direction: 'de-en', sessionSize: 20, tier: 3, settingsUpdatedAt: 0 } }) : globalThis.cloudDocs
        }
        const commit = async (...args) => {
          if (globalThis.rejectDeck === args[1]) throw { code: 'permission-denied' }
          globalThis.pushes.push(args); return 'wrote'
        }
        export const commitCard = commit, commitProgress = commit, commitSettings = commit, commitActivity = commit
      `
    },
  }], server: { host: '127.0.0.1', port: 4183, strictPort: true } })
  await server.listen()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const external = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue()
    external.push(route.request().url()); return route.abort()
  })
  const a = await context.newPage(), b = await context.newPage()
  for (const page of [a, b]) {
    await page.goto('http://127.0.0.1:4183/__deck-switch-sync-fixture')
  }
  await a.evaluate(async () => {
    const api = await import('/src/db.ts')
    const locks = await import('/src/study-lock.ts')
    const { filesToDocs } = await import('/src/firestore-docs.ts')
    const sample = (await import('/src/seed.ts')).seedCards()[0]
    globalThis.sample = sample
    locks.bindStudyDatabase({ uid: 'fixture-user', dbName: 'fixture-shared' })
    await api.recordAssignedDeck('fixture-original')
    await api.putSettings({ sessionSize: 20, tier: 2, direction: 'en-de', wordTypes: ['noun'] })
    globalThis.scope = { lock: locks.captureStudyLock(), deckId: 'fixture-original' }
    globalThis.remote = { version: 2, kind: 'deck', updated_at: 1,
      cards: [{ ...sample, id: 'fixture-remote', updated_at: 100 }], deleted_ids: {} }
    globalThis.cloudDocs = filesToDocs(globalThis.remote, null)
    globalThis.pushes = []; globalThis.waitForPull = true
    const sync = await import('/src/cloud-sync.ts')
    globalThis.pass = sync.cloudSyncPass({ requestAgain() {} })
  })
  await a.waitForFunction(() => globalThis.pullStarted)
  const localId = await b.evaluate(async () => {
    const api = await import('/src/db.ts')
    const locks = await import('/src/study-lock.ts')
    locks.bindStudyDatabase({ uid: 'fixture-user', dbName: 'fixture-shared' })
    return (await api.createLocalDeck('French fixture', 'French')).id
  })
  const result = await a.evaluate(async () => {
    const api = await import('/src/db.ts')
    const locks = await import('/src/study-lock.ts')
    const originalLockStillValid = locks.studyLockCurrent(globalThis.scope.lock)
    globalThis.releasePull()
    const outcome = await globalThis.pass
    const { getSyncStatus } = await import('/src/sync.ts')
    return { outcome, originalLockStillValid, status: getSyncStatus(), cards: await api.getAllCards(), pushes: globalThis.pushes.length,
      active: (await api.getSettings()).activeDeckId }
  })
  assert.equal(result.originalLockStillValid, true, 'reproduces a foreign-tab switch without local generation invalidation')
  assert.equal(result.active, localId)
  assert.deepEqual(result.cards, [], 'the new local deck must not receive cloud cards')
  assert.equal(result.pushes, 0, 'a switched-away pass never pushes local data')
  assert.equal(result.outcome, 'idle', 'the switched-away pass must stop')

  // The guards must also hold between stages, not just before/after the fetch.
  const guards = await a.evaluate(async () => {
    const api = await import('/src/db.ts')
    await api.putCard({ ...globalThis.sample, id: 'fixture-local' })
    await api.putSettings({ direction: 'de-en', sessionSize: 5, tier: 3, wordTypes: ['verb'] })
    const before = await api.getSettings()
    const progress = { version: 2, kind: 'user', user: 'fixture-user', updated_at: 999,
      settings: { direction: 'de-en', sessionSize: 1, tier: 1, wordTypes: [] }, settings_updated_at: 9999999999999,
      progress: { 'fixture-local': { ease: 3, interval: 99, reps: 99, due: 99, updated_at: 9999999999999 } } }
    const cardsBefore = await api.getAllCards()
    await api.mergeDeckIntoDb(globalThis.remote, undefined, globalThis.scope)
    await api.mergeProgressIntoDb(progress, undefined, globalThis.scope)
    const snapshot = await api.readCloudSnapshot(globalThis.scope)
    const ack = await api.acknowledgePending({ kind: 'settings', revision: before.pending.settings?.revision ?? 0 },
      { uid: 'fixture-user', generation: globalThis.scope.lock.generation, scope: globalThis.scope })
    await api.acknowledgeRevision(before.localRevision, undefined, globalThis.scope)
    return { before, after: await api.getSettings(), cardsBefore, cardsAfter: await api.getAllCards(), snapshot, ack }
  })
  assert.equal(guards.snapshot, null)
  assert.equal(guards.ack, false)
  assert.deepEqual(guards.cardsAfter, guards.cardsBefore, 'stale cloud stages cannot merge or grade local cards')
  assert.deepEqual(guards.after, guards.before, 'stale cloud stages cannot overwrite preferences or acknowledge pending writes')

  // Returning to German still allows a complete cloud pass and keeps local cards separate.
  await b.evaluate(async () => { const api = await import('/src/db.ts'); await api.switchActiveDeck('fixture-original') })
  const resumed = await a.evaluate(async () => {
    globalThis.waitForPull = false
    const cloud = await import('/src/cloud-sync.ts'), api = await import('/src/db.ts')
    const outcome = await cloud.cloudSyncPass({ requestAgain() {} })
    return { outcome, ids: (await api.getAllCards()).map(c => c.id), settings: await api.getSettings(), pushes: globalThis.pushes }
  })
  assert.equal(resumed.outcome, 'pending', 'unsent extra-deck content keeps the account pending')
  assert.equal(resumed.settings.sessionSize, 20)
  assert.equal(resumed.settings.direction, 'en-de')
  assert.equal(resumed.settings.tier, 2)
  assert.deepEqual(resumed.settings.wordTypes, ['noun'])
  assert(resumed.pushes.some(args => args[2]?.sessionSize === 20 && args[2]?.direction === 'en-de'), 'cloud writes original preferences')
  assert(!resumed.pushes.some(args => args[2]?.sessionSize === 5), 'cloud never writes local deck preferences')
  const returned = await a.evaluate(async (id) => {
    const api = await import('/src/db.ts')
    await api.switchActiveDeck(id)
    return api.getSettings()
  }, localId)
  assert.equal(returned.sessionSize, 5)
  assert.equal(returned.direction, 'de-en')
  assert.equal(returned.tier, 3)
  assert.deepEqual(returned.wordTypes, ['verb'])
  const extra = await a.evaluate(async () => {
    const api = await import('/src/db.ts'), cloud = await import('/src/cloud-sync.ts')
    const { listPushItems, hasDirty } = await import('/src/record-sync.ts')
    const { captureStudyLock } = await import('/src/study-lock.ts')
    const deckId = (await api.getSettings()).activeDeckId
    const snapshot = await api.readCloudSnapshot({ lock: captureStudyLock(), deckId })
    const item = listPushItems(snapshot.settings.pending, deckId).find(item => item.kind === 'card')
    const wrongAck = await api.acknowledgePending({ ...item, deckId: 'fixture-original' },
      { uid: 'fixture-user', generation: captureStudyLock().generation, scope: { lock: captureStudyLock(), deckId } })
    globalThis.pushes = []
    const outcome = await cloud.cloudSyncPass({ requestAgain() {} })
    return { outcome, wrongAck, item, pushes: globalThis.pushes, dirty: hasDirty((await api.readCloudSnapshot()).settings.pending) }
  })
  assert.equal(extra.item?.id, 'fixture-local', 'the explicit extra-deck pass starts with pending card content')
  assert.equal(extra.item.deckId, localId)
  assert.equal(extra.outcome, 'synced')
  assert.equal(extra.wrongAck, false, 'an acknowledgement naming the other deck is refused')
  assert.equal(extra.dirty, false, 'extra-deck records are acknowledged')
  assert.equal(extra.pushes.length, 3, 'extra-deck sync sends content, progress and settings')
  assert(extra.pushes.some(args => args[2]?.sessionSize === 5 && args[4] === localId), 'extra settings use their own cloud path')
  assert.equal(extra.pushes[0][1], localId)
  assert.equal(extra.pushes[0][2], 'fixture-local')
  const mergedExtra = await a.evaluate(async () => {
    const api = await import('/src/db.ts'), cloud = await import('/src/cloud-sync.ts')
    const before = (await api.getAllCards())[0]
    const activity = await api.getReviewActivity()
    globalThis.extraDocs = { cards: [], progress: [{ id: before.id,
      data: { ease: 2.7, interval: 4, reps: 2, due: 9999999999999, updated_at: 9999999999998 } }],
      activity: [], settings: { direction: 'en-de', sessionSize: 9, tier: 3, wordTypes: [], settingsUpdatedAt: 9999999999998 } }
    await cloud.cloudSyncPass({ requestAgain() {} })
    const extraCard = (await api.getAllCards())[0], extraSettings = await api.getSettings()
    await api.switchActiveDeck('fixture-original')
    const german = await api.getSettings()
    await api.switchActiveDeck(extraSettings.activeDeckId)
    globalThis.extraDocs = undefined
    return { extraCard, extraSettings, german, activityBefore: activity, activityAfter: await api.getReviewActivity() }
  })
  assert.equal(mergedExtra.extraCard.srs.due, 9999999999999, 'incoming extra review changes the local due time')
  assert.equal(mergedExtra.extraSettings.sessionSize, 9)
  assert.equal(mergedExtra.extraSettings.direction, 'en-de')
  assert.equal(mergedExtra.german.sessionSize, 20, 'incoming extra settings preserve German preferences')
  assert.deepEqual(mergedExtra.activityAfter, mergedExtra.activityBefore, 'extra merge preserves streak events')
  const reviewedExtra = await a.evaluate(async () => {
    const api = await import('/src/db.ts'), cloud = await import('/src/cloud-sync.ts')
    const id = (await api.getSettings()).activeDeckId
    const card = (await api.getAllCards())[0]
    const graded = await api.saveReview(card.id, 'good', crypto.randomUUID(), Date.now(), 'UTC')
    await api.switchActiveDeck('fixture-original')
    const germanOutcome = await cloud.cloudSyncPass({ requestAgain() {} })
    await api.switchActiveDeck(id)
    globalThis.pushes = []
    const outcome = await cloud.cloudSyncPass({ requestAgain() {} })
    return { germanOutcome, outcome, graded, pushes: globalThis.pushes, id }
  })
  assert.equal(reviewedExtra.germanOutcome, 'pending', 'inactive extra progress prevents account-wide acknowledgement')
  assert.equal(reviewedExtra.outcome, 'synced')
  assert(reviewedExtra.pushes.some(args => args[2] === reviewedExtra.graded.id
    && args[3]?.due === reviewedExtra.graded.srs.due && args[4] === reviewedExtra.id), 'review uploads the due time to the extra-deck path')
  const deniedExtra = await a.evaluate(async () => {
    const api = await import('/src/db.ts'), cloud = await import('/src/cloud-sync.ts')
    const local = (await api.getAllCards())[0]
    await api.putCard({ ...local, en: 'edited locally', updated_at: Date.now() })
    globalThis.rejectDeck = (await api.getSettings()).activeDeckId
    const denied = await cloud.cloudSyncPass({ requestAgain() {} })
    await api.switchActiveDeck('fixture-original')
    const original = await cloud.cloudSyncPass({ requestAgain() {} })
    return { denied, original }
  })
  assert.equal(deniedExtra.denied.state, 'rejected')
  assert.equal(deniedExtra.original, 'pending', 'German cannot report account sync while an extra-deck card is rejected')
  // Offline German work must survive a successful extra-deck pass in both
  // the account revision used by sign-out and the foreground sync badge.
  const pendingGerman = await a.evaluate(async (extraId) => {
    const api = await import('/src/db.ts'), cloud = await import('/src/cloud-sync.ts')
    const sync = await import('/src/sync.ts')
    globalThis.rejectDeck = undefined
    await api.putCard({ ...globalThis.sample, id: 'fixture-pending-german' })
    await api.saveReview('fixture-pending-german', 'good', crypto.randomUUID(), Date.now(), 'UTC')
    await api.putSettings({ sessionSize: 7 })
    const before = await api.getSettings()
    await api.switchActiveDeck(extraId)
    let retries = 0
    const outcome = await cloud.cloudSyncPass({ requestAgain() { retries++ } })
    await sync.syncNow()
    const after = await api.getSettings()
    const status = sync.getSyncStatus()
    await api.switchActiveDeck('fixture-original')
    const pending = (await api.readCloudSnapshot()).settings.pending
    const original = await cloud.cloudSyncPass({ requestAgain() {} })
    await api.switchActiveDeck(extraId)
    await sync.syncNow()
    return { before, after, outcome, retries, status, pending, original,
      final: await api.getSettings(), finalStatus: sync.getSyncStatus() }
  }, localId)
  assert.equal(pendingGerman.outcome, 'pending')
  assert.equal(pendingGerman.retries, 0, 'another deck pending must not spin the foreground loop')
  assert.equal(pendingGerman.after.acknowledgedRevision, pendingGerman.before.acknowledgedRevision)
  assert(pendingGerman.after.localRevision > pendingGerman.after.acknowledgedRevision, 'sign-out still sees unacknowledged German work')
  assert.equal(pendingGerman.status.message, 'Saved on this device')
  assert.deepEqual(pendingGerman.pending.activity, {}, 'account activity can sync from either deck')
  for (const kind of ['cards', 'progress']) {
    assert(Object.values(pendingGerman.pending[kind]).some(mark => mark.revision > mark.acked), `${kind} remains pending`)
  }
  assert(pendingGerman.pending.settings.revision > pendingGerman.pending.settings.acked)
  assert.equal(pendingGerman.original, 'synced')
  assert.equal(pendingGerman.final.localRevision, pendingGerman.final.acknowledgedRevision)
  assert.equal(pendingGerman.finalStatus.message, 'Synced')
  // A deletion supersedes unsent content/progress. It must not strand the
  // account clock, either for new deletions or stale marks from older clients.
  await a.evaluate(id => { globalThis.extraId = id }, localId)
  for (const deckId of ['fixture-original', localId]) {
    const deleted = await a.evaluate(async (deckId) => {
      const api = await import('/src/db.ts'), sync = await import('/src/sync.ts')
      await api.switchActiveDeck(deckId)
      await api.putCard({ ...globalThis.sample, id: `fixture-delete-before-upload-${deckId}` })
      await api.deleteCard(`fixture-delete-before-upload-${deckId}`, 5000)
      const before = await api.getSettings()
      globalThis.pushes = []
      await sync.syncNow()
      return { before, after: await api.getSettings(), status: sync.getSyncStatus(), pushes: globalThis.pushes }
    }, deckId)
    assert.equal(deleted.before.pending.cards[`fixture-delete-before-upload-${deckId}`], undefined)
    assert.equal(deleted.before.pending.progress[`fixture-delete-before-upload-${deckId}`], undefined)
    assert.equal(deleted.status.message, 'Synced')
    assert.equal(deleted.after.localRevision, deleted.after.acknowledgedRevision)
    assert(deleted.pushes.some(args => args[1] === deckId && args[2] === `fixture-delete-before-upload-${deckId}`
      && args[3] === null && args[4] === 5000), 'the deletion still uploads its tombstone')

    const recovered = await a.evaluate(async (deckId) => {
      const api = await import('/src/db.ts'), sync = await import('/src/sync.ts')
      // Recreate marks persisted by the old delete path, including while this
      // deck is inactive. No card row exists for these marks.
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('fixture-shared')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('settings', 'readwrite')
          const store = tx.objectStore('settings'), read = store.get('settings')
          read.onsuccess = () => {
            const settings = read.result
            settings.localRevision++
            for (const kind of ['cards', 'progress']) {
              settings.pending[kind][`fixture-delete-before-upload-${deckId}`] = {
                revision: settings.localRevision, acked: 0, deckId,
              }
            }
            store.put(settings)
          }
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onabort = () => { db.close(); reject(tx.error) }
        }
      })
      await sync.syncNow()
      const recoveredStatus = sync.getSyncStatus()
      const recoveredSettings = await api.getSettings()
      if (recoveredStatus.message !== 'Synced' || recoveredSettings.localRevision !== recoveredSettings.acknowledgedRevision) {
        throw new Error('stored orphan marks block the deleted card’s own deck')
      }
      await api.switchActiveDeck(deckId === 'fixture-original' ? globalThis.extraId : 'fixture-original')
      await api.putCard({ ...globalThis.sample, id: `fixture-after-delete-${deckId}` })
      globalThis.pushes = []
      await sync.syncNow()
      return { after: await api.getSettings(), status: sync.getSyncStatus(), pushes: globalThis.pushes }
    }, deckId)
    assert.equal(recovered.status.message, 'Synced', 'stored orphan marks cannot block a later upload on the other deck')
    assert.equal(recovered.after.localRevision, recovered.after.acknowledgedRevision)
    assert(recovered.pushes.some(args => args[2] === `fixture-after-delete-${deckId}`), 'later content still uploads')
  }
  assert(resumed.ids.includes('fixture-remote'))
  assert(!resumed.ids.includes('fixture-local'))
  assert.deepEqual(external, [])
  console.log('deck-switch-sync: cross-tab fetch/merge/snapshot/ack isolation and original-deck resumption ok')
} finally {
  await browser?.close()
  await server?.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

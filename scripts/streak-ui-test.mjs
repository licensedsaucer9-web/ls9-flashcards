import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Shares the synthetic-auth browser harness; never accesses a real account. */
export async function testStreakUI(newPage) {
  await testLegacyStoredActivity(newPage)
  const page = await newPage()
  async function capture(name) {
    if (!process.env.STREAK_SCREENSHOT_DIR) return
    mkdirSync(process.env.STREAK_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.STREAK_SCREENSHOT_DIR, `${name}.png`), fullPage: true })
  }
  await page.click('#guest-study')
  await page.waitForSelector('#start')
  await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') })
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const card = (await db.getAllCards())[0]
    const locks = await import('/src/study-lock.ts')
    const source = locks.captureStudyLock()
    const streak = await import('/src/streak.ts')
    const zones = [['+00:00', 'UTC'], ['GMT', 'UTC'], ['+01:00', 'Etc/GMT-1'], ['-05:00', 'Etc/GMT+5'],
      [undefined, streak.deviceTimeZone()]]
    for (const [index, [raw, expected]] of zones.entries()) {
      locks.bindStudyDatabase({ uid: null, dbName: `streak-zone-${index}` })
      await db.putCard(card)
      const id = crypto.randomUUID()
      await db.saveReview(card.id, 'again', id, Date.now(), raw)
      const activity = await db.getReviewActivity()
      if (activity[id].timeZone !== expected || !streak.validReviewEvent(id, activity[id])) throw new Error('Invalid saved device zone')
      // Travelling must preserve the canonical zone already frozen in activity.
      const next = crypto.randomUUID()
      await db.saveReview(card.id, 'again', next, Date.now(), 'Europe/Oslo')
      if ((await db.getReviewActivity())[next].timeZone !== expected) throw new Error('Saved zone changed')
    }
    locks.bindStudyDatabase({ uid: source.uid, dbName: source.dbName })
    await db.putCard({ ...card, article: 'der', tier: 1 })
    await db.putSettings({ sessionSize: 1, tier: 1, wordTypes: [] })
    window.streakCardId = card.id
    for (let i = 0; i < 9; i++) await db.saveReview(card.id, 'again', crypto.randomUUID(), Date.now(), 'UTC')
    await (await import('/src/streak-ui.ts')).refreshStreak()
  })
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '🌙 0-day streak · 9/10 today')
  await page.evaluate(async () => {
    const ui = await import('/src/streak-ui.ts')
    const original = IDBObjectStore.prototype.getAll
    let release
    let started
    const ready = new Promise(resolve => { started = resolve })
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name !== 'activity') return original.apply(this, args)
      IDBObjectStore.prototype.getAll = original
      const request = { result: [] }
      // Keep the real readwrite transaction active while this old read is delayed.
      const tx = this.transaction
      let released = false
      const keepAlive = () => {
        const pending = tx.objectStore('settings').get('settings')
        pending.onsuccess = () => { if (!released) keepAlive() }
      }
      keepAlive()
      release = () => { released = true; request.onsuccess() }
      const actual = original.apply(this, args)
      actual.onsuccess = () => { request.result = actual.result; started() }
      return request
    }
    try {
      const old = ui.refreshStreak()
      await ready
      const newer = ui.refreshStreak()
      release()
      await newer
      await old
    } finally { IDBObjectStore.prototype.getAll = original }
  })
  assert.equal(await page.locator('[data-streak-label]').textContent(), '🌙 0-day streak · 9/10 today', 'older refresh cannot overwrite newer activity')
  await capture('off')
  await page.click('#start')
  // Home has the same summary selector. Wait for the async IndexedDB-backed
  // review render before focusing it, or that render can replace the focused node.
  await page.waitForSelector('#card')
  const summary = page.locator('[data-streak] summary')
  await summary.focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('[data-streak]').getAttribute('open'), '')
  assert.equal(await page.locator('#card').getAttribute('class'), 'flip ')
  await page.keyboard.press('Space')
  assert.equal(await page.locator('[data-streak]').getAttribute('open'), null)
  await page.click('#card')
  await page.click('[data-grade="again"]')
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '🔥 1-day streak')
  await page.click('#back')
  await page.waitForSelector('#start')
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '🔥 1-day streak')

  // Crossing days while open updates only the passive counter, not the session.
  await page.clock.setSystemTime(new Date('2026-10-02T00:00:00Z'))
  await page.clock.runFor(1100)
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '🌙 1-day streak · 0/10 today')
  await page.clock.setSystemTime(new Date('2026-10-04T12:00:00Z'))
  await page.clock.runFor(1100)
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '💀 20 reviews to repair · 0/10 today')
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const card = (await db.getAllCards())[0]
    window.streakCardId = card.id
    const grades = ['again', 'wrong_gender', 'hard', 'good', 'easy']
    for (let i = 0; i < 29; i++) await db.saveReview(card.id, grades[i % grades.length], crypto.randomUUID())
    await (await import('/src/streak-ui.ts')).refreshStreak()
  })
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '💀 1 review to repair · 10/10 today')
  await capture('broken')
  assert.equal(await page.locator('[data-streak]').getAttribute('aria-live'), null)
  assert.equal(await page.locator('[data-streak] [role="alert"]').count(), 0)
  await page.locator('[data-streak] summary').click()
  assert.match(await page.locator('[data-streak-help]').textContent(), /10 graded reviews cover today/)
  await page.locator('[data-streak] summary').click()
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    await db.saveReview(window.streakCardId, 'easy', crypto.randomUUID())
    await (await import('/src/streak-ui.ts')).refreshStreak()
  })
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '🔥 4-day streak')

  await capture('on')
  const checks = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const locks = await import('/src/study-lock.ts')
    const sourceName = locks.captureStudyLock().dbName
    const id = crypto.randomUUID()
    const at = Date.now()
    const first = await db.saveReview(window.streakCardId, 'good', id, at)
    const again = await db.saveReview(window.streakCardId, 'good', id, at + 1)
    const snapshot = await db.readLocalState('fixture')
    const activity = await db.getReviewActivity()
    let invalidFailed = false
    try { await db.saveReview(window.streakCardId, 'good', 'invalid-event-id') } catch { invalidFailed = true }
    const afterInvalid = await db.getCard(window.streakCardId)
    const unchanged = JSON.stringify(activity) === JSON.stringify(await db.getReviewActivity())
    const originalAdd = IDBObjectStore.prototype.add
    let aborted = false
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'activity') throw new DOMException('Synthetic storage failure', 'QuotaExceededError')
      return originalAdd.apply(this, args)
    }
    try { await db.saveReview(window.streakCardId, 'good', crypto.randomUUID()) } catch { aborted = true }
    finally { IDBObjectStore.prototype.add = originalAdd }
    const rolledBack = JSON.stringify(first) === JSON.stringify(await db.getCard(window.streakCardId))
      && JSON.stringify(activity) === JSON.stringify(await db.getReviewActivity())
    const lockBeforeSwitch = locks.captureStudyLock()
    locks.bindStudyDatabase({ uid: 'streak-account', dbName: 'streak-ui-account' })
    const empty = Object.keys(await db.getReviewActivity()).length
    const rejectedAck = await db.acknowledgePending({ kind: 'activity', id, revision: 999 },
      { uid: lockBeforeSwitch.uid, generation: lockBeforeSwitch.generation })
    await db.copyGuestDatabase(sourceName, 'progress')
    const copied = await db.getReviewActivity()
    await db.copyGuestDatabase(sourceName, 'progress')
    const copiedTwice = await db.getReviewActivity()
    const pending = (await db.getSettings()).pending.activity
    const lock = locks.captureStudyLock()
    await db.acknowledgePending({ kind: 'activity', id, revision: pending[id].revision - 1 },
      { uid: lock.uid, generation: lock.generation })
    const afterPartialAck = (await db.getSettings()).pending.activity
    const dirtyRetained = afterPartialAck[id].acked < afterPartialAck[id].revision
      && Object.keys(afterPartialAck).length === Object.keys(pending).length
    const acknowledged = await db.acknowledgePending({ kind: 'activity', id, revision: pending[id].revision },
      { uid: lock.uid, generation: lock.generation })
    const afterAck = (await db.getSettings()).pending.activity
    const mark = afterAck[id]
    const remainingPending = Object.keys(afterAck).length === Object.keys(pending).length - 1
      && Object.values(afterAck).every(mark => mark.acked < mark.revision)
    const eventRetained = !!(await db.getReviewActivity())[id]
    // Existing schedules alone cannot manufacture activity on a different account.
    locks.bindStudyDatabase({ uid: 'streak-other', dbName: 'streak-ui-other' })
    await db.putCard(first)
    const otherCount = Object.keys(await db.getReviewActivity()).length
    // Simulate a pull to the second device, twice, then a new offline grade there.
    await db.mergeProgressIntoDb(snapshot.snapshot.user)
    await db.mergeProgressIntoDb(snapshot.snapshot.user)
    const pulled = await db.getReviewActivity()
    await db.saveReview(first.id, 'again', crypto.randomUUID())
    const fromOther = await db.readLocalState('fixture')
    locks.bindStudyDatabase({ uid: null, dbName: sourceName })
    await db.mergeProgressIntoDb(fromOther.snapshot.user)
    const mergedCount = Object.keys(await db.getReviewActivity()).length
    return {
      replayIdentical: JSON.stringify(first) === JSON.stringify(again), count: Object.keys(activity).length,
      aborted, rolledBack, invalidFailed, invalidUnchanged: unchanged && JSON.stringify(first) === JSON.stringify(afterInvalid),
      exported: JSON.stringify(snapshot.snapshot.user.activity) === JSON.stringify(activity), empty, rejectedAck,
      copied: Object.keys(copied).length, copiedTwice: Object.keys(copiedTwice).length,
      pending: Object.keys(pending).length, acknowledged, acked: mark === undefined, dirtyRetained, remainingPending, eventRetained,
      otherCount, pulled: Object.keys(pulled).length, mergedCount,
    }
  })
  assert.equal(checks.dirtyRetained && checks.remainingPending && checks.eventRetained, true, 'acks prune only fully confirmed marks and preserve event history')
  assert.equal(checks.replayIdentical, true, 'retry cannot reschedule or count a grade twice')
  assert.equal(checks.count, 41)
  assert.equal(checks.invalidFailed && checks.invalidUnchanged, true, 'failed saves roll back scheduling and activity together')
  assert.equal(checks.aborted && checks.rolledBack, true, 'storage failure after scheduling write rolls back the entire grade')
  assert.equal(checks.exported, true)
  assert.equal(checks.empty, 0)
  assert.equal(checks.rejectedAck, false)
  assert.equal(checks.copied, 41)
  assert.equal(checks.copiedTwice, 41)
  assert.equal(checks.pending, 41)
  assert.equal(checks.acknowledged && checks.acked, true)
  assert.equal(checks.otherCount, 0)
  assert.equal(checks.pulled, 41)
  assert.equal(checks.mergedCount, 42)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'counter fits mobile width')
  console.log('streak-ui: active/off/broken, repair, midnight, saved grades, idempotent retry, rollback, copy, merge and account isolation: ok')
}

/** Seed raw v2 rows directly, as left by the earlier installed build. */
async function testLegacyStoredActivity(newPage) {
  const page = await newPage()
  const warnings = []
  page.on('console', message => { if (message.type() === 'warning' && message.text().includes('stored review activity')) warnings.push(message.text()) })
  await page.click('#guest-study')
  await page.waitForSelector('#start')
  await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') })
  const checks = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const locks = await import('/src/study-lock.ts')
    const streak = await import('/src/streak.ts')
    const merge = await import('/src/merge.ts')
    const sync = await import('/src/record-sync.ts')
    const source = locks.captureStudyLock()
    const card = (await db.getAllCards())[0]
    const results = []
    for (const entry of ['get', 'load', 'save']) {
      const name = entry === 'load' ? source.dbName : `legacy-streak-${entry}`
      locks.bindStudyDatabase({ uid: 'legacy-test', dbName: name })
      await db.putCard(card)
      const zones = ['+01:00', '+00:00', '-05:00', 'GMT', '+05:30']
      const ids = zones.map(() => crypto.randomUUID())
      const raw = Object.fromEntries(ids.map((id, index) => [id, { at: Date.now() - 1000 + index, timeZone: zones[index] }]))
      const request = indexedDB.open(name)
      const store = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      const tx = store.transaction(['activity', 'settings'], 'readwrite')
      for (const [id, event] of Object.entries(raw)) tx.objectStore('activity').put({ id, ...event })
      const settingsRequest = tx.objectStore('settings').get('settings')
      settingsRequest.onsuccess = () => {
        const settings = settingsRequest.result
        settings.localRevision++
        settings.pending.activity = Object.fromEntries(ids.map(id => [id, { revision: settings.localRevision, acked: 0 }]))
        tx.objectStore('settings').put(settings)
      }
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      store.close()
      if (entry === 'get') await db.getReviewActivity()
      if (entry === 'load') await db.readLocalState('fixture')
      const before = await db.getCard(card.id)
      await db.saveReview(card.id, 'again', crypto.randomUUID(), Date.now(), 'Europe/Oslo')
      const snapshot = await db.readCloudSnapshot()
      const activity = snapshot.activity
      const expected = ['Etc/GMT-1', 'UTC', 'Etc/GMT+5', 'UTC']
      if (expected.some((zone, i) => activity[ids[i]]?.timeZone !== zone) || activity[ids[4]]) throw new Error('Legacy zone repair failed')
      if (snapshot.settings.pending.activity[ids[4]]) throw new Error('Skipped event remains dirty')
      if (Object.values(activity).some(event => !expected.includes(event.timeZone))) throw new Error('Grade inherited raw zone')
      if (JSON.stringify(before.srs) === JSON.stringify(snapshot.cards.get(card.id).srs)) throw new Error('New grade did not save')
      const exported = (await db.readLocalState('fixture')).snapshot.user
      const parsed = merge.parseUserFile(JSON.parse(JSON.stringify(exported)))
      const imported = merge.parseUserFile({ ...exported, activity: raw })
      if (Object.keys(parsed.activity).length !== 5 || Object.keys(imported.activity).length !== 4) throw new Error('User-file repair failed')
      const pushed = []
      const lock = locks.captureStudyLock()
      const queue = await sync.runDirtyQueue(sync.listPushItems(snapshot.settings.pending), {
        locked: () => true,
        push: async item => {
          if (item.kind === 'activity') {
            if (!streak.validReviewEvent(item.id, activity[item.id])) throw new Error('Invalid push payload')
            pushed.push(activity[item.id])
          }
          return 'wrote'
        },
        ack: item => db.acknowledgePending(item, { uid: lock.uid, generation: lock.generation }),
      })
      if (!queue.clean || sync.hasDirty((await db.readCloudSnapshot()).settings.pending) || pushed.length !== 5) throw new Error('Repaired queue did not finish')
      // Verify repairs are durable, rather than only modifying the returned snapshot.
      const reopened = indexedDB.open(name)
      const persisted = await new Promise(resolve => { reopened.onsuccess = () => resolve(reopened.result) })
      const read = persisted.transaction('activity').objectStore('activity').getAll()
      const rows = await new Promise(resolve => { read.onsuccess = () => resolve(read.result) })
      persisted.close()
      if (rows.length !== 5 || rows.some(({ id, ...event }) => !streak.validReviewEvent(id, event))) throw new Error('Repairs were not persisted')
      results.push(queue.clean)
    }
    locks.bindStudyDatabase({ uid: source.uid, dbName: source.dbName })
    await (await import('/src/streak-ui.ts')).refreshStreak()
    return results
  })
  assert.deepEqual(checks, [true, true, true])
  assert.equal(warnings.length, 3, 'unsupported stored zone is reported once per event, despite repeat reads/import')
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '🌙 0-day streak · 5/10 today')
  await page.close()
  console.log('streak-ui: preexisting raw zones repaired through read/load/save, persisted, exported/imported and queue acknowledged: ok')
}

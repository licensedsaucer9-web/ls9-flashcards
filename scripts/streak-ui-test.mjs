import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Shares the synthetic-auth browser harness; never accesses a real account. */
export async function testStreakUI(newPage) {
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
    await db.putCard({ ...card, article: 'der', tier: 1 })
    await db.putSettings({ sessionSize: 1, tier: 1, wordTypes: [] })
    window.streakCardId = card.id
    for (let i = 0; i < 9; i++) await db.saveReview(card.id, 'again', crypto.randomUUID(), Date.now(), 'UTC')
    await (await import('/src/streak-ui.ts')).refreshStreak()
  })
  await page.waitForFunction(() => document.querySelector('[data-streak-label]')?.textContent === '🌙 0-day streak · 9/10 today')
  await capture('off')
  await page.click('#start')
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
    const acknowledged = await db.acknowledgePending({ kind: 'activity', id, revision: pending[id].revision },
      { uid: lock.uid, generation: lock.generation })
    const mark = (await db.getSettings()).pending.activity[id]
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
      pending: Object.keys(pending).length, acknowledged, acked: mark.acked === mark.revision,
      otherCount, pulled: Object.keys(pulled).length, mergedCount,
    }
  })
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

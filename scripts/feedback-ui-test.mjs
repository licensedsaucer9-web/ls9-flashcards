// Settings → Send feedback: button → form → validation → submit, with the Firestore send scripted.
// The real write path and its rules are covered by feedback-emulator-test.mjs.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const cacheDir = mkdtempSync(join(tmpdir(), 'feedback-ui-'))
const base = 'http://127.0.0.1:4198'
let server, browser
try {
  process.env.BASE = '/'
  process.env.VITE_SYNC_BACKEND = ''
  server = await createServer({
    cacheDir,
    server: { host: '127.0.0.1', port: 4198, strictPort: true },
    plugins: [{
      name: 'scripted-feedback', enforce: 'pre',
      load(id) {
        if (!id.endsWith('/src/sync-backend.ts')) return null
        return `
          export const cloudTransport = false
          export async function cloudSyncPass() { return 'idle' }
          export async function sendFeedback(input) {
            (window.feedbackSent ||= []).push(input)
            if (window.feedbackHold) await window.feedbackHold
            return window.feedbackOutcome || { ok: true }
          }
        `
      },
    }],
  })
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()), headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  const errors = [], external = []
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') { external.push(url.href); return route.abort() }
    return route.continue()
  })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${base}/#/settings`)

  const open = page.getByRole('button', { name: 'Send feedback' })
  const form = page.locator('#feedback-form')
  const message = page.getByLabel('Message')
  const email = page.getByLabel('Email (optional)')
  const send = page.getByRole('button', { name: 'Send', exact: true })
  const count = page.locator('#feedback-count')
  const problem = page.locator('#feedback-problem')
  const status = page.locator('#feedback-status')

  // Closed until asked for; opening focuses the message and Send starts disabled.
  await open.waitFor()
  assert.equal(await form.isHidden(), true)
  await open.click()
  assert.equal(await form.isVisible(), true)
  assert.equal(await open.isHidden(), true)
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'feedback-message')
  assert.equal(await count.textContent(), '0 / 2000')
  assert.equal(await send.isDisabled(), true, 'empty message cannot be sent')
  assert.equal(await problem.textContent(), '', 'no complaint before typing')

  // Whitespace is empty; the counter follows the trimmed text; too long disables Send.
  await message.fill('   ')
  assert.equal(await send.isDisabled(), true, 'whitespace only cannot be sent')
  await message.fill('x'.repeat(2001))
  assert.equal(await count.textContent(), '2001 / 2000')
  assert.equal(await count.evaluate(el => el.classList.contains('is-over')), true)
  assert.equal(await send.isDisabled(), true, 'too long cannot be sent')
  assert.match(await problem.textContent(), /over 2000/)
  await message.fill('  Great app, more verbs please  ')
  assert.equal(await count.textContent(), '28 / 2000')
  assert.equal(await send.isDisabled(), false)

  // Email: optional, but a bad one blocks Send.
  await email.fill('not-an-email')
  assert.equal(await send.isDisabled(), true, 'malformed email cannot be sent')
  assert.match(await problem.textContent(), /valid email/)
  await email.fill(`${'e'.repeat(250)}@example.com`)
  assert.match(await problem.textContent(), /email is over 254/)
  await email.fill('me@example.com')
  assert.equal(await send.isDisabled(), false)

  // A failure keeps the text, says why, and leaves the form ready to retry.
  await page.evaluate(() => { window.feedbackOutcome = { ok: false, message: 'You are offline. Your message is kept here; send it when you are back online.' } })
  await send.click()
  await page.waitForFunction(() => /Not sent/.test(document.querySelector('#feedback-status')?.textContent ?? ''))
  assert.match(await status.textContent(), /offline/)
  assert.equal(await message.inputValue(), '  Great app, more verbs please  ')
  assert.equal(await email.inputValue(), 'me@example.com')
  assert.equal(await send.isDisabled(), false, 'retry is possible')

  // The draft survives leaving Settings and coming back.
  await page.goto(`${base}/#/`)
  await page.goto(`${base}/#/settings`)
  await form.waitFor()
  assert.equal(await message.inputValue(), '  Great app, more verbs please  ', 'draft kept across navigation')

  // Sending: controls lock while waiting, then the form closes, clears and thanks the user.
  await page.evaluate(() => {
    window.feedbackOutcome = { ok: true }
    window.feedbackHold = new Promise(resolve => { window.releaseFeedback = resolve })
  })
  await send.click()
  await page.getByRole('button', { name: 'Sending…' }).waitFor()
  assert.equal(await message.isDisabled(), true, 'message locked while sending')
  await page.evaluate(() => window.releaseFeedback())
  await page.waitForFunction(() => /Thanks/.test(document.querySelector('#feedback-status')?.textContent ?? ''))
  assert.equal(await form.isHidden(), true)
  assert.equal(await open.isVisible(), true)
  const sent = await page.evaluate(() => window.feedbackSent)
  assert.equal(sent.length, 2)
  assert.deepEqual(Object.keys(sent[1]).sort(), ['appVersion', 'email', 'message'])
  assert.equal(sent[1].message, '  Great app, more verbs please  ', 'the backend trims; the UI passes the draft')
  assert.equal(sent[1].appVersion, await page.locator('#app-version').getAttribute('data-version'))
  await open.click()
  assert.equal(await message.inputValue(), '', 'a sent draft is cleared')
  assert.equal(await email.inputValue(), '')
  assert.equal(await status.textContent(), '', 'reopening clears the old result')
  if (process.env.FEEDBACK_SCREENSHOTS) {
    await message.fill('The French deck is great.')
    await form.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/flashcards-feedback.png' })
  }

  // Cancel closes without sending.
  await page.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await form.isHidden(), true)
  assert.equal((await page.evaluate(() => window.feedbackSent)).length, 2)

  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log('feedback UI: button opens form, empty/long/bad-email blocked, failure keeps the draft, send locks then clears: ok')
} finally {
  if (browser) await browser.close()
  if (server) await server.close()
  rmSync(cacheDir, { recursive: true, force: true })
}

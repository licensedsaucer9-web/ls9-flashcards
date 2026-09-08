import { chromium } from 'playwright-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.APP_URL || 'http://127.0.0.1:4173/'
const CHROME = process.env.CHROME || '/usr/bin/chromium'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'de-cards-'))

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
})

const page = context.pages()[0] || (await context.newPage())
page.setDefaultTimeout(8000)

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-due-count]')
  const due0 = Number(await page.locator('[data-due-count]').innerText())
  assert(due0 >= 400, `seed due should be >= 400, got ${due0}`)
  console.log(`slice1: seeded ${due0} due cards`)

  await page.click('#start')
  await page.waitForSelector('#card')
  const article = (await page.locator('.face.front .article').innerText()).trim()
  assert(['der', 'die', 'das', 'verb', 'adj', 'word'].includes(article.toLowerCase()), `article ${article}`)
  const color = await page.locator('.face.front .article').evaluate((el) => getComputedStyle(el).color)
  if (article === 'der') assert(color.includes('78, 161, 255') || color.includes('4ea1ff'), `der color ${color}`)
  if (article === 'die') assert(color.includes('255, 107, 138') || color.includes('ff6b8a'), `die color ${color}`)
  if (article === 'das') assert(color.includes('61, 214, 140') || color.includes('3dd68c'), `das color ${color}`)
  await page.click('#card')
  await page.waitForSelector('.grades:not([hidden])')
  await page.click('[data-grade="good"]')
  await page.waitForTimeout(200)
  await page.click('#back')
  await page.waitForSelector('[data-due-count]')
  const due1 = Number(await page.locator('[data-due-count]').innerText())
  assert(due1 === due0 - 1, `after Good, due should be ${due0 - 1}, got ${due1}`)
  console.log(`slice1: review + Good grade updates due to ${due1}`)

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('[data-due-count]')
  const due2 = Number(await page.locator('[data-due-count]').innerText())
  assert(due2 === due1, `after reload, due should stay ${due1}, got ${due2}`)
  console.log('slice2: due count persists after reload')

  await page.click('#start')
  await page.waitForSelector('#card')
  await page.click('#card')
  await page.waitForSelector('.grades:not([hidden])')
  await page.click('[data-grade="again"]')
  await page.waitForTimeout(150)
  await page.click('#back')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('[data-due-count]')
  const due3 = Number(await page.locator('[data-due-count]').innerText())
  assert(due3 === due2, `Again should keep card due (${due2}), got ${due3}`)
  console.log('slice2: Again stays due after reload')

  await page.goto(BASE + '#/card/new', { waitUntil: 'networkidle' })
  await page.waitForSelector('form#form')
  await page.fill('input[name="de"]', 'Hundewetter')
  await page.fill('input[name="en"]', 'awful weather')
  await page.selectOption('select[name="article"]', 'das')
  await page.fill('textarea[name="example_de"]', 'Was für ein Hundewetter!')
  await page.click('button[type="submit"]')
  await page.waitForSelector('.card-list')
  const added = await page.locator('.card-list').innerText()
  assert(added.includes('Hundewetter'), 'new card in deck')
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-due-count]')
  const due4 = Number(await page.locator('[data-due-count]').innerText())
  assert(due4 === due3 + 1, `new card is due, expected ${due3 + 1}, got ${due4}`)
  console.log(`slice3: add card works, due is ${due4}`)

  await page.goto(BASE + '#/import', { waitUntil: 'networkidle' })
  await page.waitForSelector('#paste')
  await page.fill(
    '#paste',
    'de,en,article,example_de\nQuark,curd cheese,der,Der Quark ist frisch.\nQuittung,receipt,die,Die Quittung bitte.\nLabyrinth,labyrinth,das,Das Labyrinth ist groß.\nflüstern,to whisper,none,Bitte flüstern.\n',
  )
  await page.click('#run')
  await page.waitForFunction(() => /Imported 4/.test(document.getElementById('toast')?.textContent || ''))
  const toast = await page.locator('#toast').innerText()
  assert(/Imported 4/.test(toast), `import toast: ${toast}`)
  await page.goto(BASE + '#/deck', { waitUntil: 'networkidle' })
  await page.waitForSelector('.card-list')
  const deck = await page.locator('.card-list').innerText()
  assert(deck.includes('Quark') && deck.includes('flüstern'), 'imported cards in deck')
  await page.goto(BASE + '#/import', { waitUntil: 'networkidle' })
  await page.fill(
    '#paste',
    'de,en,article,example_de\nBahnhof,train station,der,Der Bahnhof ist nah.\n',
  )
  await page.click('#run')
  await page.waitForFunction(() => /Imported 0/.test(document.getElementById('toast')?.textContent || ''))
  const toast2 = await page.locator('#toast').innerText()
  assert(/Imported 0/.test(toast2) && /skipped/.test(toast2), `dup import: ${toast2}`)
  console.log('slice3: CSV import + duplicate skip')

  await page.goto(BASE + '#/settings', { waitUntil: 'networkidle' })
  await page.click('[data-dir="en-de"]')
  await page.waitForFunction(() => /EN → DE/.test(document.getElementById('toast')?.textContent || ''))
  await page.waitForSelector('[data-dir="en-de"].is-on')
  await page.goto(BASE + '#/review', { waitUntil: 'networkidle' })
  await page.waitForSelector('#card')
  const prompt = await page.locator('.face.front .prompt').innerText()
  assert(prompt.includes('English'), `EN→DE front prompt: ${prompt}`)
  console.log('slice4: reverse direction EN→DE')

  await page.goto(BASE + '#/settings', { waitUntil: 'networkidle' })
  await page.click('[data-dir="de-en"]')

  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { ready: false }
    const reg = await navigator.serviceWorker.ready
    return { ready: Boolean(reg.active), scope: reg.scope }
  })
  assert(sw.ready, `service worker not ready: ${JSON.stringify(sw)}`)
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]')
    if (!link) return null
    const res = await fetch(link.href)
    return res.json()
  })
  assert(manifest?.name, 'manifest missing')
  assert(manifest.display === 'standalone', `display ${manifest.display}`)
  const icons = (manifest.icons || []).map((i) => i.sizes)
  assert(icons.some((s) => s.includes('192')), 'missing 192 icon')
  assert(icons.some((s) => s.includes('512')), 'missing 512 icon')
  console.log('slice4: SW + manifest present')

  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-session="10"]')
  await page.click('[data-session="10"]')
  await page.waitForFunction(() => document.querySelector('#start')?.getAttribute('data-session-count') === '10')
  await page.click('#start')
  await page.waitForSelector('[data-remaining]')
  const remaining = (await page.locator('[data-remaining]').innerText()).trim()
  assert(remaining === '10', `session size 10, remaining ${remaining}`)
  await page.click('#back')
  console.log('session: 10-card cap works')

  await page.goto(BASE + '#/settings', { waitUntil: 'networkidle' })
  await page.waitForSelector('#gh-form')
  assert(await page.locator('#gh-form').count(), 'github form missing')
  console.log('settings: GitHub sync form present')

  console.log('verify.mjs: ok')
} finally {
  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
}

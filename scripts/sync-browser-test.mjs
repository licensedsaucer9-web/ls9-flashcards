// End-to-end sync coverage in a real browser. The repo mock now holds two kinds
// of file: the shared deck and one progress file per profile.
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'

const base = 'http://127.0.0.1:4174/'
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], {
  stdio: 'ignore',
})

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite did not start')
}

const config = {
  token: 'github_pat_test', owner: 'test', repo: 'data', path: 'data.json', branch: 'main',
}
const DECK = 'data.json'
/** A disposable card this test adds by hand. It is named like a built-in id on purpose. */
const OWN_CARD_ID = 'seed-515'
const userFile = (slug) => `users/${slug}.json`

// path -> { content, sha }
const repo = {
  files: new Map(),
  writes: 0,
  bodies: [],
  fail: false,
  failPutOnce: false,
  conflict: false,
  holdNext: false,
  held: null,
  release: null,
}

const deck = () => repo.files.get(DECK)
const progress = (slug = 'joakim') => repo.files.get(userFile(slug))
const shaOf = (path) => repo.files.get(path)?.sha

function pathOf(url) {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '')
}

async function mockGithub(route) {
  const request = route.request()
  const reply = (status, body = {}) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (repo.fail) return reply(503, { message: 'offline' })
  const path = pathOf(request.url())

  if (request.method() === 'GET') {
    // The users/ directory listing, used to discover other profiles.
    if (path === 'users') {
      const names = [...repo.files.keys()]
        .filter((p) => p.startsWith('users/'))
        .map((p) => ({ name: p.slice('users/'.length), type: 'file', path: p }))
      return reply(200, names)
    }
    const file = repo.files.get(path)
    if (!file) return reply(404)
    return reply(200, {
      sha: file.sha,
      content: Buffer.from(`${JSON.stringify(file.content)}\n`).toString('base64'),
    })
  }

  assert.equal(request.method(), 'PUT')
  repo.writes += 1
  const body = JSON.parse(request.postData())
  repo.bodies.push({ path, size: request.postData().length })

  if (repo.failPutOnce) {
    repo.failPutOnce = false
    return reply(503, { message: 'temporary failure' })
  }
  if (repo.holdNext) {
    repo.holdNext = false
    repo.held?.()
    await new Promise((resolve) => { repo.release = resolve })
  }
  if (repo.conflict) {
    repo.conflict = false
    // The other device graded a card in its own progress file. It has to be a card
    // this deck actually has, because progress for an unknown card is ignored.
    const other = progress()
    if (other) {
      other.content.progress['seed-20'] = { ease: 2.5, interval: 3, reps: 77, due: Date.now() + 5000, updated_at: Date.now() + 100 }
      other.content.updated_at = Date.now() + 100
      other.sha = `sha-${repo.writes}-other`
    }
    return reply(409, { message: 'conflict' })
  }
  if (body.sha && body.sha !== repo.files.get(path)?.sha) return reply(409, { message: 'stale sha' })
  const next = { content: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), sha: `sha-${repo.writes}` }
  repo.files.set(path, next)
  return reply(200, { content: { sha: next.sha } })
}

async function configure(page, extra = {}) {
  await page.evaluate(([cfg, x]) => {
    localStorage.setItem('german-flashcards.github', JSON.stringify(cfg))
    for (const [k, v] of Object.entries(x)) localStorage.setItem(k, v)
  }, [config, extra])
}

/** Change a card's schedule, the way a review does, without touching its content. */
async function gradeCard(page, id, reps) {
  await page.evaluate(async ({ id, reps }) => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    const card = await db.getCard(id)
    card.srs = { ...card.srs, reps, updated_at: Date.now() }
    await db.putCard(card)
    sync.schedulePush()
  }, { id, reps })
}

async function cardContentEdit(page, id, de) {
  await page.evaluate(async ({ id, de }) => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    const card = await db.getCard(id)
    card.de = de
    card.updated_at = Date.now()
    await db.putCard(card)
    sync.schedulePush()
  }, { id, de })
}

async function state(page) {
  return page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    return {
      settings: await db.getSettings(),
      status: sync.getSyncStatus(),
      cards: await db.getAllCards(),
    }
  })
}

const repsOn = (card) => card?.srs?.reps
const reps = (srs) => srs?.reps

async function sync(page) {
  return page.evaluate(async () => (await import('/src/sync.ts')).syncNow())
}

async function settle(page, check, what) {
  for (let i = 0; i < 120; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const { settings, status } = await state(page)
  throw new Error(
    `timed out waiting for ${what}\n  sync status: ${JSON.stringify(status)}` +
    `\n  revisions: ${settings.localRevision}/${settings.acknowledgedRevision}` +
    `\n  remote seed-08: ${JSON.stringify(progress()?.content?.progress?.['seed-08'])}` +
    `\n  files: ${[...repo.files.keys()].join(', ')}`,
  )
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch({
    executablePath: process.env.CHROME || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('https://api.github.com/**', mockGithub)
  const page = await context.newPage()
  await page.goto(base)
  await page.waitForSelector('[data-due-count]')
  await configure(page)
  await sync(page)

  // --- the first sync writes a shared deck and one progress file ---
  assert(deck(), 'the deck file was created')
  assert(progress(), 'the profile progress file was created')
  assert(deck().content.version === 2 && deck().content.kind === 'deck', 'the deck file is a v2 deck')
  assert(progress().content.version === 2 && progress().content.kind === 'user', 'the progress file is a v2 user file')
  assert.equal(progress().content.user, 'joakim', 'the default profile owns the progress file')
  assert(deck().content.cards.length >= 400, `deck holds the seed, got ${deck().content.cards.length}`)
  assert(repo.bodies[0].size > 64 * 1024, 'the fixture must exceed the keepalive limit')
  assert(deck().content.cards.every((c) => c.srs === undefined), 'no scheduling state leaks into the deck file')
  assert(Object.keys(progress().content.progress).length >= 400, 'progress covers the deck')

  const cleanWrites = repo.writes
  await sync(page)
  assert.equal(repo.writes, cleanWrites, 'a clean pull must not make a new commit')

  // --- a review moves only the profile file, never the shared deck ---
  const deckShaBefore = shaOf(DECK)
  const deckBefore = JSON.stringify(deck().content)
  await gradeCard(page, 'seed-08', 2)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await new Promise((resolve) => setTimeout(resolve, 1350))
  assert.equal(repo.writes, cleanWrites, 'hiding must cancel the pending upload')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await settle(page, () => reps(progress().content.progress['seed-08']) === 2, 'the grade to reach the profile file')
  assert.equal(shaOf(DECK), deckShaBefore, 'a review must not rewrite the shared deck file')
  assert.equal(JSON.stringify(deck().content), deckBefore, 'the deck file is byte-identical after a review')

  // --- a vocabulary edit moves only the deck file ---
  const userShaBefore = shaOf(userFile('joakim'))
  await cardContentEdit(page, 'seed-06', 'Buch (edited)')
  await sync(page)
  assert.equal(deck().content.cards.find((c) => c.id === 'seed-06').de, 'Buch (edited)', 'the edit reached the deck file')
  assert.equal(shaOf(userFile('joakim')), userShaBefore, 'a vocabulary edit must not rewrite the progress file')
  await cardContentEdit(page, 'seed-06', 'Buch')
  await sync(page)

  // --- a failed upload stays pending and is retried in the foreground ---
  await gradeCard(page, 'seed-06', 3)
  repo.failPutOnce = true
  await page.evaluate(async () => {
    try { await (await import('/src/sync.ts')).syncNow() } catch { /* failed PUT */ }
  })
  assert((await state(page)).settings.localRevision > (await state(page)).settings.acknowledgedRevision)
  await sync(page)
  assert.equal(reps(progress().content.progress['seed-06']), 3, 'the retry uploaded the pending grade')

  // --- offline: the edit survives pagehide and a reload, then backs up ---
  await gradeCard(page, 'seed-01', 9)
  repo.fail = true
  await page.evaluate(async () => {
    try { await (await import('/src/sync.ts')).syncNow() } catch { /* offline */ }
  })
  const beforeHide = repo.writes
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  assert.equal(repo.writes, beforeHide, 'pagehide must not send a PUT')
  assert((await state(page)).settings.localRevision > (await state(page)).settings.acknowledgedRevision)
  await page.reload()
  await page.waitForSelector('[data-due-count]')
  repo.fail = false
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  let backedUp = false
  for (let i = 0; i < 120; i++) {
    const { settings } = await state(page)
    if (settings.localRevision === settings.acknowledgedRevision) {
      backedUp = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert(backedUp, 'the foreground retry did not acknowledge the pending grade')
  assert.equal(reps(progress().content.progress['seed-01']), 9)

  // --- an edit made while the PUT is in flight needs a second acknowledgment ---
  await gradeCard(page, 'seed-02', 4)
  const held = new Promise((resolve) => { repo.held = resolve })
  repo.holdNext = true
  await page.evaluate(() => {
    window.pendingSyncTest = import('/src/sync.ts').then((s) => s.syncNow())
  })
  await held
  await gradeCard(page, 'seed-03', 7)
  repo.release()
  await page.evaluate(() => window.pendingSyncTest)
  assert.equal(reps(progress().content.progress['seed-02']), 4)
  assert.equal(reps(progress().content.progress['seed-03']), 7, 'the in-flight edit is not lost')
  assert.equal((await state(page)).settings.localRevision, (await state(page)).settings.acknowledgedRevision)

  // --- a conflict re-fetches the other device's progress before writing ---
  await gradeCard(page, 'seed-04', 5)
  repo.conflict = true
  await sync(page)
  assert.equal(reps(progress().content.progress['seed-04']), 5, 'the local grade survived the conflict')
  assert(reps(progress().content.progress['seed-20']) === 77, "the other device's progress was merged in")
  assert.equal(
    repsOn((await state(page)).cards.find((c) => c.id === 'seed-20')),
    77,
    "the other device's grade reached this device too",
  )

  // --- a deletion and a setting change survive reseeding and reach a new device ---
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    await db.deleteCard('seed-05')
    await db.putSettings({ direction: 'en-de' })
    sync.schedulePush()
    await sync.syncNow()
  })
  await page.reload()
  await page.waitForSelector('[data-due-count]')
  assert.equal(await page.evaluate(async () => (await import('/src/db.ts')).getCard('seed-05')), undefined)
  assert(deck().content.deleted_ids['seed-05'], 'the tombstone is in the shared deck file')
  assert.equal(progress().content.settings.direction, 'en-de', 'the direction is in the profile file')
  assert(progress().content.progress['seed-05'] === undefined, 'a deleted card drops out of the progress file')

  // --- a second browser picks up the same profile ---
  const other = await browser.newContext({ serviceWorkers: 'block' })
  await other.route('https://api.github.com/**', mockGithub)
  await other.addInitScript((cfg) => localStorage.setItem('german-flashcards.github', JSON.stringify(cfg)), config)
  const second = await other.newPage()
  await second.goto(base)
  await second.waitForSelector('[data-due-count]')
  assert.equal(await second.evaluate(async () => (await import('/src/db.ts')).getCard('seed-05')), undefined)
  assert.equal((await state(second)).settings.direction, 'en-de')
  assert.equal(repsOn((await state(second)).cards.find((c) => c.id === 'seed-01')), 9)

  // --- reseeding adds only genuinely new cards ---
  const seeded = await page.evaluate(async (ownId) => {
    const db = await import('/src/db.ts')
    const seed = (await import('/src/seed.ts')).seedCards()
    const fresh = { ...seed[0], id: ownId, de: 'Zusatzwort', tier: 3 }
    const first = await db.insertMissingSeeds([seed[4], fresh])
    const second = await db.insertMissingSeeds([fresh])
    return { first, second, deleted: await db.getCard('seed-05'), reviewed: await db.getCard('seed-01') }
  }, OWN_CARD_ID)
  assert.equal(seeded.first, 1)
  assert.equal(seeded.second, 0)
  assert.equal(seeded.deleted, undefined, 'a tombstoned seed is not re-added')
  assert.equal(seeded.reviewed.srs.reps, 9, 'reseeding does not reset progress')

  // --- tiers: the choice is per profile and travels in the profile file ---
  const tiers = await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { tierCounts: count, tierOf } = await import('/src/tiers.ts')
    const { seedCards } = await import('/src/seed.ts')
    const cards = await db.getAllCards()
    const deleted = (await db.getSettings()).deletedIds
    // A seed deleted earlier in this run is legitimately missing, so the expected
    // tier 1 size is 100 minus whichever tier 1 seeds were tombstoned.
    const goneTier1 = seedCards().filter((c) => deleted[c.id] && tierOf(c) === 1).length
    return {
      counts: count(cards),
      goneTier1,
      due1: (await db.getDueCards(1)).length,
      due2: (await db.getDueCards(2)).length,
      due3: (await db.getDueCards(3)).length,
    }
  })
  assert.equal(tiers.counts[1], 100 - tiers.goneTier1, 'tier 1 holds its 100 words, less any deleted')
  assert(tiers.counts[1] + tiers.counts[2] === 250 - tiers.goneTier1, 'tiers 1-2 are cumulative')
  assert(tiers.due1 <= tiers.due2 && tiers.due2 <= tiers.due3, 'a higher tier is never a smaller queue')

  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    const sync = await import('/src/sync.ts')
    await db.putSettings({ tier: 2 })
    sync.schedulePush()
    await sync.syncNow()
  })
  assert.equal(progress().content.settings.tier, 2, 'the tier choice is in the profile file')
  assert.equal((await state(page)).settings.tier, 2)

  // --- a second profile on the same device is fully separate ---
  const beforeSecond = repo.writes
  await page.evaluate(async () => {
    const { createUser } = await import('/src/user.ts')
    createUser('Anna')
  })
  await page.reload()
  await page.waitForSelector('[data-due-count]')
  await sync(page)
  assert(progress('anna'), 'the new profile got its own remote file')
  assert.equal(progress('anna').content.user, 'anna')
  const annaCard = (await state(page)).cards.find((c) => c.id === 'seed-01')
  assert.equal(repsOn(annaCard), 0, "a new profile starts unscheduled, not on someone else's progress")
  assert.equal((await state(page)).settings.direction, 'de-en', 'a new profile starts on the default direction')
  assert.equal((await state(page)).settings.tier, 1, 'a new profile starts on tier 1')
  assert.equal(reps(progress().content.progress['seed-01']), 9, "Anna's sync did not disturb Joakim's file")
  assert(repo.writes > beforeSecond, "Anna's file was actually written")

  // Anna reviews her own copy; Joakim's progress must not move.
  await gradeCard(page, 'seed-01', 5)
  await sync(page)
  assert.equal(reps(progress('anna').content.progress['seed-01']), 5, "Anna's grade landed in her file")
  assert.equal(reps(progress().content.progress['seed-01']), 9, "Joakim's progress is untouched")
  const annaCardAfter = (await state(page)).cards.find((c) => c.id === 'seed-01')
  assert.equal(repsOn(annaCardAfter), 5, "Anna's own database holds her grade")

  // Switching back restores Joakim's schedule, not Anna's.
  await page.evaluate(async () => {
    const { setActiveUser } = await import('/src/user.ts')
    setActiveUser('joakim')
  })
  await page.reload()
  await page.waitForSelector('[data-due-count]')
  await sync(page)
  assert.equal(repsOn((await state(page)).cards.find((c) => c.id === 'seed-01')), 9, 'switching back restores Joakim')
  assert.equal((await state(page)).settings.direction, 'en-de')
  assert.equal((await state(page)).settings.tier, 2)

  // --- a new browser can discover and switch to another profile ---
  const third = await browser.newContext({ serviceWorkers: 'block' })
  await third.route('https://api.github.com/**', mockGithub)
  await third.addInitScript((cfg) => localStorage.setItem('german-flashcards.github', JSON.stringify(cfg)), config)
  const discovered = await third.newPage()
  await discovered.goto(`${base}#/settings`)
  await discovered.waitForSelector('#user-list')
  await discovered.evaluate(async () => (await import('/src/sync.ts')).discoverRemoteUsers())
  const users = await discovered.evaluate(async () => (await import('/src/user.ts')).listUsers().map((u) => u.slug))
  assert(users.includes('joakim') && users.includes('anna'), `both profiles discovered, got ${users.join(',')}`)

  // --- upgrade a v1 data.json: the deck and the schedule are split apart ---
  const legacyProgressReps = 11
  const legacySnapshot = {
    version: 1,
    updated_at: Date.now() - 60_000,
    settings: { direction: 'de-en', sessionSize: 20 },
    // A real pre-upgrade data.json predates tiers, so it has no rank or tier at all.
    // Leaving them on would hide the repair this upgrade depends on.
    cards: deck().content.cards.map((c, i) => {
      const { rank, tier, ...content } = c
      return {
        ...content,
        created_at: 1,
        updated_at: 1,
        srs: i === 0 ? { ease: 2.5, interval: 3, reps: legacyProgressReps, due: Date.now() } : { ease: 2.5, interval: 0, reps: 0, due: Date.now() },
      }
    }),
    deleted_ids: {},
  }
  repo.files.delete(userFile('joakim'))
  repo.files.set(DECK, { content: legacySnapshot, sha: 'sha-v1' })

  const upgrading = await browser.newContext({ serviceWorkers: 'block' })
  await upgrading.route('https://api.github.com/**', mockGithub)
  await upgrading.addInitScript(
    ([cfg, usersJson]) => {
      localStorage.setItem('german-flashcards.github', JSON.stringify(cfg))
      localStorage.setItem('german-flashcards.users', usersJson)
      localStorage.setItem('german-flashcards.user', 'joakim')
    },
    [config, JSON.stringify([{ slug: 'joakim', name: 'Joakim', createdAt: 1 }])],
  )
  const legacyPage = await upgrading.newPage()
  await legacyPage.goto(base)
  await legacyPage.waitForSelector('[data-due-count]')
  await sync(legacyPage)
  assert.equal(deck().content.version, 2, 'the v1 snapshot was rewritten as a v2 deck')
  assert.equal(deck().content.kind, 'deck')
  assert(deck().content.cards.every((c) => c.srs === undefined), 'no scheduling state in the rewritten deck')
  assert(progress('joakim'), 'the v1 schedule was claimed by a profile file')
  assert.equal(reps(progress('joakim').content.progress[deck().content.cards[0].id]), legacyProgressReps, 'the old schedule was kept')
  assert.equal(repsOn((await state(legacyPage)).cards.find((c) => c.id === deck().content.cards[0].id)), legacyProgressReps, 'and applied to the device')
  // A card the user added has no rank by design. The disposable card this test added is
  // the only one allowed to lack one, and it is named seed-515 so it collides with the
  // built-in id prefix on purpose.
  const withoutRank = deck().content.cards.filter((c) => c.rank === undefined).map((c) => c.id)
  assert.deepEqual(withoutRank, [OWN_CARD_ID], 'every built-in card regained its rank and tier from the seed')

  // The migration must settle: a second sync writes nothing.
  const settledWrites = repo.writes
  await sync(legacyPage)
  assert.equal(repo.writes, settledWrites, 'the migration converges instead of rewriting every pass')

  // --- a migrated card must regain the tier data it never had ---
  // A v1 snapshot carries no rank or tier. Without a repair every existing user's deck
  // would land entirely in tier 3, leaving tier 1 empty.
  const tierRepair = await browser.newContext({ serviceWorkers: 'block' })
  await tierRepair.route('https://api.github.com/**', mockGithub)
  await tierRepair.addInitScript(() => {
    localStorage.setItem('german-flashcards.users', JSON.stringify([{ slug: 'joakim', name: 'Joakim', createdAt: 1 }]))
    localStorage.setItem('german-flashcards.user', 'joakim')
  })
  const repaired = await tierRepair.newPage()
  await repaired.goto(base)
  await repaired.waitForSelector('[data-due-count]')
  const afterRepair = await repaired.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { tierOf } = await import('/src/tiers.ts')
    const { seedCards } = await import('/src/seed.ts')
    const byId = new Map((await db.getAllCards()).map((c) => [c.id, c]))
    const seed = seedCards(0)
    const builtIn = new Set(seed.map((c) => c.id))
    const counts = { 1: 0, 2: 0, 3: 0 }
    for (const card of await db.getAllCards()) {
      if (builtIn.has(card.id)) counts[tierOf(card)] += 1
    }
    return {
      counts,
      sample: seed.slice(0, 3).map((s) => {
        const card = byId.get(s.id)
        return { de: card.de, rank: card.rank, tier: card.tier, srsIntact: card.srs.reps === 0 }
      }),
      // A card the user added has no rank by design, so only the built-ins are checked.
      noRank: (await db.getAllCards()).filter((c) => builtIn.has(c.id) && (c.rank === undefined || c.tier === undefined)).length,
    }
  })
  assert.equal(afterRepair.noRank, 0, 'every built-in card has a rank and a tier after the repair')
  assert.equal(afterRepair.counts[1], 100, 'tier 1 is populated again for an existing user')
  assert.equal(afterRepair.counts[1] + afterRepair.counts[2], 250)
  assert.deepEqual(afterRepair.sample.map((s) => s.tier), [1, 1, 1])
  assert(afterRepair.sample.every((s) => typeof s.rank === 'number'), 'the researched rank came back')
  assert(afterRepair.sample.every((s) => s.srsIntact), 'the repair does not disturb review state')

  // A tier the user set by hand must survive the repair.
  const overrideKept = await repaired.evaluate(async () => {
    const db = await import('/src/db.ts')
    const { seedCards } = await import('/src/seed.ts')
    const rare = seedCards(0).find((c) => c.tier === 3)
    const card = await db.getCard(rare.id)
    await db.putCard({ ...card, tier: 1 })
    await db.insertMissingSeeds(seedCards(0))
    return (await db.getCard(rare.id)).tier
  })
  assert.equal(overrideKept, 1, 'a tier the user chose by hand is not overwritten by the seed')

  // --- upgrade a local legacy database into the default profile ---
  // The app seeds the profile database as it boots, so the legacy database has to
  // already be there. Hold the entry module back until the fixture is written.
  const localLegacy = await browser.newContext({ serviceWorkers: 'block' })
  await localLegacy.route('https://api.github.com/**', mockGithub)
  await localLegacy.addInitScript(() => {
    localStorage.setItem('german-flashcards.users', JSON.stringify([{ slug: 'joakim', name: 'Joakim', createdAt: 1 }]))
    localStorage.setItem('german-flashcards.user', 'joakim')
  })
  let releaseApp
  const appGate = new Promise((resolve) => { releaseApp = resolve })
  let holding = true
  // A predicate, because Vite serves the entry with an HMR query string.
  await localLegacy.route((url) => url.pathname.endsWith('/src/main.ts'), async (route) => {
    if (holding) await appGate
    await route.continue()
  })
  const legacyLocal = await localLegacy.newPage()
  await legacyLocal.goto(base, { waitUntil: 'commit' })
  // The document is parsed even though the module script is still held back.
  await legacyLocal.waitForSelector('#app', { state: 'attached' })
  const beforeBoot = await legacyLocal.evaluate(async () =>
    (await indexedDB.databases()).some((d) => d.name === 'german-flashcards:joakim'))
  assert.equal(beforeBoot, false, 'the profile database does not exist before the app boots')
  await legacyLocal.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('german-flashcards', 1)
      request.onupgradeneeded = () => {
        const d = request.result
        d.createObjectStore('cards', { keyPath: 'id' })
        d.createObjectStore('settings', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['cards', 'settings'], 'readwrite')
      tx.objectStore('cards').put({
        id: 'seed-01', de: 'Mann', en: 'man', article: 'der', example_de: '', example_en: '',
        tags: ['a1'], tier: 1, created_at: 1, updated_at: 1,
        srs: { ease: 2.5, interval: 4, reps: 7, due: Date.now(), updated_at: 1 },
      })
      // A pre-multi-user settings row: no revision clocks, no tier.
      tx.objectStore('settings').put({ id: 'settings', direction: 'en-de', sessionSize: 50, deletedIds: {} })
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  })
  holding = false
  releaseApp()
  await legacyLocal.waitForSelector('[data-due-count]')
  const imported = await legacyLocal.evaluate(async () => {
    const db = await import('/src/db.ts')
    return { card: await db.getCard('seed-01'), settings: await db.getSettings() }
  })
  assert(imported.card, 'the legacy card moved into the profile database')
  assert.equal(imported.card.srs.reps, 7, 'the legacy schedule was carried over')
  assert.equal(imported.settings.sessionSize, 50, 'legacy session size kept')
  assert.equal(imported.settings.direction, 'en-de', 'legacy direction kept')

  // --- an edit save must not overwrite fresher remote progress ---
  const editId = deck().content.cards[3].id
  await page.goto(`${base}#/card/${editId}`)
  await page.waitForSelector('#form')
  await page.evaluate(async (id) => {
    const db = await import('/src/db.ts')
    const card = await db.getCard(id)
    card.srs = { ...card.srs, reps: 42, updated_at: Date.now() + 5000 }
    card.updated_at = Date.now()
    await db.putCard(card)
  }, editId)
  await page.fill('input[name="de"]', 'Tür (edited)')
  await page.click('button.primary[type="submit"]')
  await page.waitForFunction(() => location.hash === '#/deck' || location.hash === '#/')
  const afterSrsEdit = await page.evaluate(async (id) => {
    const card = await (await import('/src/db.ts')).getCard(id)
    return card ? { de: card.de, reps: card.srs.reps } : null
  }, editId)
  assert(afterSrsEdit, 'the edited card still exists')
  assert.equal(afterSrsEdit.de, 'Tür (edited)')
  assert.equal(afterSrsEdit.reps, 42, 'an edit save must not overwrite fresher remote progress')

  // --- a deleted card must not come back through an edit save or a grade ---
  await page.goto(`${base}#/card/seed-10`)
  await page.waitForSelector('#form')
  await page.evaluate(async () => {
    const db = await import('/src/db.ts')
    // Deleted by a merge, not by this device: the tombstone arrives from elsewhere.
    await db.mergeDeckIntoDb({
      version: 2, kind: 'deck', updated_at: Date.now() + 2000,
      cards: (await db.getAllCards()).map((c) => ({ ...c, srs: undefined })),
      deleted_ids: { 'seed-10': Date.now() + 2000 },
    })
  })
  await page.fill('input[name="en"]', 'window (edited)')
  await page.click('button.primary[type="submit"]')
  await page.waitForFunction(() => location.hash === '#/deck' || location.hash === '#/')
  assert.equal(
    await page.evaluate(async () => (await import('/src/db.ts')).getCard('seed-10')),
    undefined,
    'an edit save must not resurrect a deleted card',
  )
  assert(
    await page.evaluate(async () => (await (await import('/src/db.ts')).getSettings()).deletedIds['seed-10']),
    'the tombstone survives the skipped edit save',
  )

  // --- grading a card that a merge deleted must not resurrect it ---
  await page.goto(`${base}#/review`)
  await page.waitForSelector('#card')
  const reviewFront = (await page.locator('.face.front .word').textContent()).trim()
  const gradedId = await page.evaluate(async (front) => {
    const db = await import('/src/db.ts')
    const settings = await db.getSettings()
    const cards = await db.getAllCards()
    if (settings.direction === 'en-de') return cards.find((card) => card.en === front)?.id
    return cards.find((card) => (card.article === 'none' ? card.de : `${card.article} ${card.de}`) === front)?.id
  }, reviewFront)
  assert(gradedId, `could not resolve the review card for front=${reviewFront}`)
  await page.evaluate(async (id) => {
    const db = await import('/src/db.ts')
    await db.mergeDeckIntoDb({
      version: 2, kind: 'deck', updated_at: Date.now() + 1000,
      cards: (await db.getAllCards()).map((c) => ({ ...c, srs: undefined })),
      deleted_ids: { [id]: Date.now() + 1000 },
    })
  }, gradedId)
  assert.equal(await page.evaluate(async (id) => (await import('/src/db.ts')).getCard(id), gradedId), undefined)
  await page.click('#card')
  await page.waitForSelector('[data-grade="good"]')
  await page.click('[data-grade="good"]')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(
    await page.evaluate(async (id) => (await import('/src/db.ts')).getCard(id), gradedId),
    undefined,
    'grading a deleted card must not resurrect it',
  )
  assert(
    await page.evaluate(async (id) => (await (await import('/src/db.ts')).getSettings()).deletedIds[id], gradedId),
    'the tombstone survives the skipped grade',
  )

  await upgrading.close()
  await tierRepair.close()
  await localLegacy.close()
  await third.close()
  await other.close()
  await context.close()
  console.log('sync-browser-test: split deck/user files, per-profile isolation, tier selection, offline reload, large payload, in-flight edit, conflict, v1 migration, legacy DB, grade/edit guards: ok')
} finally {
  if (browser) await browser.close()
  server.kill()
}

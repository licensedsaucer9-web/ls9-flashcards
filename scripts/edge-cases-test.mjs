// Edge-case tests for csv parsing, snapshot validation, merge ties, and settings.
const { importCsv } = await import('../src/csv.ts')
const {
  parseSnapshot,
  parseDeckFile,
  parseUserFile,
  parseRemoteDeck,
  emptyDeck,
  mergeDeck,
  mergeProgress,
  newerSettings,
  legacyToFiles,
} = await import('../src/merge.ts')
const { normalizeSettings } = await import('../src/db.ts')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const now = 1_700_000_000_000
const card = (id, de, en, extra = {}) => ({
  id, de, en, article: 'none', example_de: '', example_en: '',
  tags: [], created_at: now, updated_at: now, srs: { ease: 2.5, interval: 0, reps: 0, due: now },
  ...extra,
})
const content = (id, de, updatedAt) => ({
  id, de, en: de, article: 'none', example_de: '', example_en: '', tags: [],
  created_at: updatedAt, updated_at: updatedAt,
})
const srsAt = (t) => ({ ease: 2.5, interval: 1, reps: 1, due: t, updated_at: t })

// --- CSV parser edges ---

const quoted = `de,en,article,example_de
"Hut, der Zaun",fence,die,"Er sagte: ""hallo"""
`
const q = importCsv(quoted, [], now)
assert(q.imported.length === 1, `quoted comma field survives: ${JSON.stringify(q.imported)}`)
assert(q.imported[0].de === 'Hut, der Zaun', 'embedded comma kept')
assert(q.imported[0].example_de === 'Er sagte: "hallo"', 'doubled quotes unescape')

const crlf = 'Hund,dog,der\r\nKatze,cat,die\r\n'
const c = importCsv(crlf, [], now)
assert(c.imported.length === 2 && !c.errors.length, `CRLF rows parse: ${c.imported.length}`)
assert(c.imported[1].de === 'Katze', 'no trailing \\r in field')

const quotedNewline = `de,en,article,example_de
"Zeile
zwei",line,none,
`
const nl = importCsv(quotedNewline, [], now)
assert(nl.imported.length === 1, 'quoted newline stays one row')
assert(nl.imported[0].de.includes('Zeile'), 'newline inside field kept')

// article normalization
const art = importCsv('Vogel,bird,N/A\nFisch,fish,bogus\n', [], now)
assert(art.imported.length === 1 && art.imported[0].article === 'none', 'N/A means none')
assert(art.errors.length === 1 && art.errors[0].includes('article'), 'bogus article is an error')

// header detection: de-header and article-column variants both skip row 1
assert(importCsv('de,en,article,example_de\nA,a,none,', []).imported.length === 1, 'header skipped (de)')
assert(importCsv('word,translation,article\nA,a,none\n', []).imported.length === 1, 'article column header detected')

// empty line vanishes at parse level; a row of empty fields counts as skipped
const blank = importCsv('A,a,none,\n\n,,,\nB,b,none,\n', [], now)
assert(blank.imported.length === 2 && blank.skipped === 1 && !blank.errors.length, 'empty fields row skipped, empty line dropped')

assert(importCsv('', []).errors.length === 1, 'empty csv errors')

// case-insensitive duplicate keys
const dup = importCsv('Hund,dog,der\nhund,DOG,der\n', [], now)
assert(dup.imported.length === 1 && dup.skipped === 1, 'duplicate key is case-insensitive')

// --- parseSnapshot validation ---

assert(parseSnapshot(null) === null, 'null -> null')
assert(parseSnapshot('x') === null, 'string -> null')
assert(parseSnapshot({ version: 2, cards: [] }) === null, 'wrong version -> null')
assert(parseSnapshot({ version: 1 }) === null, 'missing cards -> null')

const good = parseSnapshot({ version: 1, updated_at: 'nope', settings: { direction: 'en-de', sessionSize: -5 }, cards: [], deleted_ids: 'x' })
assert(good !== null, 'structurally valid snapshot accepted')
assert(good.updated_at === 0, 'non-numeric updated_at -> 0')
assert(good.settings.direction === 'en-de', 'valid direction kept')
assert(good.settings.sessionSize === 0, 'negative sessionSize floors to 0')

const clamped = parseSnapshot({ version: 1, settings: { sessionSize: 7.9 }, cards: [] })
assert(clamped.settings.sessionSize === 7, 'fractional sessionSize floors')
const badDir = parseSnapshot({ version: 1, settings: { direction: 'fr' }, cards: [] })
assert(badDir.settings.direction === 'de-en', 'unknown direction -> de-en')

// --- parseDeckFile: a foreign or hostile file must not be able to inject progress ---

assert(parseDeckFile(null) === null, 'null deck -> null')
assert(parseDeckFile({ version: 1, cards: [] }) === null, 'v1 is not a v2 deck')
assert(parseDeckFile({ version: 2 }) === null, 'deck without cards -> null')
assert(parseDeckFile({ version: 2, cards: 'x' }) === null, 'non-array cards -> null')

const injected = parseDeckFile({
  version: 2,
  kind: 'deck',
  cards: [{ id: 'x', de: 'Haus', en: 'house', article: 'der', tags: [], created_at: 1, updated_at: 1, srs: { ease: 1.3, interval: 99, reps: 42, due: 7 } }],
})
assert(injected.cards[0].srs === undefined, 'an srs smuggled into a deck file is dropped')
assert(injected.cards[0].de === 'Haus', 'content fields survive')
assert(parseDeckFile({ version: 2, cards: [{ de: 'x' }, { id: '' }, { id: 'ok' }] }).cards.length === 1, 'idless cards skipped')

// --- parseUserFile ---

assert(parseUserFile({ version: 2, kind: 'deck', progress: {} }) === null, 'a deck file is not a user file')
assert(parseUserFile({ version: 2, kind: 'user' }) === null, 'user file without progress -> null')
const u = parseUserFile({ version: 2, kind: 'user', user: 'anna', updated_at: 5, settings: { direction: 'en-de', sessionSize: 7, tier: 2 }, progress: { a: srsAt(1) } })
assert(u.user === 'anna', 'user slug read')
assert(u.settings.tier === 2, 'tier read')
assert(parseUserFile({ version: 2, kind: 'user', progress: {}, settings: { tier: 9 } }).settings.tier === 1, 'bad tier -> 1')
assert(parseUserFile({ version: 2, kind: 'user', progress: {}, settings: { tier: 'x' } }).settings.tier === 1, 'non-numeric tier -> 1')
assert(parseUserFile({ version: 2, kind: 'user', progress: {} }).settings.direction === 'de-en', 'missing direction -> de-en')

// --- parseRemoteDeck routes v1 down the migration path ---

assert(parseRemoteDeck({ version: 1, cards: [] }).kind === 'legacy', 'v1 routes to legacy')
assert(parseRemoteDeck({ version: 2, kind: 'deck', cards: [] }).kind === 'deck', 'v2 routes to deck')
assert(parseRemoteDeck({ version: 3, cards: [] }) === null, 'unknown version -> null')

// legacyToFiles splits the one snapshot into the two files that replace it
const legacy = {
  version: 1,
  updated_at: now + 50,
  settings: { direction: 'en-de', sessionSize: 30 },
  cards: [card('a', 'alt', 'old', { updated_at: now, srs: srsAt(now + 7) }), card('seed-02', 'Frau', 'woman')],
  deleted_ids: { gone: now + 5 },
}
const split = legacyToFiles(legacy, 'joakim')
assert(split.deck.cards.length === 2, 'every card moves to the deck file')
assert(split.deck.cards.every((c) => c.srs === undefined), 'no scheduling state in the deck file')
assert(split.user.progress.a.updated_at === now + 7, 'progress moves to the user file')
assert(split.user.settings.direction === 'en-de' && split.user.settings.sessionSize === 30, 'settings carried over')
assert(split.user.settings.tier === 1, 'a migrated profile starts on tier 1')
assert(split.deck.deleted_ids.gone === now + 5, 'tombstones move to the deck file')
assert(split.user.user === 'joakim', 'progress is credited to the opening profile')
// A v1 snapshot had one clock for everything; without carrying it over, a second
// device would see no settings opinion and its own defaults would win.
assert(split.user.settings_updated_at === now + 50, 'the v1 clock becomes the settings clock')
const v1NoClock = legacyToFiles({ ...legacy, settings_updated_at: undefined, updated_at: 42 }, 'joakim')
assert(v1NoClock.user.settings_updated_at === 42, 'a missing v1 settings clock falls back to updated_at')

// --- mergeDeck ties and deletions ---

// identical updated_at: local wins (remote merged first, later >= replaces)
const sR = emptyDeck(now); sR.cards = [content('t', 'alt', now)]
const sL = emptyDeck(now); sL.cards = [content('t', 'neu', now)]
assert(mergeDeck(sL, sR).cards[0].de === 'neu', 'tie on touched: local wins')

// deletion exactly equal to touch time drops the card (del >= touched)
const dL = emptyDeck(now)
dL.cards = [content('d', 'x', now + 10)]
dL.deleted_ids = { d: now + 10 }
assert(!mergeDeck(dL, emptyDeck(now)).cards.some((c) => c.id === 'd'), 'delete at touch time drops')

// deletion older than the card edit keeps the (edited) card
const eL = emptyDeck(now)
eL.cards = [content('e', 'keep', now + 20)]
eL.deleted_ids = { e: now + 10 }
assert(mergeDeck(eL, emptyDeck(now)).cards.length === 1, 'newer edit beats older delete')
const deletedSeed = emptyDeck(now)
deletedSeed.deleted_ids = { 'seed-01': now }
const laterSeed = emptyDeck(now)
laterSeed.cards = [content('seed-01', 'Mann', now + 50)]
assert(mergeDeck(deletedSeed, laterSeed).cards.length === 0, 'offline seed edit cannot revive a deleted built-in card')

// deleted_ids take the max timestamp across deck files
const del1 = emptyDeck(now); del1.deleted_ids = { z: 100 }
const del2 = emptyDeck(now); del2.deleted_ids = { z: 500 }
assert(mergeDeck(del1, del2).deleted_ids.z === 500, 'deleted_ids max wins')

// cards without ids are ignored
const noId = emptyDeck(now)
noId.cards = [content('ok', 'a', now), { de: 'x' }]
assert(mergeDeck(noId, emptyDeck(now)).cards.length === 1, 'idless card skipped')

// --- mergeProgress: two profiles on one card ---

const mine = { t: srsAt(now + 10) }
const theirs = { t: srsAt(now + 20) }
assert(mergeProgress(mine, theirs).t.updated_at === now + 20, 'newer remote schedule wins')
assert(mergeProgress(theirs, mine).t.updated_at === now + 20, 'newer local schedule wins')
assert(mergeProgress({}, theirs).t.updated_at === now + 20, 'remote-only schedule is adopted')
assert(Object.keys(mergeProgress(mine, {})).length === 1, 'local-only schedule is kept')
// A schedule with no clock (written before per-user progress) never beats a real one.
assert(mergeProgress({ t: srsAt(now + 20) }, { t: { ease: 2.5, interval: 0, reps: 0, due: now } }).t.updated_at === now + 20, 'clockless remote loses to a real clock')
assert(mergeProgress({ t: { ease: 2.5, interval: 0, reps: 0, due: now } }, {}).t !== undefined, 'clockless local is not dropped')
assert(mergeProgress({}, { t: null }).t === undefined, 'null schedule is ignored')

// --- normalizeSettings ---

assert(normalizeSettings().sessionSize === 20, 'defaults: sessionSize 20')
assert(normalizeSettings(null).direction === 'de-en', 'defaults: direction')
assert(normalizeSettings({ sessionSize: 'x' }).sessionSize === 20, 'bad sessionSize -> 20')
assert(normalizeSettings({ sessionSize: 3.7 }).sessionSize === 3, 'sessionSize floors')
assert(normalizeSettings({ direction: 'en-de' }).direction === 'en-de', 'direction kept')
assert(normalizeSettings({ deletedIds: { a: 1 } }).deletedIds.a === 1, 'deletedIds kept')
assert(normalizeSettings({ deletedIds: 'x' }).deletedIds !== 'x', 'bad deletedIds replaced')
// input object is not mutated
const input = { deletedIds: { a: 1 } }
normalizeSettings(input)
assert(!('id' in input), 'input not mutated by normalize')
assert(normalizeSettings(input).deletedIds !== input.deletedIds, 'deletedIds is a copy')

// tier defaults to 1 so a migrated profile starts small rather than on all 514 words
assert(normalizeSettings().tier === 1, 'defaults: tier 1')
assert(normalizeSettings({ tier: 3 }).tier === 3, 'tier 3 kept')
assert(normalizeSettings({ tier: 2 }).tier === 2, 'tier 2 kept')
assert(normalizeSettings({ tier: 0 }).tier === 1, 'tier 0 -> 1')
assert(normalizeSettings({ tier: 'x' }).tier === 1, 'non-numeric tier -> 1')


// --- settings merge: a 0 clock means "never set here", not epoch ---

const de = { direction: 'de-en', sessionSize: 20, tier: 1 }
const en = { direction: 'en-de', sessionSize: 50, tier: 3 }
// A device that has never written settings has no opinion, so a real remote clock wins.
assert(newerSettings(en, 0, de, now).direction === 'de-en', 'a 0 local clock yields to a real remote clock')
// A remote file with no settings clock cannot beat what this device already decided.
assert(newerSettings(en, now, de, 0).direction === 'en-de', 'a 0 remote clock yields to a real local clock')
assert(newerSettings(de, now, en, now + 1).direction === 'en-de', 'newer remote settings win')
assert(newerSettings(de, now + 1, en, now).direction === 'de-en', 'newer local settings win')
assert(newerSettings(en, now, de, now).direction === 'en-de', 'a tie goes to local')

console.log('edge-cases-test: ok')

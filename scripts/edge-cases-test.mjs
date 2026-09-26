// Edge-case tests for csv parsing, snapshot validation, merge ties, and settings.
const { importCsv } = await import('../src/csv.ts')
const { parseSnapshot, emptySnapshot, mergeSnapshots } = await import('../src/merge.ts')
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

// --- merge ties and deletions ---

// identical updated_at: local wins (remote merged first, later >= replaces)
const sR = emptySnapshot(now)
const sL = emptySnapshot(now)
sR.cards = [card('t', 'alt', 'old')]
sL.cards = [card('t', 'neu', 'new')]
assert(mergeSnapshots(sL, sR).cards[0].de === 'neu', 'tie on touched: local wins')

// deletion exactly equal to touch time drops the card (del >= touched)
const dL = emptySnapshot(now)
dL.cards = [card('d', 'x', 'y', { updated_at: now + 10 })]
dL.deleted_ids = { d: now + 10 }
assert(!mergeSnapshots(dL, emptySnapshot(now)).cards.some((c) => c.id === 'd'), 'delete at touch time drops')

// deletion older than the card edit keeps the (edited) card
const eL = emptySnapshot(now)
eL.cards = [card('e', 'keep', 'me', { updated_at: now + 20 })]
eL.deleted_ids = { e: now + 10 }
assert(mergeSnapshots(eL, emptySnapshot(now)).cards.length === 1, 'newer edit beats older delete')
const deletedSeed = emptySnapshot(now)
deletedSeed.deleted_ids = { 'seed-01': now }
const laterSeed = emptySnapshot(now)
laterSeed.cards = [card('seed-01', 'Mann', 'man', { updated_at: now + 50 })]
assert(mergeSnapshots(deletedSeed, laterSeed).cards.length === 0, 'offline seed edit cannot revive a deleted built-in card')

// deleted_ids take the max timestamp across snapshots
const del1 = emptySnapshot(now); del1.deleted_ids = { z: 100 }
const del2 = emptySnapshot(now); del2.deleted_ids = { z: 500 }
assert(mergeSnapshots(del1, del2).deleted_ids.z === 500, 'deleted_ids max wins')

// cards without ids are ignored
const noId = emptySnapshot(now)
noId.cards = [card('ok', 'a', 'b'), { de: 'x' }]
assert(mergeSnapshots(noId, emptySnapshot(now)).cards.length === 1, 'idless card skipped')

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


// --- settings merge: legacy clock 0 must fall back to updated_at ---

const legacyLocal = emptySnapshot(now + 50)
legacyLocal.settings = { direction: 'en-de', sessionSize: 50 }
legacyLocal.settings_updated_at = 0
legacyLocal.updated_at = now + 50
legacyLocal.cards = [card('s', 'a', 'b', { updated_at: now + 50 })]
const legacyRemote = emptySnapshot(now + 10)
legacyRemote.settings = { direction: 'de-en', sessionSize: 20 }
delete legacyRemote.settings_updated_at
legacyRemote.updated_at = now + 10
const legacyMerged = mergeSnapshots(legacyLocal, legacyRemote)
assert(legacyMerged.settings.direction === 'en-de', 'legacy local settings_updated_at 0 falls back to updated_at')
assert(legacyMerged.settings.sessionSize === 50, 'legacy local sessionSize preserved')
assert(legacyMerged.settings_updated_at === now + 50, 'winning settings clock is local updated_at')

const missingLocal = emptySnapshot(now + 50)
missingLocal.settings = { direction: 'en-de', sessionSize: 50 }
delete missingLocal.settings_updated_at
missingLocal.updated_at = now + 50
const missingMerged = mergeSnapshots(missingLocal, legacyRemote)
assert(missingMerged.settings.direction === 'en-de', 'missing settings_updated_at falls back to updated_at')

// Explicit real clocks still compare normally
const realLocal = emptySnapshot(now)
realLocal.settings = { direction: 'en-de', sessionSize: 50 }
realLocal.settings_updated_at = now + 5
realLocal.updated_at = now + 100
const realRemote = emptySnapshot(now)
realRemote.settings = { direction: 'de-en', sessionSize: 20 }
realRemote.settings_updated_at = now + 20
realRemote.updated_at = now
const realMerged = mergeSnapshots(realLocal, realRemote)
assert(realMerged.settings.direction === 'de-en', 'real remote settings_updated_at wins over older local clock')
assert(realMerged.settings.sessionSize === 20, 'real remote sessionSize wins')

console.log('edge-cases-test: ok')

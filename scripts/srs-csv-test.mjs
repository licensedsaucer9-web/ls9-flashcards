const { review, newSrs, isDue } = await import('../src/srs.ts')
const { importCsv } = await import('../src/csv.ts')
const { seedCards, SEED_COUNT } = await import('../src/seed.ts')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const now = 1_700_000_000_000
const fresh = newSrs(now)
assert(fresh.ease === 2.5 && fresh.reps === 0 && fresh.due === now, 'newSrs defaults')
assert(isDue(fresh, now), 'new cards are due')

const again = review(fresh, 'again', now)
assert(again.reps === 0 && again.interval === 0 && again.due === now, 'Again resets and stays due')

const good = review(fresh, 'good', now)
assert(good.reps === 1 && good.interval === 1, 'Good first interval is 1 day')
assert(good.due === now + 1 * 86400000, 'Good due is +1 day')
assert(!isDue(good, now + 1000), 'Good card is not due immediately')

const hard = review(fresh, 'hard', now)
assert(hard.interval === 1 && hard.ease < 2.5, 'Hard first interval 1 day, ease down')

const easy = review(fresh, 'easy', now)
assert(easy.interval === 4 && easy.ease > 2.5, 'Easy first interval 4 days, ease up')

const good2 = review(good, 'good', good.due)
assert(good2.interval === 6, 'Good second interval is 6 days')

const seed = seedCards(now)
assert(seed.length === SEED_COUNT && SEED_COUNT >= 400, `seed is ${seed.length}, expected >= 400`)
assert(seed.every((c) => ['der', 'die', 'das', 'none'].includes(c.article)), 'articles valid')
assert(seed.filter((c) => c.tags.includes('noun')).length >= 300, 'enough nouns')
assert(seed[0].id === 'seed-01' && seed[49].id === 'seed-50', 'original seed ids kept')
assert(seed[50].id === 'seed-51', 'new seed ids continue at 51')
assert(new Set(seed.map((c) => c.id)).size === seed.length, 'seed ids are unique')
assert(seed.every((c) => c.created_at === 0 && c.updated_at === 0 && c.srs.due === now), 'seed edit time is stable while initial due time is current')

const wg = review(fresh, 'wrong_gender', now)
assert(wg.reps === 0 && wg.interval === 0 && wg.due === now, 'wrong gender requeues now')
assert(wg.ease > review(fresh, 'again', now).ease, 'wrong gender is milder than Again')

const csv = `de,en,article,example_de
Bahnhof,train station,der,Der Bahnhof ist nah.
laufen,to run,none,Ich laufe schnell.
,missing,der,bad
Hund,dog,der,duplicate of seed
`
const result = importCsv(csv, seed, now)
assert(result.imported.length === 1, `imported 1 (laufen gloss differs), got ${result.imported.length}`)
assert(result.errors.length === 1, 'one error for missing de')
assert(result.skipped === 2, `skipped Bahnhof + Hund, got ${result.skipped}`)
const againCsv = importCsv(csv, [...seed, ...result.imported], now)
assert(againCsv.imported.length === 0, 'duplicates skipped on second import')

// Active-deck imports permit the same pair in another deck and stamp ownership.
const german = seed.map(card => ({ ...card, deckId: 'german' }))
const beforeGerman = JSON.stringify(german)
const otherCsv = 'front,back\nHund,dog\nbonjour,hello\n'
const other = importCsv(otherCsv, german, now, 'second')
assert(other.imported.length === 2 && other.errors.length === 0, 'front/back imports two rows into second deck')
assert(other.imported.every(card => card.deckId === 'second' && card.srs.due === now), 'import stamps active deck and is due immediately')
assert(JSON.stringify(german) === beforeGerman, 'German cards and schedules unchanged')
assert(importCsv(otherCsv, [...german, ...other.imported], now, 'second').skipped === 2, 'duplicates skipped only within active deck')
const oldFormat = importCsv('de,en,article,example_de\nImportprobe,import test,die,Eine Importprobe.\n', [...german, ...other.imported], now, 'german')
assert(oldFormat.imported.length === 1 && oldFormat.imported[0].deckId === 'german', 'German CSV still imports into German deck')
const optional = importCsv('back,type,example_back,front,example_front\nhello,other,Hello!,bonjour,Bonjour!\n', [], now, 'second')
assert(optional.errors.length === 0 && optional.imported.length === 1, 'reordered generic headers and missing article accepted')
assert(optional.imported[0].article === 'none' && optional.imported[0].example_de === 'Bonjour!' && optional.imported[0].example_en === 'Hello!', 'optional examples mapped by header')
assert(importCsv('front,back,type\ncourir,to run,verb', [], now).imported[0]?.tags.includes('verb'), 'type without article or examples accepted')

const { sessionCount, suggestSessionSize } = await import('../src/session.ts')
assert(sessionCount(50, 20) === 20, 'session cap 20')
assert(sessionCount(8, 20) === 8, 'session cannot exceed due')
assert(sessionCount(50, 0) === 50, '0 means all due')
assert(suggestSessionSize(50) === 30, `suggest 50 -> 30, got ${suggestSessionSize(50)}`)
assert(suggestSessionSize(35) === 20, 'suggest 35 -> 20')
assert(suggestSessionSize(12) === 10, 'suggest 12 -> 10')
assert(suggestSessionSize(5) === 5, 'suggest 5 -> 5')

const { mergeDeck, emptyDeck, mergeProgress, emptyUser } = await import('../src/merge.ts')

const content = (id, de, updatedAt) => ({
  id,
  de,
  en: de,
  article: 'none',
  example_de: '',
  example_en: '',
  tags: [],
  created_at: updatedAt,
  updated_at: updatedAt,
})
const srsAt = (t) => ({ ease: 2.5, interval: 1, reps: 1, due: t, updated_at: t })

const a = emptyDeck(now)
const b = emptyDeck(now + 1000)
b.cards = [content('x', 'neu', now + 50)]
a.cards = [content('x', 'alt', now), content('seed-02', 'Frau', now)]
const m = mergeDeck(a, b)
assert(m.cards.find((c) => c.id === 'x')?.de === 'neu', 'later card content wins')
assert(m.cards.some((c) => c.id === 'seed-02'), 'union keeps unique cards')
assert(m.updated_at === now + 1000, 'deck clock is the newest of both')
a.deleted_ids = { x: now + 100 }
const m2 = mergeDeck(a, b)
assert(!m2.cards.some((c) => c.id === 'x'), 'newer delete drops card')

// A deck file carries no scheduling state, so progress merges separately and
// two profiles grading the same card never touch each other.
const mine = { x: srsAt(now + 10) }
const theirs = { x: srsAt(now + 20), y: srsAt(now + 20) }
const p = mergeProgress(mine, theirs)
assert(p.x.updated_at === now + 20, 'newer remote progress wins')
assert(p.y.updated_at === now + 20, 'remote-only progress is kept')
assert(mergeProgress(theirs, mine).x.updated_at === now + 20, 'older local progress loses')
assert(mergeProgress({}, emptyUser('joakim', now).progress).x === undefined, 'empty remote adds nothing')

console.log('srs-csv-test: ok')

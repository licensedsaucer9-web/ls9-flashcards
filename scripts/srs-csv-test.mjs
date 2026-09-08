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
assert(seed.length === 50 && SEED_COUNT === 50, `seed is 50, got ${seed.length}`)
assert(seed.every((c) => ['der', 'die', 'das', 'none'].includes(c.article)), 'articles valid')
assert(seed.filter((c) => c.article === 'none').length === 10, '10 verbs')
assert(seed.filter((c) => c.tags.includes('noun')).length === 40, '40 nouns')

const csv = `de,en,article,example_de
Bahnhof,train station,der,Der Bahnhof ist nah.
laufen,to run,none,Ich laufe schnell.
,missing,der,bad
Hund,dog,der,duplicate of seed
`
const result = importCsv(csv, seed, now)
assert(result.imported.length === 2, `imported 2, got ${result.imported.length}`)
assert(result.errors.length === 1, 'one error for missing de')
assert(result.skipped === 1, `skipped Hund duplicate, got ${result.skipped}`)
const againCsv = importCsv(csv, [...seed, ...result.imported], now)
assert(againCsv.imported.length === 0, 'duplicates skipped on second import')

const { sessionCount, suggestSessionSize } = await import('../src/session.ts')
assert(sessionCount(50, 20) === 20, 'session cap 20')
assert(sessionCount(8, 20) === 8, 'session cannot exceed due')
assert(sessionCount(50, 0) === 50, '0 means all due')
assert(suggestSessionSize(50) === 30, `suggest 50 -> 30, got ${suggestSessionSize(50)}`)
assert(suggestSessionSize(35) === 20, 'suggest 35 -> 20')
assert(suggestSessionSize(12) === 10, 'suggest 12 -> 10')
assert(suggestSessionSize(5) === 5, 'suggest 5 -> 5')

const { mergeSnapshots, emptySnapshot } = await import('../src/merge.ts')
const a = emptySnapshot(now)
const b = emptySnapshot(now + 1000)
b.settings.sessionSize = 10
b.cards = [{ ...seed[0], id: 'x', updated_at: now + 50, de: 'neu' }]
a.cards = [{ ...seed[0], id: 'x', updated_at: now, de: 'alt' }, seed[1]]
const m = mergeSnapshots(a, b)
assert(m.cards.find((c) => c.id === 'x')?.de === 'neu', 'later card wins')
assert(m.cards.some((c) => c.id === seed[1].id), 'union keeps unique cards')
assert(m.settings.sessionSize === 10, 'later snapshot settings win')
a.deleted_ids = { x: now + 100 }
const m2 = mergeSnapshots(a, b)
assert(!m2.cards.some((c) => c.id === 'x'), 'newer delete drops card')

console.log('srs-csv-test: ok')

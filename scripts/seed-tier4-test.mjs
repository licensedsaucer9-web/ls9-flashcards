// Tier 4 content: 250 rarer German words appended to the built-in deck. Runs on the
// checked-in data only; scripts/rank-words.mjs --check re-derives the ranks from the corpus.
import assert from 'node:assert/strict'
import { seedCards, SEED_COUNT } from '../src/seed.ts'
import { TIER_3_MAX_RANK, TIER_4_SEED } from '../src/seed-tier4.ts'
import { cardContentProblem } from '../src/limits.ts'
import { matchAnswer } from '../src/hard-mode.ts'
import { wordTypes } from '../src/word-types.ts'
import { tierCounts, tierOf } from '../src/tiers.ts'

const seed = seedCards(0)
const core = seed.filter((card) => card.tier !== 4)
const tier4 = seed.filter((card) => card.tier === 4)

assert.equal(SEED_COUNT, 764, 'the deck is the 514 original words plus 250')
assert.equal(core.length, 514, 'the original words are unchanged')
assert.equal(tier4.length, 250, 'tier 4 holds 250 words')
assert.equal(TIER_4_SEED.length, 250)
assert.deepEqual(tierCounts(seed), { 1: 100, 2: 150, 3: 264, 4: 250 })

// --- IDs: appended after seed-514, never colliding with an existing or starter ID ---

assert.equal(new Set(seed.map((card) => card.id)).size, seed.length, 'seed IDs are unique')
assert.deepEqual(tier4.map((card) => card.id), Array.from({ length: 250 }, (_, i) => `seed-${515 + i}`), 'tier 4 IDs continue after seed-514')
assert(core.every((card) => /^seed-\d+$/.test(card.id) && Number(card.id.slice(5)) <= 514), 'original IDs stay below seed-515')
assert.deepEqual(seed.slice(0, 514).map((card) => card.id), core.map((card) => card.id), 'tier 4 is appended, the original order is kept')

// --- No overlap with tiers 1-3 and no duplicates inside tier 4 ---

const lemma = (word) => word.normalize('NFC').toLowerCase()
const coreWords = new Set(core.map((card) => lemma(card.de)))
const seen = new Set()
for (const card of tier4) {
  const word = lemma(card.de)
  assert(!coreWords.has(word), `${card.de} is already in tiers 1-3`)
  assert(!seen.has(word), `${card.de} appears twice in tier 4`)
  seen.add(word)
}
const pair = (card) => `${card.de.trim().toLowerCase()}|${card.en.trim().toLowerCase()}`
assert.equal(new Set(seed.map(pair)).size, seed.length, 'front/back pairs are unique, so reseeding never skips a word')
assert.equal(new Set(tier4.map((card) => card.en.toLowerCase())).size, 250, 'tier 4 translations are unique')
const coreEn = new Set(core.map((card) => card.en.toLowerCase()))
for (const card of tier4) assert(!coreEn.has(card.en.toLowerCase()), `${card.de}: "${card.en}" already translates a tiers 1-3 word`)

// Near-duplicates: the same inflection endings scripts/rank-words.mjs uses. A tier 4 word
// must not be an inflected form of an existing word, nor the other way round.
const ENDINGS = ['s', 'e', 'n', 'en', 'er', 'es', 'em', 't']
const inflections = (word) => new Set([word, ...ENDINGS.map((ending) => word + ending)])
const all = [...coreWords, ...seen]
for (const word of seen) {
  for (const other of all) {
    if (other === word) continue
    assert(!inflections(other).has(word) && !inflections(word).has(other), `${word} is an inflection of ${other}`)
  }
}

// --- Content: the same fields as the original seeds, within the server limits ---

for (const card of tier4) {
  const label = `${card.id} ${card.de}`
  for (const field of ['de', 'en', 'example_de', 'example_en']) {
    assert(typeof card[field] === 'string' && card[field].trim() === card[field] && card[field].length > 0, `${label}: ${field}`)
    assert.equal(card[field], card[field].normalize('NFC'), `${label}: ${field} is NFC`)
  }
  assert.equal(cardContentProblem(card), null, `${label}: within src/limits.ts`)
  const [level, type, ...rest] = card.tags
  assert(level === 'b1' && rest.length === 0, `${label}: tags are [level, type]`)
  assert.deepEqual(wordTypes(card), [type], `${label}: one word type`)
  if (type === 'noun') {
    assert(['der', 'die', 'das'].includes(card.article), `${label}: a noun has der/die/das`)
    assert(/^[A-ZÄÖÜ]/.test(card.de), `${label}: a noun is capitalized`)
  } else {
    assert.equal(card.article, 'none', `${label}: only nouns have an article`)
    assert(/^[a-zäöü]/.test(card.de), `${label}: a ${type} is lower case`)
  }
  if (type === 'verb') assert(card.en.startsWith('to '), `${label}: verb glosses start with "to"`)
  assert.equal(tierOf(card), 4)
  assert.equal(card.created_at, 0, `${label}: seed content clock is zero`)
  assert.equal(card.updated_at, 0, `${label}: seed content clock is zero`)
  assert.equal(card.srs.reps, 0, `${label}: seeding schedules nothing`)
  // Hard mode accepts the saved answers in both directions.
  assert.equal(matchAnswer(card, 'de-en', card.en), 'correct', `${label}: Hard mode de-en`)
  const answer = card.article === 'none' ? card.de : `${card.article} ${card.de}`
  assert.equal(matchAnswer(card, 'en-de', answer), 'correct', `${label}: Hard mode en-de`)
}

// --- Ranks: every tier 4 word is rarer than every tier 1-3 word ---

// Three original compounds are missing from the 50k list and carry 900000+ placeholders;
// their full-list ranks are at most TIER_3_MAX_RANK (Platzkarte, the rarest).
const coreRanks = core.map((card) => card.rank).filter((rank) => rank < 900000)
assert.equal(coreRanks.length, 511, 'all but the three placeholders are 50k ranks')
assert(Math.max(...coreRanks) <= TIER_3_MAX_RANK, 'TIER_3_MAX_RANK covers tiers 1-3')
for (const card of tier4) {
  assert(Number.isSafeInteger(card.rank), `${card.de}: integer rank`)
  assert(card.rank > TIER_3_MAX_RANK, `${card.de}: rank ${card.rank} is not below the tier 3 cut-off`)
  assert(card.rank <= 1000000, `${card.de}: rank ${card.rank} is over the firestore.rules limit`)
}
const types = Object.fromEntries(['noun', 'verb', 'adj'].map((type) => [type, tier4.filter((card) => card.tags[1] === type).length]))
assert.deepEqual(types, { noun: 165, verb: 40, adj: 45 }, 'tier 4 word-type mix')

console.log('seed-tier4-test: ok')

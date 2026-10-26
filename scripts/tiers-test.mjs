// Tier boundaries and profile identity. Both are pure logic, so they run in node
// against the real seed data rather than only through the browser.
import assert from 'node:assert/strict'
import { tierOf, inTier, inSelectedTier, tierCounts, tierLabel, tierPillLabel, tierPillName, reviewTiers, toggleTier, validSelectedTiers, TIER_NOTES } from '../src/tiers.ts'
import { slugify, dbNameForUser, LEGACY_DB_NAME, DEFAULT_USER } from '../src/user.ts'
import { seedCards } from '../src/seed.ts'
import { TIER_CUMULATIVE, TIERS, isTier } from '../src/types.ts'


// --- tierOf ---

// The tier is baked per card, because the deck is a content-word list: its 100th
// most common word is thousands of places down the full corpus ranking.
assert(tierOf({ tier: 1 }) === 1, 'tier 1 read')
assert(tierOf({ tier: 2 }) === 2, 'tier 2 read')
assert(tierOf({ tier: 3 }) === 3, 'tier 3 read')
assert(tierOf({ tier: 4 }) === 4, 'tier 4 read')

// A card of your own has no baked tier. It stays in tier 3, so a Tier 3 selection made
// before tier 4 existed keeps it.
assert(tierOf({}) === 3, 'no tier -> tier 3')
assert(tierOf({ tier: 5 }) === 3, 'tier 5 is not a tier')
assert(tierOf({ rank: 5228 }) === 3, 'a rank alone does not place a card')
assert(tierOf({ tier: 0 }) === 3, 'a nonsense tier is ignored, not honoured')
assert(tierOf({ tier: '1' }) === 3, 'a string tier is not trusted')
assert(tierOf({ tier: 1, rank: 50000 }) === 1, 'the baked tier wins over the rank')

// --- higher tiers include lower ones ---

assert(inTier({ tier: 1 }, 1), 'tier 1 word is in tier 1')
assert(inTier({ tier: 1 }, 2), 'tier 1 word is in tier 2')
assert(inTier({ tier: 1 }, 3), 'tier 1 word is in tier 3')
assert(!inTier({ tier: 2 }, 1), 'tier 2 word is not in tier 1')
assert(inTier({ tier: 2 }, 2), 'tier 2 word is in tier 2')
assert(inTier({ tier: 2 }, 3), 'tier 2 word is in tier 3')
assert(inTier({ tier: 3 }, 3), 'tier 3 word is in tier 3')
assert(!inTier({ tier: 3 }, 2), 'tier 3 word is not in tier 2')
assert(inTier({ tier: 3 }, 4), 'tier 3 word is in tier 4')
assert(inTier({ tier: 1 }, 4) && inTier({}, 4), 'tier 4 includes everything')
assert(inTier({ tier: 4 }, 4), 'tier 4 word is only in tier 4')
assert(!inTier({ tier: 4 }, 3), 'tier 4 word is not in tier 3')

const sample = [{ tier: 1 }, { tier: 2 }, { tier: 2 }, { tier: 3 }, { tier: 1 }, { tier: 4 }, {}]
assert(inSelectedTier(sample, 1).length === 2, 'tier 1 selects only tier 1 words')
assert(inSelectedTier(sample, 2).length === 4, 'tier 2 is cumulative')
assert(inSelectedTier(sample, 3).length === 6, 'tier 3 is everything but tier 4')
assert(inSelectedTier(sample, 4).length === 7, 'tier 4 is everything')
assert(inSelectedTier(sample, [4]).length === 1, 'Tier 4 alone is only the rarer words')

// --- the TIERS change ---

assert.deepEqual(TIERS, [1, 2, 3, 4], 'four tiers')
assert.deepEqual(TIER_CUMULATIVE, { 1: 100, 2: 250, 3: 514, 4: Number.MAX_SAFE_INTEGER }, 'nominal cumulative sizes')
for (const value of [1, 2, 3, 4]) assert(isTier(value), `${value} is a tier`)
for (const value of [0, 5, '4', null, undefined, 3.5]) assert(!isTier(value), `${value} is not a tier`)
assert.deepEqual(tierCounts([{ tier: 4 }, {}, { tier: 1 }]), { 1: 1, 2: 0, 3: 1, 4: 1 }, 'tierCounts counts four tiers')

// --- against the real seed deck ---

const seed = seedCards(0)
assert(seed.length === 764, `seed has 764 cards, got ${seed.length}`)
assert(seed.every((c) => typeof c.rank === 'number' && c.rank > 0), 'every seed card carries a rank')
assert(seed.every((c) => c.srs.reps === 0), 'seeding does not schedule anything')

const counts = tierCounts(seed)
assert(counts[1] === TIER_CUMULATIVE[1], `tier 1 holds exactly 100 words, got ${counts[1]}`)
assert(counts[1] + counts[2] === TIER_CUMULATIVE[2], `tiers 1-2 hold exactly 250 words, got ${counts[1] + counts[2]}`)
assert(counts[1] + counts[2] + counts[3] === TIER_CUMULATIVE[3], `tiers 1-3 hold the original 514 words, got ${counts[1] + counts[2] + counts[3]}`)
assert(counts[4] === 250, `tier 4 holds 250 words, got ${counts[4]}`)
assert(counts[1] + counts[2] + counts[3] + counts[4] === seed.length, 'every seed card lands in some tier')

// The tiers must be monotone in the corpus rank, or the split is not "most common first".
for (const [a, b] of [[1, 2], [2, 3]]) { // tier 4 against tier 3: scripts/seed-tier4-test.mjs
  const worst = Math.max(...seed.filter((c) => c.tier === a).map((c) => c.rank ?? Infinity))
  const best = Math.min(...seed.filter((c) => c.tier === b).map((c) => c.rank ?? Infinity))
  assert(worst < best, `every tier ${a} word is more common than every tier ${b} word (${worst} vs ${best})`)
}
assert(seed.filter((c) => c.tier === 1).length === 100, 'tier 1 is the 100 most common deck words')
assert(seed.filter((c) => c.tier <= 2).length === 250, 'tiers 1-2 are the 250 most common deck words')

// A few anchors, so a bad regeneration is caught rather than silently accepted.
const byDe = new Map(seed.map((c) => [c.de, c]))
assert(tierOf(byDe.get('haben')) === 1, 'haben is one of the 100 most common')
assert(tierOf(byDe.get('sein')) === 1, 'sein is one of the 100 most common')
assert(tierOf(byDe.get('Weg')) === 1, 'Weg is one of the 100 most common')
assert(tierOf(byDe.get('Schule')) === 2, 'Schule falls in tier 2')
assert(tierOf(byDe.get('Kühlschrank')) === 3, 'Kühlschrank falls in tier 3')
assert(tierOf(byDe.get('Platzkarte')) === 3, 'Platzkarte stays in tier 3')
assert(tierOf(byDe.get('Wäscheklammer')) === 4, 'Wäscheklammer falls in tier 4')
assert(tierOf(byDe.get('entkalken')) === 4, 'entkalken falls in tier 4')

assert(tierPillLabel(1, 23) === 'T1: 23' && tierPillLabel(2, 0) === 'T2: 0', 'pill is T<n>: <due>')
assert(tierPillName(1, 23) === 'Tier 1, 23 due', 'pill accessible name')
assert(tierLabel(1) === 'Tier 1 · 100 words', `tier 1 label, got ${tierLabel(1)}`)
assert(tierLabel(2, counts) === `Tier 2 · ${counts[1] + counts[2]} words`, 'tier 2 label counts cumulatively')
assert(tierLabel(3, counts) === 'Tier 3 · 514 words', `tier 3 label counts tiers 1-3, got ${tierLabel(3, counts)}`)
assert(tierLabel(4, counts) === `Tier 4 · ${seed.length} words`, 'tier 4 label counts everything')
assert(tierLabel(3) === 'Tier 3 · 514 words' && tierLabel(4) === 'Tier 4 · all', 'labels without counts')
assert(tierLabel([1, 2, 3, 4]) === 'All tiers', 'four selected tiers are all tiers')
assert(tierLabel([1, 2, 3]) === 'Tiers 1 + 2 + 3', 'three tiers are no longer all of them')
assert(tierLabel([4]) === 'Tier 4' && tierLabel([2, 4]) === 'Tiers 2 + 4', 'exact tier 4 labels')
assert(tierPillLabel(4, 7) === 'T4: 7' && tierPillName(4, 7) === 'Tier 4, 7 due', 'tier 4 pill')
for (const tier of TIERS) assert(typeof TIER_NOTES[tier] === 'string' && TIER_NOTES[tier].length > 0, `tier ${tier} has a note`)

// --- profile identity ---

assert(slugify('Joakim') === 'joakim', 'a plain name slugs to lowercase')
assert(slugify('  Anna  ') === 'anna', 'surrounding spaces are trimmed')
assert(slugify('Åsa Öberg') === 'asa-oberg', 'accents are folded and non-ascii dropped')
assert(slugify('Mary-Jane') === 'mary-jane', 'punctuation becomes a separator')
assert(slugify('   ') === '', 'a blank name has no slug')
assert(slugify('!!!') === '', 'a name with no alphanumerics has no slug')
assert(slugify('a'.repeat(80)).length === 40, 'a long name is capped')

// Two profiles must never land on the same database.
assert(dbNameForUser('joakim') === `${LEGACY_DB_NAME}:joakim`, 'a profile database is namespaced')
assert(dbNameForUser('anna') !== dbNameForUser('joakim'), 'profiles get separate databases')
assert(dbNameForUser('joakim') !== LEGACY_DB_NAME, 'a profile never reuses the legacy database')
assert(DEFAULT_USER.slug === 'joakim', 'existing progress is claimed by the default profile')

console.log('tiers-test: ok')

// Exact review selections migrate legacy scopes without changing their contents.
for (const tier of [1, 2, 3, 4]) assert(JSON.stringify(reviewTiers({ tier })) === JSON.stringify([1, 2, 3, 4].filter(t => t <= tier)), 'legacy scope preserved')
// A legacy "everything" scope saved before tier 4 existed keeps meaning tiers 1-3.
assert(JSON.stringify(reviewTiers({ tier: 3 })) === '[1,2,3]', 'legacy tier 3 does not add tier 4')
assert(JSON.stringify(reviewTiers({ tier: 3, selectedTiers: [1, 2, 3] })) === '[1,2,3]', 'saved exact tiers 1-3 do not add tier 4')
assert(JSON.stringify(reviewTiers({ tier: 1, selectedTiers: [4, 2] })) === '[2,4]', 'exact selections are ordered')
assert(inSelectedTier(seed, [3]).length === 264, 'Tier 3 alone excludes tiers 1 and 2')
assert(inSelectedTier(seed, [4]).length === 250, 'Tier 4 alone is the 250 rarer words')
assert(inSelectedTier(seed, [3, 4]).length === 514, 'Tier 3 + 4')
assert(inSelectedTier(seed, [1, 4]).length === 350, 'Tier 1 + 4')
assert(inSelectedTier(seed, [1, 2, 3, 4]).length === seed.length, 'all four tiers are the whole deck')
assert(inSelectedTier(seed, 3).length === 514 && inSelectedTier(seed, 4).length === 764, 'cumulative tiers 3 and 4')
assert(inSelectedTier(seed, [2, 3]).length === 414, 'Tier 2 + 3 exclude Tier 1')
assert(inSelectedTier(seed, [1, 3]).length === 364, 'disjoint buckets are supported')
assert(JSON.stringify(toggleTier([2, 3], 2)) === '[3]', 'each pill toggles independently')
assert(JSON.stringify(toggleTier([3], 3)) === '[1,2,3,4]', 'last deselection returns to all tiers')
assert(JSON.stringify(toggleTier([1, 2, 3], 4)) === '[1,2,3,4]', 'tier 4 can be added to an old selection')
assert(JSON.stringify(toggleTier([2], 4)) === '[2,4]' && JSON.stringify(toggleTier([2, 4], 2)) === '[4]', 'tier 4 combines and stands alone')
for (const good of [[4], [1, 4], [3, 4], [1, 2, 3, 4], [4, 3, 2, 1]]) assert(validSelectedTiers(good), `exact selection ${good} accepted`)
for (const bad of [[], [1, 1], [0], [5], [1, 2, 3, 4, 4], [1, 2, 3, 4, 5], ['1'], ['4'], '3', null]) assert(!validSelectedTiers(bad), `invalid exact selection ${JSON.stringify(bad)} rejected`)

// Ranks the seed vocabulary against a corpus frequency list and prints a TSV.
// Source list: hermitdave/FrequencyWords, OpenSubtitles 2018 de_50k (word + count) for
// tiers 1-3, and de_full (the same list untruncated) for tier 4. See docs/starter-decks.md.
// Run: node scripts/rank-words.mjs <de_50k.txt|de_full.txt> [--check]
// --check needs de_full.txt and verifies the baked ranks and the tier 4 cut-off.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const listPath = process.argv[2]
const check = process.argv.includes('--check')
if (!listPath) {
  console.error('usage: node scripts/rank-words.mjs <de_50k.txt|de_full.txt> [--check]')
  process.exit(1)
}

const rank = new Map()
readFileSync(listPath, 'utf8')
  .split('\n')
  .forEach((line, i) => {
    const word = line.split(' ')[0]
    if (word) rank.set(word, i + 1)
  })

// The seed is stored as lemmas; the list is surface forms. Generate a plausible
// inflection set and let the rarest-ranked form set the lemma's rank.
//
// Only endings that stay inside one lemma are generated. German past-tense
// endings (dachte, ging) and participles (gedankt) are deliberately NOT
// synthesised: they need stem changes, and the naive concatenations cross into
// other lemmas — "Dach"+te is the verb "denken", "danken"+"ge" is "Gedanken".
const FORMS = {
  // Homographs the generator would otherwise resolve to a different word.
  Ei: ['ei', 'eier', 'eiern', 'eiers'],
  Eis: ['eis', 'eise', 'eisen'],
  Reis: ['reis', 'reiss'],
  Schloss: ['schloss', 'schlösser', 'schlösse'],
}

function surfaceForms(word) {
  const w = word.toLowerCase()
  if (FORMS[word]) return new Set(FORMS[word])
  const out = new Set([w])
  const add = (...forms) => forms.forEach((f) => f && out.add(f))
  add(`${w}s`, `${w}e`, `${w}n`, `${w}en`, `${w}er`, `${w}es`, `${w}em`, `${w}t`)
  add(`${w}ung`, `${w}heit`, `${w}keit`, `${w}lich`)
  return out
}

const ROW = /\{ id: '(seed-\d+)', rank: (\d+), tier: (\d), de: '([^']+)'/g
const seeds = ['src/seed.ts', 'src/seed-tier4.ts'].flatMap((path) =>
  [...readFileSync(path, 'utf8').matchAll(ROW)].map((m) => ({ id: m[1], rank: Number(m[2]), tier: Number(m[3]), de: m[4] })))
const words = seeds.map((s) => s.de)
assert(words.length > 700, `parsed ${words.length} seed words`)

const rows = words.map((de) => {
  let best = Infinity
  let bestForm = ''
  for (const form of surfaceForms(de)) {
    const r = rank.get(form)
    if (r !== undefined && r < best) {
      best = r
      bestForm = form
    }
  }
  return { de, rank: best === Infinity ? null : best, via: bestForm }
})
rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.de.localeCompare(b.de, 'de'))

for (const row of rows) console.log(`${row.rank ?? 'NA'}\t${row.de}\t${row.via}`)
const missing = rows.filter((r) => r.rank === null)
console.error(`ranked ${rows.length - missing.length}/${rows.length}; ${missing.length} unmatched`)
if (missing.length) console.error('unmatched:', missing.map((m) => m.de).join(' '))

if (check) {
  // Tiers 1-3 keep their 50k ranks; the three words the 50k list missed carry 900000+
  // placeholders. The 50k list is the first 50,000 lines of de_full, so matched ranks agree.
  assert(rank.size > 1000000, '--check needs de_full.txt')
  const computed = new Map(rows.map((r) => [r.de, r.rank]))
  const problems = []
  let coreMax = 0
  for (const seed of seeds) {
    const found = computed.get(seed.de)
    if (found === null) { problems.push(`${seed.id} ${seed.de}: not in the list`); continue }
    if (seed.tier <= 3) {
      coreMax = Math.max(coreMax, found)
      if (seed.rank < 900000 ? found !== seed.rank : found <= 50000) problems.push(`${seed.id} ${seed.de}: baked ${seed.rank}, list ${found}`)
    } else if (found !== seed.rank) problems.push(`${seed.id} ${seed.de}: baked ${seed.rank}, list ${found}`)
  }
  const tier4 = seeds.filter((s) => s.tier === 4)
  const cutoff = Number(readFileSync('src/seed-tier4.ts', 'utf8').match(/TIER_3_MAX_RANK = (\d+)/)[1])
  if (coreMax !== cutoff) problems.push(`rarest tier 1-3 rank is ${coreMax}, TIER_3_MAX_RANK says ${cutoff}`)
  for (const seed of tier4) if (seed.rank <= coreMax) problems.push(`${seed.id} ${seed.de}: rank ${seed.rank} is not rarer than tier 3 (${coreMax})`)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.error(`check ok: ${seeds.length} words; tier 3 cut-off ${coreMax}; ${tier4.length} tier 4 words ranked ${Math.min(...tier4.map((s) => s.rank))}-${Math.max(...tier4.map((s) => s.rank))}`)
}

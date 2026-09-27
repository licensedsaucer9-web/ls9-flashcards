// Ranks the seed vocabulary against a corpus frequency list and prints a TSV.
// Source list: hermitdave/FrequencyWords, OpenSubtitles 2018 de_50k (word + count).
// Run: node scripts/rank-words.mjs <de_50k.txt> [seed.ts]
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const listPath = process.argv[2]
const seedPath = process.argv[3] ?? 'german-flashcards/src/seed.ts'
if (!listPath) {
  console.error('usage: node scripts/rank-words.mjs <de_50k.txt> [seed.ts]')
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

const source = readFileSync(seedPath, 'utf8')
const words = [...source.matchAll(/\{ id: 'seed-\d+', de: '([^']+)'/g)].map((m) => m[1])
assert(words.length > 400, `parsed ${words.length} seed words`)

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

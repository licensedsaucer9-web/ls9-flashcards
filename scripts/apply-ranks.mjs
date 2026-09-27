// Rewrites src/seed.ts so every seed row carries its corpus rank and the tier that
// rank puts it in. Run: node scripts/apply-ranks.mjs <ranks.tsv> [seed.ts]
import { readFileSync, writeFileSync } from 'node:fs'

const ranksPath = process.argv[2]
const seedPath = process.argv[3] ?? 'src/seed.ts'
if (!ranksPath) {
  console.error('usage: node scripts/apply-ranks.mjs <ranks.tsv> [seed.ts]')
  process.exit(1)
}

// Tier 1 is the first 100 words *of this deck*, not of the corpus. The corpus list is
// mostly function words (ich, sie, das, und) that the deck does not carry, so a corpus
// rank of 900 can still be one of the deck's 100 most common words.
const TIER_1 = 100
const TIER_2 = 250

const ranks = []
let nextFallback = 900000
for (const line of readFileSync(ranksPath, 'utf8').split('\n')) {
  const [rank, word] = line.split('\t')
  if (!word) continue
  ranks.push({ de: word, rank: rank === 'NA' ? nextFallback++ : Number(rank) })
}
ranks.sort((a, b) => a.rank - b.rank || a.de.localeCompare(b.de, 'de'))
const tierByWord = new Map(
  ranks.map((r, i) => [r.de, i < TIER_1 ? 1 : i < TIER_2 ? 2 : 3]),
)

const source = readFileSync(seedPath, 'utf8')
let seen = 0
const out = source.replace(
  /^(\s*\{ id: 'seed-\d+', )(?:rank: \d+, )?de: '([^']+)'(, )/gm,
  (_match, head, de, tail) => {
    const rank = ranks.find((r) => r.de === de)
    const tier = tierByWord.get(de)
    if (rank === undefined || tier === undefined) throw new Error(`no rank for ${de}`)
    seen += 1
    return `${head}rank: ${rank.rank}, tier: ${tier}, de: '${de}'${tail}`
  },
)

if (seen < 400) throw new Error(`only rewrote ${seen} rows`)
writeFileSync(seedPath, out)
const counts = [1, 2, 3].map((t) => ranks.filter((_, i) => tierByWord.get(ranks[i].de) === t).length)
console.error(`ranked ${seen} seed rows in ${seedPath}; tier sizes ${counts.join(' / ')}`)

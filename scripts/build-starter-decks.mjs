// Usage: node scripts/build-starter-decks.mjs /path/fr_50k.txt /path/es_50k.txt [--check]
// Corpus files are operator inputs, never runtime dependencies. See docs/starter-decks.md.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const rows = readFileSync('src/decks/vocabulary.tsv', 'utf8').trim().split('\n').filter(l => !l.startsWith('#')).map(l => l.split('\t'))
const personal = new Set('jeune riche pauvre heureux triste fatigué malade prêt occupé libre seul gentil poli calme nerveux content fâché sûr'.split(' '))
const articleText = a => ({ l_m: "l'", l_f: "l'", el_f: 'el' })[a] ?? a
const head = (a, w) => articleText(a) + (a.startsWith('l_') ? '' : ' ') + w
const deHead = (a, w) => a === 'le' ? `du ${w}` : a === 'la' ? `de la ${w}` : `de ${head(a, w)}`
const overrides = { fr: { 'grand-père': 'grand-père', 'grand-mère': 'grand-mère', 'petit-déjeuner': 'déjeuner', 'se souvenir': 'souvenir', "s'habiller": 'habiller' }, es: { despertarse: 'despertar', levantarse: 'levantar', lavarse: 'lavar', vestirse: 'vestir', quedarse: 'quedar', marcharse: 'marchar', 'encontrarse con': 'encontrar', 'pedir prestado': 'pedir', 'acordarse de': 'acordar', 'cuarto de baño': 'baño', 'oficina de correos': 'correos' } }
for (const [index, lang] of ['fr', 'es'].entries()) {
  assert(process.argv[index + 2], 'provide both corpus files')
  const corpus = readFileSync(process.argv[index + 2], 'utf8')
  const ranks = new Map(corpus.trim().split('\n').map((line, i) => [line.split(' ')[0], i + 1]))
  const cards = rows.map(([key, ...row]) => {
    let article, de, en, example_de, example_en, type
    if (row[0] === '@verb') {
      type = 'verb'; article = 'none'; de = row[index + 1]; en = row[3]; example_de = row[index + 4]; example_en = row[6]
      if (de === 'parler') example_en = 'I speak French.'
      if (de === 'hablar') example_en = 'I speak Spanish.'
      if (de === 'refuser') example_en = 'He refuses to leave.'
      if (de === 'rechazar') example_en = 'He declines the invitation.'
      if (de === 'espérer') example_en = 'I hope to see you again.'
      if (de === 'desear') example_en = 'I wish to see you again.'
    } else if (row[0] === '@adj') {
      type = 'adj'; article = 'none'; de = row[index + 1]; en = row[3]
      // The pronoun refers to a masculine person or object; citation forms stay masculine singular.
      example_de = index === 0 ? `Il est ${de}.` : `${personal.has(row[1]) ? 'Él es' : 'Es'} ${de}.`
      if (index === 1 && new Set('plein vide propre sale chaud froid tiède sec mouillé ouvert fermé prêt occupé seul content fâché proche'.split(' ')).has(row[1])) example_de = `Está ${de}.`
      example_en = `${personal.has(row[1]) ? 'He' : 'It'} is ${en.split(' / ')[0].replace(/ \(.+\)/, '')}.`
    } else {
      type = 'noun'; article = row[index * 2]; de = row[index * 2 + 1]; en = row[4]
      example_de = index === 0 ? `Nous parlons ${deHead(article, de)}.` : `Hablamos ${article === 'el' || article === 'el_f' ? `del ${de}` : `de la ${de}`}.`
      example_en = `We are talking about the ${en.split(' / ')[0].replace(/ \(.+\)/, '')}.`
    }
    const specialAdjectives = {
      premier: ['C’est le premier.', 'It is the first.'], primero: ['Es el primero.', 'It is the first.'],
      dernier: ['C’est le dernier.', 'It is the last.'], último: ['Es el último.', 'It is the last.'],
      prochain: ['Le prochain train arrive.', 'The next train is arriving.'], próximo: ['El próximo tren llega.', 'The next train is arriving.'],
      seguro: ['Él está seguro.', 'He is sure.'],
    }
    if (type === 'adj' && specialAdjectives[de]) [example_de, example_en] = specialAdjectives[de]
    if (de === 'repas') en = 'meal'
    if (de === 'almuerzo') en = 'lunch'
    if (de === 'soir') en = 'evening'
    if (de === 'tarde') en = 'afternoon / evening'
    if (type === 'noun') example_en = `We are talking about the ${en.split(' / ')[0].replace(/ \(.+\)/, '')}.`
    // Phrase heads and reflexives are explicit; no German inflection heuristic.
    let rankForm = overrides[lang][de] ?? de.replace(/^se /, '').split(' ')[0]
    let rank = ranks.get(rankForm)
    if (!rank) { rank = 1000000; console.error(`${lang}: unmatched ${de} (${rankForm})`) }
    return { id: `seed-${lang}-${key}`, de, en, article, example_de, example_en, tags: ['a1', type], rank, rankForm }
  })
  const ordered = [...cards].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1))
  ordered.forEach((card, i) => { card.tier = i < 100 ? 1 : i < 250 ? 2 : 3 })
  const output = JSON.stringify({ language: lang, corpusSha256: createHash('sha256').update(corpus).digest('hex'), cards }, null, 2) + '\n'
  const path = `src/decks/${lang}.json`
  if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), output, `${lang}: generated content differs`)
  else writeFileSync(path, output)
  console.log(`${lang}: ${cards.length} cards; tiers 100 / 150 / ${cards.length - 250}`)
}

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { starterCards, starterDeckId } from '../src/starter-decks.ts'
import { seedCards } from '../src/seed.ts'
import { ARTICLES } from '../src/types.ts'
import { articleGender, articleLabel, articlesFor } from '../src/articles.ts'
import { germanHead } from '../src/dom.ts'
import { reviewFaces } from '../src/word-types.ts'
import { validateCard } from '../src/migration-data.ts'
import { filesToDocs, docsToFiles } from '../src/firestore-docs.ts'
import { mergeDeck } from '../src/merge.ts'
import { planCardWrite } from '../src/record-sync.ts'
import { importCsv } from '../src/csv.ts'
const ids = new Set(seedCards().map(c => c.id))
for (const lang of ['fr', 'es']) {
  const cards = starterCards(lang)
  const content = JSON.parse(readFileSync(`src/decks/${lang}.json`, 'utf8'))
  assert.equal(cards.length, 567)
  const pairs = new Set()
  for (const card of cards) {
    validateCard(card)
    assert(!ids.has(card.id)); ids.add(card.id)
    const pair = `${card.de}|${card.en}`
    assert(!pairs.has(pair), pair); pairs.add(pair)
    for (const field of ['de', 'en', 'example_de', 'example_en']) {
      assert(card[field].trim()); assert.equal(card[field], card[field].normalize('NFC'))
      assert(!/[\uFFFD\u0000-\u001f]/u.test(card[field]))
    }
    assert.equal(card.tags.length, 2)
    assert(['noun', 'verb', 'adj'].includes(card.tags[1]))
    assert(ARTICLES.includes(card.article))
    assert(articlesFor(lang === 'fr' ? 'French' : 'Spanish').includes(card.article))
    assert.equal(card.tags[1] === 'noun', card.article !== 'none')
    assert(card.rank > 0 && card.rank < 50001)
  }
  const ordered = [...cards].sort((a,b) => a.rank-b.rank || (a.id < b.id ? -1 : 1))
  ordered.forEach((c,i) => assert.equal(c.tier, i < 100 ? 1 : i < 250 ? 2 : 3))
  assert.equal(content.corpusSha256.length, 64)
  assert(content.cards.every(c => c.rankForm))
  const deck = { version: 2, kind: 'deck', updated_at: 0, cards: cards.map(({srs, ...c}) => c), deleted_ids: {} }
  const user = { version: 2, kind: 'user', user: 'synthetic', updated_at: 42, settings: { direction: 'en-de', sessionSize: 7, tier: 2, wordTypes: ['noun'] }, progress: { [cards[0].id]: { ...cards[0].srs, reps: 3, updated_at: 42 } } }
  const roundtrip = docsToFiles(filesToDocs(deck, user), 'synthetic', 0)
  assert.deepEqual(roundtrip.deck, deck)
  assert.deepEqual(roundtrip.user.progress, user.progress)
  const deleted = cards[0].id
  const local = { ...deck, cards: [], deleted_ids: { [deleted]: 100 } }
  const merged = mergeDeck(local, deck)
  assert(!merged.cards.some(c => c.id === deleted))
  const tomb = filesToDocs(local, null).cards.find(c => c.id === deleted)
  assert.equal(planCardWrite(deleted, deck.cards[0], 0, tomb.data), null)
  assert.equal(await starterDeckId('account-a', lang), await starterDeckId('account-a', lang))
  assert.notEqual(await starterDeckId('account-a', lang), await starterDeckId('account-b', lang))
  assert.match(await starterDeckId('account-a', lang), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
}
// State adjectives need estar in Spanish; the French twins continue to use être.
for (const [key, spanish, french, english] of [
  ['420', 'triste', 'triste', 'sad'],
  ['421', 'cansado', 'fatigué', 'tired'],
  ['422', 'enfermo', 'malade', 'ill'],
  ['425', 'libre', 'libre', 'free'],
  ['430', 'nervioso', 'nerveux', 'nervous'],
]) {
  const es = starterCards('es').find(c => c.id === `seed-es-${key}`)
  const fr = starterCards('fr').find(c => c.id === `seed-fr-${key}`)
  assert.equal(es.example_de, `Está ${spanish}.`, `${spanish} describes a state in this example`)
  assert.equal(fr.example_de, `Il est ${french}.`)
  assert.equal(es.example_en, `He is ${english}.`)
  assert.equal(fr.example_en, `He is ${english}.`)
}
// Check the actual bundled card and generator input, not only a synthetic article token.
const homme = starterCards('fr').find(c => c.id === 'seed-fr-001')
assert.equal(homme.de, 'homme')
assert.equal(homme.article, 'l_m', 'silent-h homme must retain masculine elision')
assert.equal(homme.example_de, "Nous parlons de l'homme.")
const hommeSource = readFileSync('src/decks/vocabulary.tsv', 'utf8').split('\n').find(row => row.startsWith('001\t')).split('\t')
assert.deepEqual(hommeSource.slice(1, 3), ['l_m', 'homme'])
for (const direction of ['de-en', 'en-de']) {
  const faces = reviewFaces(homme, direction, { targetLang: 'French', baseLang: 'English' })
  const target = direction === 'de-en' ? faces.front : faces.back
  assert.equal(target.wordText, 'l’homme')
  assert.match(target.kickerHtml, /masculine/)
}
const hommeCsv = importCsv(`front,back,article,example_front\n${homme.de},${homme.en},${homme.article},${homme.example_de}`, [])
assert.deepEqual(hommeCsv.errors, [])
assert.equal(hommeCsv.imported[0].article, 'l_m')
assert.equal(hommeCsv.imported[0].example_de, "Nous parlons de l'homme.")
assert.notEqual(await starterDeckId('a','fr'), await starterDeckId('a','es'))
assert.equal(germanHead('l_f','école'), 'l’école')
assert.equal(germanHead('l_m','homme'), 'l’homme')
assert.equal(germanHead('el_f','agua'), 'el agua')
assert.equal(articleGender('el_f'), 'die')
assert.match(articleLabel('l_f'), /feminine/)
for (const [article, de, lang] of [['l_f','école','French'], ['el_f','agua','Spanish']]) {
  for (const direction of ['de-en', 'en-de']) {
    const faces = reviewFaces({ article, de, en: 'test', tags: ['noun'] }, direction, { targetLang: lang, baseLang: 'English' })
    assert(!faces.front.kickerHtml.includes('German'))
    assert.equal((direction === 'de-en' ? faces.front : faces.back).wordText, germanHead(article, de))
    assert.match((direction === 'de-en' ? faces.front : faces.back).kickerHtml, /feminine/)
    if (direction === 'en-de') assert(!faces.front.kickerHtml.includes('feminine'))
  }
}
const csv = importCsv('front,back,article,example_front,example_back,type\nécole,school,l_f,Voici l’école.,Here is the school.,noun\nagua,water,el_f,El agua está fría.,The water is cold.,noun', [])
assert.deepEqual(csv.errors, [])
assert.deepEqual(csv.imported.map(c => c.article), ['l_f','el_f'])
console.log('starter decks: content, Unicode, independent tiers, identity, article/gender rendering, CSV, cloud roundtrip and tombstones: ok')

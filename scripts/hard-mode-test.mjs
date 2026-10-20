import assert from 'node:assert/strict'
import { automaticGrade, matchAnswer } from '../src/hard-mode.ts'

const card = { de: 'Katze', en: 'cat / feline', article: 'die' }
assert.equal(matchAnswer(card, 'de-en', '  CAT! '), 'correct')
assert.equal(matchAnswer(card, 'de-en', 'feline'), 'correct')
assert.equal(matchAnswer(card, 'de-en', 'dog'), 'incorrect')
assert.equal(matchAnswer(card, 'en-de', 'DIE   Katze'), 'correct')
assert.equal(matchAnswer(card, 'en-de', 'der Katze'), 'wrong_gender')
assert.equal(matchAnswer(card, 'en-de', 'das Katze'), 'wrong_gender')
for (const answer of ['', '   ', 'Katze', 'der Hund', 'die Katse', 'a cat']) {
  assert.equal(matchAnswer(card, 'en-de', answer), 'incorrect', answer)
}
assert.equal(matchAnswer(card, 'en-de', 'Katze', { targetLang: 'German', articles: false }), 'correct')
assert.equal(matchAnswer(card, 'en-de', 'der Katze', { targetLang: 'German', articles: false }), 'incorrect')
const fr = { de: 'école', en: 'school', article: 'l_f' }
assert.equal(matchAnswer(fr, 'en-de', "l'e\u0301cole", { targetLang: 'French' }), 'correct')
assert.equal(matchAnswer(fr, 'en-de', 'l’ecole', { targetLang: 'French' }), 'incorrect')
assert.equal(matchAnswer(fr, 'en-de', 'le école', { targetLang: 'French' }), 'wrong_gender')
const es = { de: 'casa', en: 'house; home', article: 'la' }
assert.equal(matchAnswer(es, 'en-de', 'el casa', { targetLang: 'Spanish' }), 'wrong_gender')
assert.equal(matchAnswer(es, 'en-de', 'los casa', { targetLang: 'Spanish' }), 'incorrect', 'number is not gender')
assert.equal(matchAnswer({ ...es, de: 'agua', article: 'el_f' }, 'en-de', 'el agua', { targetLang: 'Spanish' }), 'correct')
assert.equal(matchAnswer(es, 'de-en', 'home'), 'correct')
assert.equal(matchAnswer({ ...card, article: 'none', de: 'gut / schön' }, 'en-de', 'schön'), 'correct')
for (const second of [false, true]) {
  assert.equal(automaticGrade('wrong_gender', second), 'wrong_gender')
  assert.equal(automaticGrade('correct', second), second ? 'good' : 'easy')
  assert.equal(automaticGrade('incorrect', second), second ? 'hard' : null)
}
console.log('Hard mode matching and automatic grades: ok')

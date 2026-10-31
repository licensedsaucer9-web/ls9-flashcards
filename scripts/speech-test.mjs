import assert from 'node:assert/strict'
import { pickVoice, speechAvailable, speechEnabled, speechLang } from '../src/speech.ts'

for (const [name, tag] of [
  ['German', 'de-DE'], ['Spanish', 'es-ES'], ['French', 'fr-FR'], ['Norwegian', 'nb-NO'], ['English', 'en-GB'],
  [' german ', 'de-DE'], ['Norsk', 'nb-NO'], ['Klingon', ''], ['', ''], [undefined, ''],
]) assert.equal(speechLang(name), tag, String(name))

const voices = [{ lang: 'en-US', name: 'US' }, { lang: 'en-GB', name: 'GB' }, { lang: 'de-AT', name: 'AT' }, { lang: 'no-NO', name: 'NO' }, { lang: 'fr_FR', name: 'FR' }]
assert.equal(pickVoice(voices, 'en-GB')?.name, 'GB', 'exact tag wins over same language')
assert.equal(pickVoice(voices, 'de-DE')?.name, 'AT', 'falls back to the same primary language')
assert.equal(pickVoice(voices, 'nb-NO')?.name, 'NO', 'Norwegian Bokmål accepts no-NO voices')
assert.equal(pickVoice(voices, 'fr-FR')?.name, 'FR', 'underscore tags match')
assert.equal(pickVoice(voices, 'es-ES'), null, 'no match lets the browser choose')
assert.equal(pickVoice(voices, ''), null, 'unknown language lets the browser choose')
assert.equal(pickVoice([], 'de-DE'), null)
assert.equal(speechAvailable(), false, 'no API outside a browser')
assert.equal(speechEnabled(), false, 'off by default')
console.log('speech: language mapping and voice selection ok')

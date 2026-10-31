import assert from 'node:assert/strict'
import { abortListening, listen, listenAvailable, listenEnabled, setListenTimings } from '../src/speech-input.ts'

assert.equal(listenAvailable(), false, 'no API outside a browser')
assert.equal(listenEnabled(), false, 'off by default')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let made = []
class FakeRecognition {
  constructor() { this.started = 0; this.aborted = 0; made.push(this) }
  start() { this.started++ }
  stop() {}
  abort() { this.aborted++ }
  emit(name, event = {}) { this[`on${name}`]?.(event) }
  result(text, isFinal) { this.emit('result', { results: [Object.assign([{ transcript: text }], { isFinal })] }) }
}
const run = (lang = 'de-DE', permission) => {
  made = []
  const events = []
  let resolve
  const done = new Promise(r => { resolve = r })
  const session = listen(lang, {
    onListening: () => events.push('listening'),
    onInterim: text => events.push(`interim:${text}`),
    onDone: outcome => { events.push('done'); resolve(outcome) },
  }, FakeRecognition, permission)
  return { rec: made[0], events, done, session }
}
setListenTimings({ startMs: 60, silenceMs: 80, stableMs: 30, hardMs: 150 })

{
  const { rec, events, done } = run('es-ES')
  assert.deepEqual([rec.lang, rec.continuous, rec.interimResults, rec.started], ['es-ES', false, true, 1])
  rec.emit('start')
  rec.result('der', false)
  rec.result('der Hund', true)
  assert.deepEqual(await done, { kind: 'heard', transcript: 'der Hund', final: true })
  assert.deepEqual(events, ['listening', 'interim:der', 'done'])
  assert.equal(rec.aborted, 1, 'the finished attempt is aborted and detached')
  assert.equal(rec.onerror, null)
}
{
  // Safari es-ES: an interim result and no final until a manual stop.
  const { rec, done } = run()
  rec.emit('start')
  rec.result('el perro', false)
  assert.deepEqual(await done, { kind: 'heard', transcript: 'el perro', final: false }, 'stable interim result accepted')
}
{
  const { rec, done } = run()
  rec.emit('audiostart')
  const t = Date.now()
  assert.deepEqual(await done, { kind: 'silence' }, 'silence cut-off ends a silent attempt')
  assert.ok(Date.now() - t >= 70)
  assert.equal(rec.aborted, 1)
}
{
  // Start delay does not count toward the silence cut-off.
  const { rec, events, done } = run()
  await wait(50)
  assert.deepEqual(events, [], 'still starting')
  rec.emit('start')
  await wait(60)
  assert.deepEqual(events, ['listening'], 'silence timer starts with listening')
  assert.deepEqual(await done, { kind: 'silence' })
}
{
  const { rec, done } = run()
  assert.deepEqual(await done, { kind: 'no-start' }, 'a start that never happens times out')
  assert.equal(rec.aborted, 1)
}
{
  // A pending microphone prompt does not count toward the start cut-off.
  const status = new EventTarget()
  status.state = 'prompt'
  const { rec, events, done } = run('de-DE', async () => status)
  await wait(120)
  assert.deepEqual(events, [], 'still waiting on the prompt')
  status.state = 'granted'
  status.dispatchEvent(new Event('change'))
  const t = Date.now()
  assert.deepEqual(await done, { kind: 'no-start' }, 'cut-off runs once access is granted')
  assert.ok(Date.now() - t >= 50)
  assert.equal(rec.aborted, 1)
}
{
  // Allowing the prompt and starting needs no extra start cut-off.
  const status = new EventTarget()
  status.state = 'prompt'
  const { rec, events, done } = run('de-DE', async () => status)
  await wait(10)
  rec.emit('start')
  status.state = 'granted'
  status.dispatchEvent(new Event('change'))
  rec.result('Maus', true)
  assert.deepEqual(await done, { kind: 'heard', transcript: 'Maus', final: true })
  assert.deepEqual(events, ['listening', 'done'])
}
{
  // Granted access keeps the cut-off; a failed query falls back to it.
  for (const permission of [async () => ({ state: 'granted' }), async () => { throw new Error('unsupported') }]) {
    const { done } = run('de-DE', permission)
    assert.deepEqual(await done, { kind: 'no-start' })
  }
}
{
  // Hung session: interim results keep changing and never finalise.
  const { rec, done } = run()
  rec.emit('start')
  let n = 0
  const tick = setInterval(() => rec.result(`wort ${n++}`, false), 15)
  const outcome = await done
  clearInterval(tick)
  assert.equal(outcome.kind, 'heard')
  assert.equal(outcome.final, false)
  assert.equal(rec.aborted, 1, 'hard timeout aborts')
}
{
  // A muted audio-capture error after a finished attempt must not reach the next one.
  const first = run()
  first.rec.emit('start')
  first.rec.result('schön', true)
  await first.done
  const firstRec = first.rec
  const second = run()
  firstRec.emit('error', { error: 'audio-capture' })
  second.rec.emit('start')
  second.rec.result('Hund', true)
  assert.deepEqual(await second.done, { kind: 'heard', transcript: 'Hund', final: true })
}
{
  const { rec, done } = run()
  rec.emit('start')
  rec.emit('error', { error: 'audio-capture', message: 'Source is muted' })
  assert.deepEqual(await done, { kind: 'error', error: 'audio-capture' })
  rec.emit('end')
}
{
  const { rec, done } = run()
  rec.emit('start')
  rec.emit('error', { error: 'no-speech' })
  assert.deepEqual(await done, { kind: 'silence' })
}
{
  const { rec, done } = run()
  rec.emit('start')
  rec.result('Katze', false)
  rec.emit('end')
  assert.deepEqual(await done, { kind: 'heard', transcript: 'Katze', final: false }, 'end keeps the interim result')
}
{
  // Only one recognition at a time; abort reports and detaches.
  const first = run()
  const firstRec = first.rec
  const second = run()
  assert.deepEqual(await first.done, { kind: 'aborted' })
  assert.equal(firstRec.aborted, 1)
  abortListening()
  assert.deepEqual(await second.done, { kind: 'aborted' })
  abortListening()
}
{
  const { rec, session, done } = run()
  rec.emit('start')
  rec.result('Vogel', false)
  session.finish()
  assert.deepEqual(await done, { kind: 'heard', transcript: 'Vogel', final: false }, 'tapping again keeps what was heard')
}
{
  made = []
  let outcome
  listen('de-DE', { onDone: o => { outcome = o } }, class extends FakeRecognition { start() { throw new Error('nope') } })
  assert.deepEqual(outcome, { kind: 'error', error: 'start-failed' })
}
setListenTimings(null)
console.log('speech input: detection, default off, final/interim/silence/start/prompt/hard timeouts, late errors, single attempt ok')

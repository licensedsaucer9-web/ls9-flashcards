import { storagePrefix } from './rehearsal.ts'

const storageKey = `${storagePrefix}.speech-input`

type ResultListLike = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>
type Handler = ((event: any) => void) | null

/** The parts of (webkit)SpeechRecognition we use; lib.dom lacks the prefixed constructor. */
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: Handler
  onaudiostart: Handler
  onresult: Handler
  onerror: Handler
  onend: Handler
  start(): void
  stop(): void
  abort(): void
}
export type RecognitionCtor = new () => SpeechRecognitionLike

/** The parts of PermissionStatus we use. */
export interface PermissionLike {
  state: string
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}
export type MicPermission = () => Promise<PermissionLike | null>

async function micPermission(): Promise<PermissionLike | null> {
  try {
    return await navigator.permissions.query({ name: 'microphone' as PermissionName })
  } catch {
    return null
  }
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return typeof ctor === 'function' ? ctor : null
}

export function listenAvailable(): boolean { return recognitionCtor() !== null }

let enabled = false
try { enabled = localStorage.getItem(storageKey) === 'true' } catch { /* Device storage is optional. */ }

/** Device-local preference, off by default; never synced. */
export function listenEnabled(): boolean { return enabled }
export function chooseListen(value: boolean): boolean {
  enabled = value
  try { localStorage.setItem(storageKey, String(value)); return true } catch { return false }
}

// Safari never ends a silent attempt on its own, can stall after interim
// results, and its first start can take over 4 s. Tests shorten these.
const defaultTimings = { startMs: 8000, silenceMs: 7000, stableMs: 1500, hardMs: 15000 }
let timings = { ...defaultTimings }
export function setListenTimings(next: Partial<typeof defaultTimings> | null): void {
  timings = { ...defaultTimings, ...next }
}

export type ListenOutcome =
  | { kind: 'heard'; transcript: string; final: boolean }
  | { kind: 'silence' | 'timeout' | 'no-start' | 'aborted' }
  | { kind: 'error'; error: string }

export interface ListenCallbacks {
  onListening?(): void
  onInterim?(transcript: string): void
  onDone(outcome: ListenOutcome): void
}

function transcriptOf(results: ResultListLike): { text: string; final: boolean } {
  const list = Array.from(results)
  const text = list.map(result => result[0]?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim()
  return { text, final: list.length > 0 && list.every(result => result.isFinal) }
}

let current: { abort(): void } | null = null

/** Stops the running attempt, if any; it ends as 'aborted' and keeps no transcript. */
export function abortListening(): void { current?.abort() }

/** Starts one attempt; a running attempt is aborted first. Call from a user gesture. */
export function listen(
  lang: string,
  callbacks: ListenCallbacks,
  ctor: RecognitionCtor | null = recognitionCtor(),
  permission: MicPermission = micPermission,
): { finish(): void } {
  abortListening()
  let done = false
  let interim = ''
  let unwatch = () => {}
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const timer = (name: string, ms: number, fire: () => void) => {
    clearTimeout(timers.get(name))
    timers.set(name, setTimeout(fire, ms))
  }
  const rec = ctor ? new ctor() : null
  const cleanup = () => {
    done = true
    for (const id of timers.values()) clearTimeout(id)
    timers.clear()
    unwatch()
    if (current === session) current = null
    if (!rec) return
    // Late events (such as a muted audio-capture error) must not reach a newer attempt.
    rec.onstart = rec.onaudiostart = rec.onresult = rec.onerror = rec.onend = null
    try { rec.abort() } catch { /* Already ended. */ }
  }
  const end = (outcome: ListenOutcome) => {
    if (done) return
    cleanup()
    callbacks.onDone(outcome)
  }
  const endWithInterim = (otherwise: ListenOutcome) =>
    end(interim ? { kind: 'heard', transcript: interim, final: false } : otherwise)
  const session = {
    abort: () => end({ kind: 'aborted' }),
    finish: () => endWithInterim({ kind: 'silence' }),
  }
  current = session
  if (!rec) {
    end({ kind: 'error', error: 'unavailable' })
    return session
  }
  let listening = false
  const startListening = () => {
    if (done || listening) return
    listening = true
    clearTimeout(timers.get('start'))
    timer('silence', timings.silenceMs, () => endWithInterim({ kind: 'silence' }))
    timer('hard', timings.hardMs, () => endWithInterim({ kind: 'timeout' }))
    callbacks.onListening?.()
  }
  rec.lang = lang
  rec.continuous = false
  rec.interimResults = true
  rec.maxAlternatives = 1
  rec.onstart = startListening
  rec.onaudiostart = startListening
  rec.onresult = (event: { results: ResultListLike }) => {
    if (done) return
    startListening()
    const { text, final } = transcriptOf(event.results)
    if (final && text) return end({ kind: 'heard', transcript: text, final: true })
    if (!text || text === interim) return
    interim = text
    callbacks.onInterim?.(text)
    timer('silence', timings.silenceMs, () => endWithInterim({ kind: 'silence' }))
    // Safari may never finalise; accept an interim result that stops changing.
    timer('stable', timings.stableMs, () => endWithInterim({ kind: 'silence' }))
  }
  rec.onerror = (event: { error?: string }) => {
    if (event.error === 'no-speech') endWithInterim({ kind: 'silence' })
    else endWithInterim({ kind: 'error', error: event.error ?? 'unknown' })
  }
  rec.onend = () => endWithInterim({ kind: 'silence' })
  // The start cut-off must not run while a microphone prompt waits for the
  // user, so it is armed once access is known to be granted (or unknowable).
  const armStart = () => {
    if (done || listening) return
    timer('start', timings.startMs, () => end({ kind: 'no-start' }))
  }
  try {
    rec.start()
  } catch {
    end({ kind: 'error', error: 'start-failed' })
    return session
  }
  void permission().then(status => {
    if (!status || status.state !== 'prompt') return armStart()
    const changed = () => {
      if (status.state === 'prompt') return
      unwatch()
      armStart()
    }
    status.addEventListener('change', changed)
    unwatch = () => status.removeEventListener('change', changed)
    if (done) unwatch()
  }, armStart)
  return session
}

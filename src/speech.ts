import { storagePrefix } from './rehearsal.ts'

const storageKey = `${storagePrefix}.speech`

const languageTags: Record<string, string> = {
  german: 'de-DE', deutsch: 'de-DE',
  spanish: 'es-ES', español: 'es-ES', espanol: 'es-ES',
  french: 'fr-FR', français: 'fr-FR', francais: 'fr-FR',
  norwegian: 'nb-NO', norsk: 'nb-NO', bokmål: 'nb-NO', bokmal: 'nb-NO',
  english: 'en-GB',
  italian: 'it-IT', portuguese: 'pt-PT', dutch: 'nl-NL', swedish: 'sv-SE', danish: 'da-DK',
}

/** BCP-47 tag for a deck language name, or '' to let the browser choose. */
export function speechLang(name: string | null | undefined): string {
  return languageTags[(name ?? '').trim().toLowerCase()] ?? ''
}

type VoiceLike = { lang: string }

/** Exact tag first, then the same primary language (nb also accepts no). */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: string): V | null {
  if (!lang) return null
  const norm = (tag: string) => tag.replace(/_/g, '-').toLowerCase()
  const want = norm(lang)
  const exact = voices.find(voice => norm(voice.lang) === want)
  if (exact) return exact
  const primary = (tag: string) => {
    const p = norm(tag).split('-')[0]
    return p === 'no' || p === 'nn' ? 'nb' : p
  }
  return voices.find(voice => primary(voice.lang) === primary(want)) ?? null
}

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function'
}

let enabled = false
try { enabled = localStorage.getItem(storageKey) === 'true' } catch { /* Device storage is optional. */ }

/** Device-local preference, off by default; never synced. */
export function speechEnabled(): boolean { return enabled }
export function chooseSpeech(value: boolean): boolean {
  enabled = value
  try { localStorage.setItem(storageKey, String(value)); return true } catch { return false }
}

export function speak(text: string, languageName: string): void {
  if (!speechAvailable() || !text.trim()) return
  const synth = window.speechSynthesis
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  const lang = speechLang(languageName)
  if (lang) {
    utterance.lang = lang
    const voice = pickVoice(synth.getVoices(), lang)
    if (voice) utterance.voice = voice
  }
  synth.speak(utterance)
}

export function cancelSpeech(): void {
  if (speechAvailable()) window.speechSynthesis.cancel()
}

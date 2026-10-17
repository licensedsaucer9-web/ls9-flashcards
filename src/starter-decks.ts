import fr from './decks/fr.json' with { type: 'json' }
import es from './decks/es.json' with { type: 'json' }
import type { Article, Card, Tier } from './types.ts'
import { newSrs } from './srs.ts'

export type StarterLanguage = 'fr' | 'es'
export const STARTERS = [
  { key: 'fr' as const, name: 'French', count: fr.cards.length },
  { key: 'es' as const, name: 'Spanish', count: es.cards.length },
]

/** Namespace is immutable; never derive card IDs from ordering, rank or translation. */
export function starterCards(language: StarterLanguage): Card[] {
  return (language === 'fr' ? fr : es).cards.map(({ rankForm: _rankForm, ...card }) => ({
    ...card, article: card.article as Article, tier: card.tier as Tier,
    created_at: 0, updated_at: 0, srs: newSrs(0),
  }))
}

/** A UUID-shaped private deck identity, stable per account (or device-study database).
 * Domain separation prevents collisions with normal random decks and between languages.
 */
export async function starterDeckId(owner: string, language: StarterLanguage): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ls9-starter-v1:${owner}:${language}`)))
  digest[6] = (digest[6] & 15) | 64
  digest[8] = (digest[8] & 63) | 128
  const h = [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

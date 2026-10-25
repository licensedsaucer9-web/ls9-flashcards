import type { Srs } from './types.ts'

/**
 * Limits that firestore.rules enforces on cloud documents. A value past one is rejected by the
 * server, stays pending forever and keeps the sync status red, so the client keeps within them.
 * scripts/limits-test.mjs compares these with the rules text.
 */
export const MAX_TERM_LENGTH = 200 // de and en
export const MAX_EXAMPLE_LENGTH = 1000 // example_de and example_en
export const MAX_TAGS = 12
export const MAX_INTERVAL_DAYS = 36500
export const MAX_EASE = 10

export interface CardText {
  de: string
  en: string
  example_de: string
  example_en: string
  tags: string[]
}

/** Why the server would reject this card's text, or null when it is within the limits. */
export function cardContentProblem(card: CardText): string | null {
  if (card.de.length > MAX_TERM_LENGTH) return `the first word or phrase is over ${MAX_TERM_LENGTH} characters`
  if (card.en.length > MAX_TERM_LENGTH) return `the translation is over ${MAX_TERM_LENGTH} characters`
  if (card.example_de.length > MAX_EXAMPLE_LENGTH || card.example_en.length > MAX_EXAMPLE_LENGTH) {
    return `an example is over ${MAX_EXAMPLE_LENGTH} characters`
  }
  if (card.tags.length > MAX_TAGS) return `it has more than ${MAX_TAGS} tags`
  return null
}

/** A schedule the server accepts. Anything beyond the cap is a century or more, so nothing studied is lost. */
export function clampSrs(srs: Srs): Srs {
  const interval = Math.min(MAX_INTERVAL_DAYS, Math.max(0, Math.round(srs.interval)))
  const ease = Math.min(MAX_EASE, srs.ease)
  return interval === srs.interval && ease === srs.ease ? srs : { ...srs, interval, ease }
}

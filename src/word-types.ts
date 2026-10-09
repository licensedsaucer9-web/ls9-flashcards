import type { Article, Direction } from './types.ts'
import { esc, germanHead } from './dom.ts'

/** Fixed display order. Matches the noun / verb / adjective chips. */
export const WORD_TYPES = ['noun', 'verb', 'adj'] as const
export type WordType = (typeof WORD_TYPES)[number]
export type WordTypeChoice = WordType | 'other'

const RESERVED = new Set<string>([...WORD_TYPES, 'other'])

export type WordTypeCard = {
  tags?: readonly string[] | null
  article?: string | null
}

export function parseWordTypeToken(raw: string): WordTypeChoice | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, '')
  if (value === 'noun') return 'noun'
  if (value === 'verb') return 'verb'
  if (value === 'adj' || value === 'adjective') return 'adj'
  if (value === 'other' || value === 'word') return 'other'
  return null
}

function isReservedTag(tag: string): boolean {
  return RESERVED.has(tag.trim().toLowerCase())
}

/** Type tags actually stored on the card, in noun / verb / adj order. */
export function savedWordTypes(tags: readonly string[]): WordType[] {
  const present = new Set(tags.map((tag) => tag.trim().toLowerCase()))
  return WORD_TYPES.filter((type) => present.has(type))
}

/**
 * Types to show for a card.
 * Stored noun/verb/adj tags win, in that fixed order.
 * An explicit `other` tag stays untyped.
 * Otherwise an article means noun, and anything else is untyped.
 */
export function wordTypes(card: WordTypeCard): WordType[] {
  const tags = card.tags ?? []
  const explicit = savedWordTypes(tags)
  if (explicit.length > 0) return explicit
  if (tags.some((tag) => tag.trim().toLowerCase() === 'other')) return []
  if (card.article && card.article !== 'none') return ['noun']
  return []
}

export function wordTypeLabel(type: WordType): string {
  return type === 'adj' ? 'adj.' : type
}

export function wordTypeSpoken(type: WordType): string {
  return type === 'adj' ? 'adjective' : type
}

/** Empty when the card has no type, so untyped words are not given a wrong label. */
export function wordTypeBadgeHtml(card: WordTypeCard): string {
  const types = wordTypes(card)
  if (types.length === 0) return ''
  const visible = types.map(wordTypeLabel).join(' · ')
  const spoken = types.map(wordTypeSpoken).join(', ')
  return `<span class="word-type" aria-label="${esc(`Word type: ${spoken}`)}">${esc(visible)}</span>`
}

export function editorWordType(tags: readonly string[], article: string): WordTypeChoice {
  const explicit = savedWordTypes(tags)
  if (explicit.length > 0) return explicit[0]
  if (tags.some((tag) => tag.trim().toLowerCase() === 'other')) return 'other'
  if (article && article !== 'none') return 'noun'
  return 'other'
}

/** Free-text tags, without the type the word-type select owns. */
export function editorTagField(tags: readonly string[]): string {
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => tag && !isReservedTag(tag))
    .join(', ')
}

function choiceTypes(choice: string, previousTags: readonly string[]): string[] {
  const selected = parseWordTypeToken(choice) ?? 'other'
  if (selected === 'other') return ['other']
  const previous = savedWordTypes(previousTags)
  if (previous.length > 1 && previous[0] === selected) return [...previous]
  return [selected]
}

/**
 * Write the select's type into tags. Non-type tags are kept.
 * Leaving the select alone keeps a card that already has several types.
 */
export function tagsWithWordType(
  tagsField: string,
  choice: string,
  previousTags: readonly string[] = [],
): string[] {
  const other = tagsField
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && !isReservedTag(tag))
  const types = choiceTypes(choice, previousTags)
  const previousOther = previousTags
    .map((tag) => tag.trim())
    .filter((tag) => tag && !isReservedTag(tag))
  const sameOther =
    previousOther.length === other.length && previousOther.every((tag, index) => tag === other[index])
  if (!sameOther) return [...types, ...other]

  const next: string[] = []
  let placed = false
  for (const tag of previousTags.map((item) => item.trim()).filter(Boolean)) {
    if (isReservedTag(tag)) {
      if (!placed) {
        next.push(...types)
        placed = true
      }
      continue
    }
    next.push(tag)
  }
  if (!placed) next.push(...types)
  return next
}

export type ReviewFace = {
  className: string
  kickerHtml: string
  wordClass: string
  wordText: string
}

function genderToken(article: string): string {
  return !article || article === 'none' ? 'none' : article
}

function articleHtml(article: string): string {
  if (!article || article === 'none') return ''
  const gender = genderToken(article)
  return `<span class="article ${gender}">${esc(article)}</span>`
}

function kicker(parts: string[]): string {
  const html = parts.filter(Boolean).join('')
  return html ? `<div class="face-kicker">${html}</div>` : ''
}

/**
 * Front and back of a review card.
 * EN→DE keeps the article and gender colour on the back only.
 */
export function reviewFaces(
  card: { de: string; en: string; article: Article; tags?: readonly string[] | null },
  direction: Direction,
): { front: ReviewFace; back: ReviewFace } {
  const gender = genderToken(card.article)
  const badge = wordTypeBadgeHtml(card)
  const article = articleHtml(card.article)
  const deText = germanHead(card.article, card.de)
  const frontIsDe = direction === 'de-en'
  const english = '<span class="prompt">English</span>'
  return {
    front: {
      className: frontIsDe ? `face front gender-${gender}` : 'face front',
      kickerHtml: kicker(frontIsDe ? [article, badge] : [english, badge]),
      wordClass: frontIsDe ? gender : '',
      wordText: frontIsDe ? deText : card.en,
    },
    back: {
      className: `face back gender-${gender}`,
      kickerHtml: kicker(frontIsDe ? [english, badge] : [article, badge]),
      wordClass: frontIsDe ? '' : gender,
      wordText: frontIsDe ? card.en : deText,
    },
  }
}

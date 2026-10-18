import { tierLabel } from './tiers.ts'
import { articleGender, articleLabel } from './articles.ts'
import type { Article, Direction, Tier, WordType } from './types.ts'
import { esc, germanHead } from './dom.ts'

export type { WordType }

/** Fixed display order. Matches the noun / verb / adjective chips. */
export const WORD_TYPES: readonly WordType[] = ['noun', 'verb', 'adj']
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

/**
 * Canonical filter. Unknown values are dropped. Duplicates collapse.
 * Missing, empty, and non-lists all mean every type.
 */
export function normalizeWordTypes(value: unknown): WordType[] {
  if (!Array.isArray(value)) return []
  const present = new Set<WordType>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const parsed = parseWordTypeToken(item)
    if (parsed && parsed !== 'other') present.add(parsed)
  }
  return WORD_TYPES.filter((type) => present.has(type))
}

/** Strict list for rules and migration: canonical tokens, no duplicates, any order. */
export function validWordTypeList(value: unknown): value is WordType[] {
  if (!Array.isArray(value) || value.length > WORD_TYPES.length) return false
  const seen = new Set<string>()
  for (const item of value) {
    if (item !== 'noun' && item !== 'verb' && item !== 'adj') return false
    if (seen.has(item)) return false
    seen.add(item)
  }
  return true
}

export function sameWordTypes(a: unknown, b: unknown): boolean {
  const left = normalizeWordTypes(a)
  const right = normalizeWordTypes(b)
  return left.length === right.length && left.every((type, index) => type === right[index])
}

/** Empty selection matches every card, including untyped ones. Otherwise any selected type matches. */
export function inSelectedWordTypes(card: WordTypeCard, selected: readonly WordType[]): boolean {
  const chosen = normalizeWordTypes(selected)
  if (chosen.length === 0) return true
  const types = wordTypes(card)
  return chosen.some((type) => types.includes(type))
}

/** Picking a type while All is on starts a selection. Removing the last type returns to All. */
export function toggleWordType(selected: readonly WordType[], type: WordType): WordType[] {
  const current = normalizeWordTypes(selected)
  if (!current.includes(type)) return normalizeWordTypes([...current, type])
  return current.filter((item) => item !== type)
}

export type WordTypeCount = { words: number; due: number }
export type WordTypeCounts = Record<'all' | WordType, WordTypeCount>

/** One pass. A card with several types counts in each of them, and once in All. */
export function countWordTypes(cards: readonly (WordTypeCard & { due?: boolean })[]): WordTypeCounts {
  const blank = (): WordTypeCount => ({ words: 0, due: 0 })
  const out: WordTypeCounts = { all: blank(), noun: blank(), verb: blank(), adj: blank() }
  for (const card of cards) {
    const due = card.due === true
    out.all.words += 1
    if (due) out.all.due += 1
    for (const type of wordTypes(card)) {
      out[type].words += 1
      if (due) out[type].due += 1
    }
  }
  return out
}

const TYPE_PLURALS: Record<WordType, string> = {
  noun: 'nouns',
  verb: 'verbs',
  adj: 'adjectives',
}

function englishList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? 'cards'
  if (items.length === 2) return `${items[0]} or ${items[1]}`
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** Shown when the selected types have nothing due. Empty selection is not a filter. */
export function noDueWordTypeMessage(selected: readonly WordType[], tier: Tier | readonly Tier[]): string {
  const names = normalizeWordTypes(selected).map((type) => TYPE_PLURALS[type])
  return `No ${englishList(names)} due in ${typeof tier === 'number' ? `Tier ${tier}` : tierLabel(tier)}`
}

const TYPE_CHIP_LABELS: Record<WordType, string> = {
  noun: 'Nouns',
  verb: 'Verbs',
  adj: 'Adjectives',
}

/** Empty when every type is included, so the tier label can stay as it was. */
export function wordTypeSelectionLabel(selected: readonly WordType[]): string {
  return normalizeWordTypes(selected).map((type) => TYPE_CHIP_LABELS[type]).join(', ')
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

/** Edit free tags while leaving hidden type metadata exactly as saved. */
export function tagsWithoutTypeEdit(tagsField: string, previousTags: readonly string[] = []): string[] {
  const types = previousTags.filter(isReservedTag)
  const other = tagsField.split(',').map(tag => tag.trim()).filter(tag => tag && !isReservedTag(tag))
  if (editorTagField(previousTags) === other.join(', ')) return [...previousTags]
  return [...types, ...other]
}

export type ReviewFace = {
  className: string
  kickerHtml: string
  wordClass: string
  wordText: string
}

function genderToken(article: string): string {
  return articleGender(article)
}

function articleHtml(article: string): string {
  if (!article || article === 'none') return ''
  const gender = genderToken(article)
  return `<span class="article ${gender}">${esc(articleLabel(article))}</span>`
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
  languages: { targetLang: string; baseLang: string; articles?: boolean; supportsWordTypes?: boolean } = { targetLang: 'German', baseLang: 'English' },
): { front: ReviewFace; back: ReviewFace } {
  const visibleArticle = languages.articles === false ? 'none' : card.article
  const gender = genderToken(visibleArticle)
  const badge = languages.supportsWordTypes === false ? '' : wordTypeBadgeHtml(card)
  const article = articleHtml(visibleArticle)
  const deText = germanHead(visibleArticle, card.de)
  const frontIsDe = direction === 'de-en'
  const target = `<span class="prompt">${esc(languages.targetLang)}</span>`
  const base = `<span class="prompt">${esc(languages.baseLang)}</span>`
  return {
    front: {
      className: frontIsDe ? `face front gender-${gender}` : 'face front',
      kickerHtml: kicker(frontIsDe ? [target, article, badge] : [base, badge]),
      wordClass: frontIsDe ? gender : '',
      wordText: frontIsDe ? deText : card.en,
    },
    back: {
      className: `face back gender-${gender}`,
      kickerHtml: kicker(frontIsDe ? [base, badge] : [target, article, badge]),
      wordClass: frontIsDe ? '' : gender,
      wordText: frontIsDe ? card.en : deText,
    },
  }
}

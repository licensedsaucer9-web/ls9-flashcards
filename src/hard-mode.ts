import { articleGender, articleText, articlesFor } from './articles.ts'
import { germanHead } from './dom.ts'
import type { Article, Direction, Grade } from './types.ts'

type AnswerCard = { de: string; en: string; article: Article }
type Languages = { targetLang: string; articles?: boolean }
export type AnswerMatch = 'correct' | 'wrong_gender' | 'incorrect'

/** Preserve accents and word punctuation; normalize typography, case and spacing. */
export function normalizeAnswer(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase().replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim()
}

/** Saved slash/semicolon-separated translations are alternatives, not a required list. */
function alternatives(value: string): string[] {
  return [value, ...value.split(/\s*[\/;]\s*/)].map(normalizeAnswer).filter(Boolean)
}

function withArticle(article: Article, word: string): string {
  return normalizeAnswer(germanHead(article, word))
}

export function matchAnswer(card: AnswerCard, direction: Direction, answer: string,
  languages: Languages = { targetLang: 'German' }): AnswerMatch {
  const entered = normalizeAnswer(answer)
  if (!entered) return 'incorrect'
  if (direction === 'de-en') return alternatives(card.en).includes(entered) ? 'correct' : 'incorrect'
  const words = alternatives(card.de)
  const article = languages.articles === false ? 'none' : card.article
  if (words.some(word => withArticle(article, word) === entered)) return 'correct'
  if (article === 'none') return 'incorrect'
  // Only a recognized article of a different gender with the exact right word
  // earns Gender. Missing articles, number mistakes and misspelled words do not.
  const wrongArticles = articlesFor(languages.targetLang).filter(candidate =>
    candidate !== 'none' && articleGender(candidate) !== articleGender(article)
    && /^(los|las|les_)/.test(candidate) === /^(los|las|les_)/.test(article)
    && articleText(candidate) !== articleText(article))
  if (wrongArticles.some(candidate => words.some(word => withArticle(candidate, word) === entered))) return 'wrong_gender'
  return 'incorrect'
}

/** null means one retry without revealing the answer or writing a review. */
export function automaticGrade(match: AnswerMatch, secondTry: boolean): Grade | null {
  if (match === 'wrong_gender') return 'wrong_gender'
  if (match === 'correct') return secondTry ? 'good' : 'easy'
  return secondTry ? 'hard' : null
}

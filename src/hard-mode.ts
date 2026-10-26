import { articleGender, articleText, articlesFor } from './articles.ts'
import { germanHead } from './dom.ts'
import type { Article, Direction, Grade } from './types.ts'

type AnswerCard = { de: string; en: string; article: Article }
type Languages = { targetLang: string; articles?: boolean }
export type AnswerMatch = 'correct' | 'wrong_gender' | 'incorrect'

/** Preserve accents and word punctuation; normalize typography, case and spacing. */
export function normalizeAnswer(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim()
}

const GERMAN_DIGRAPHS: Record<string, string> = { ß: 'ss', ä: 'ae', ö: 'oe', ü: 'ue' }

/**
 * What two answers are compared on: normalizeAnswer, then punctuation inside the answer
 * ignored ("a beer please" = "A beer, please.") and German umlauts and ß interchangeable with
 * their ae/oe/ue/ss spellings. Other accents stay significant. Brackets and slashes are not
 * touched; they separate alternatives and glosses.
 */
export function answerKey(value: string): string {
  return normalizeAnswer(value).replace(/[ßäöü]/g, ch => GERMAN_DIGRAPHS[ch])
    .replace(/[.,;:!?¿¡"“”„«»…]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Split alternatives only outside glosses such as “stop (bus/tram)”. */
function alternatives(value: string): string[] {
  const parts = [value]
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (value[i] === '/' || value[i] === ';')) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }
  parts.push(value.slice(start))
  // Trailing parenthetical notes disambiguate the prompt; they need not be typed.
  // Keep the complete saved answer valid, without accepting the gloss by itself.
  return parts.flatMap(part => [part, part.replace(/(?:\s*\([^()]*\))+\s*$/, '')])
    .map(answerKey).filter(Boolean)
}

function withArticle(article: Article, word: string): string {
  return answerKey(germanHead(article, word))
}

export function matchAnswer(card: AnswerCard, direction: Direction, answer: string,
  languages: Languages = { targetLang: 'German' }): AnswerMatch {
  const entered = answerKey(answer)
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
  // Missing it twice means it was not remembered; 'hard' would lengthen a learned card's interval.
  return secondTry ? 'again' : null
}

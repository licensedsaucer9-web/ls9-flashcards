import type { Article } from './types.ts'

/** Elision and stressed-a articles retain grammatical gender in their stored token. */
export function articleText(article: string): string {
  return ({ l_m: 'l’', l_f: 'l’', el_f: 'el', les_m: 'les', les_f: 'les' })[article] ?? article
}
export function articleLabel(article: string): string {
  return ({ le: 'le · masculine', la: 'la · feminine', l_m: 'l’ · masculine', l_f: 'l’ · feminine',
    el: 'el · masculine', el_f: 'el · feminine (stressed a)', los: 'los · masculine plural', las: 'las · feminine plural',
    les_m: 'les · masculine plural', les_f: 'les · feminine plural' })[article] ?? article
}
/** Reuse the original masculine/feminine/neuter palette without changing German classes. */
export function articleGender(article: string): string {
  if (['le', 'l_m', 'el', 'los', 'les_m'].includes(article)) return 'der'
  if (['la', 'l_f', 'el_f', 'las', 'les_f'].includes(article)) return 'die'
  return !article || article === 'none' ? 'none' : article
}
export function articlesFor(language: string): Article[] {
  if (language.toLowerCase() === 'french') return ['le', 'la', 'l_m', 'l_f', 'les_m', 'les_f', 'none']
  if (language.toLowerCase() === 'spanish') return ['el', 'la', 'el_f', 'los', 'las', 'none']
  return ['der', 'die', 'das', 'none']
}

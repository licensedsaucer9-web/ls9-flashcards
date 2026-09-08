export type Article = 'der' | 'die' | 'das' | 'none'
export type Grade = 'again' | 'wrong_gender' | 'hard' | 'good' | 'easy'
export type Direction = 'de-en' | 'en-de'

export interface Srs {
  ease: number
  interval: number
  reps: number
  due: number
}

export interface Card {
  id: string
  de: string
  en: string
  article: Article
  example_de: string
  example_en: string
  tags: string[]
  created_at: number
  updated_at: number
  srs: Srs
}

export interface Settings {
  id: 'settings'
  direction: Direction
  /** 0 means review every due card. */
  sessionSize: number
  deletedIds: Record<string, number>
}

export type Snapshot = {
  version: 1
  updated_at: number
  settings: Pick<Settings, 'direction' | 'sessionSize'>
  cards: Card[]
  deleted_ids: Record<string, number>
}

export type GithubConfig = {
  token: string
  owner: string
  repo: string
  path: string
  branch: string
}

export const ARTICLES: Article[] = ['der', 'die', 'das', 'none']
export const GRADES: Grade[] = ['again', 'wrong_gender', 'hard', 'good', 'easy']

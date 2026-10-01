export type Article = 'der' | 'die' | 'das' | 'none'
export type Grade = 'again' | 'wrong_gender' | 'hard' | 'good' | 'easy'
export type Direction = 'de-en' | 'en-de'
export type Tier = 1 | 2 | 3

/** Nominal cumulative deck sizes. Tier 1 is the first 100 words, tier 2 the first 250, tier 3 the rest. */
export const TIER_CUMULATIVE: Record<Tier, number> = { 1: 100, 2: 250, 3: Number.MAX_SAFE_INTEGER }
export const TIERS: Tier[] = [1, 2, 3]

export interface Srs {
  ease: number
  interval: number
  reps: number
  due: number
  /**
   * When this scheduling state was last written. Progress syncs per user, so two
   * devices merge schedules on their own clock rather than on the card's edit time.
   * Absent on cards written before per-user progress existed.
   */
  updated_at?: number
}

export interface Card {
  id: string
  de: string
  en: string
  article: Article
  example_de: string
  example_en: string
  tags: string[]
  /** Corpus frequency rank, lower is more common. Built-in cards only. */
  rank?: number
  /** Which tier this card belongs to. Baked for built-in cards, set by hand for new ones. */
  tier?: Tier
  created_at: number
  updated_at: number
  srs: Srs
}

export interface Settings {
  id: 'settings'
  direction: Direction
  /** 0 means review every due card. */
  sessionSize: number
  /** Highest tier included in reviews. Higher tiers include the lower ones. */
  tier: Tier
  deletedIds: Record<string, number>
  /** Local writes are numbered in the same transaction as their data. */
  localRevision: number
  acknowledgedRevision: number
  settingsUpdatedAt: number
  /**
   * Per-record upload markers. They live on this row so a sync client can ack
   * one record without a schema bump. GitHub payloads omit them.
   */
  pending: PendingRecords
  /**
   * Schedules copied from a signed-out database before the account's cards
   * existed. Applied after a pull, then removed. Omitted from GitHub payloads.
   */
  stagedProgress?: Record<string, Srs>
}

/** One local edit of a single record, and the revision the server has confirmed. */
export interface RecordMark {
  revision: number
  acked: number
}

export interface PendingRecords {
  cards: Record<string, RecordMark>
  tombstones: Record<string, RecordMark>
  progress: Record<string, RecordMark>
  settings: RecordMark | null
}

/** The settings that travel between devices. */
export type PublicSettings = Pick<Settings, 'direction' | 'sessionSize' | 'tier'>

/** The fields that make up a card's vocabulary, without any user's progress. */
export type CardContent = Pick<
  Card,
  'id' | 'de' | 'en' | 'article' | 'example_de' | 'example_en' | 'tags' | 'rank' | 'tier' | 'created_at' | 'updated_at'
>

/**
 * The vocabulary half of a user's state, shared by every user of a repo.
 * Card scheduling lives in a UserFile so one user's reviews never overwrite another's.
 */
export interface DeckFile {
  version: 2
  kind: 'deck'
  updated_at: number
  cards: CardContent[]
  deleted_ids: Record<string, number>
}

/** One user's scheduling state and preferences. */
export interface UserFile {
  version: 2
  kind: 'user'
  user: string
  /** Newest settings or progress write in this file. */
  updated_at: number
  settings: PublicSettings
  /** Settings-only clock, so a review cannot win the settings merge. */
  settings_updated_at?: number
  /** card id to scheduling state. */
  progress: Record<string, Srs>
}

/**
 * The pre-multi-user single-file snapshot. Still read so an existing data.json
 * can be claimed by a user; never written.
 */
export type Snapshot = {
  version: 1
  updated_at: number
  settings: Pick<Settings, 'direction' | 'sessionSize'>
  cards: Card[]
  deleted_ids: Record<string, number>
  /** Optional so existing version-1 data.json files still load. */
  settings_updated_at?: number
}

export const ARTICLES: Article[] = ['der', 'die', 'das', 'none']
export const GRADES: Grade[] = ['again', 'wrong_gender', 'hard', 'good', 'easy']

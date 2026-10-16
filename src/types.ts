import type { ReviewActivity } from './streak.ts'

export type Article = 'der' | 'die' | 'das' | 'none'
export type Grade = 'again' | 'wrong_gender' | 'hard' | 'good' | 'easy'
export type Direction = 'de-en' | 'en-de'
export type Tier = 1 | 2 | 3
/** Classes a review can be limited to. An empty list means every class, including untyped cards. */
export type WordType = 'noun' | 'verb' | 'adj'

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
  /** Present on every stored card; omitted by legacy/import inputs. */
  deckId?: string
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

/** Local deck metadata and study preferences; cards remain in their current store. */
export interface LocalDeck extends PublicSettings {
  id: string
  name: string
  targetLang: string
  baseLang: string
  articles: boolean
  supportsWordTypes: boolean
  tiers: boolean
  /** The German deck mirrors the account's cloud deck. Created decks sync cards only. */
  origin: 'original' | 'local'
}

export interface Settings {
  id: 'settings'
  /** Local selection only; never included in PublicSettings or Firestore. */
  activeDeckId: string
  /** Original deck preferences, mirrored here for cloud compatibility. */
  direction: Direction
  /** 0 means all matching due cards, or all matching cards when none are due. */
  sessionSize: number
  /** Highest tier included in reviews. Higher tiers include the lower ones. */
  tier: Tier
  /**
   * Word classes included in reviews. Empty means all of them, including cards
   * with no class. Older settings rows omit this and mean the same thing.
   */
  wordTypes: WordType[]
  deletedIds: Record<string, number>
  /** Local ownership of deletion records; omitted from cloud payloads. */
  deletedDeckIds?: Record<string, string>
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
  /** Owning deck; older original-deck markers may omit it. */
  deckId?: string
}

export interface PendingRecords {
  cards: Record<string, RecordMark>
  tombstones: Record<string, RecordMark>
  progress: Record<string, RecordMark>
  settings: RecordMark | null
  activity?: Record<string, RecordMark>
}

/** The settings that travel between devices. */
export type PublicSettings = Pick<Settings, 'direction' | 'sessionSize' | 'tier' | 'wordTypes'>

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
  /** Saved review events, absent in files predating streaks. */
  activity?: ReviewActivity
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

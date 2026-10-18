import { reviewTiers, validSelectedTiers } from './tiers.ts'
import { legacyToFiles, parseRemoteDeck } from './merge.ts'
import type { CardContent, DeckFile, Direction, PublicSettings, Srs, Tier, UserFile, WordType } from './types.ts'
import { normalizeWordTypes } from './word-types.ts'
import { parseReviewActivity, type ReviewEvent } from './streak.ts'

/** Client-creatable account shape. Migration completion is not one of these values. */
export const SCHEMA_VERSION = 1
export const NEW_MIGRATION_STATUS = 'new'

export type UserAccountDoc = {
  deckId: string
  schemaVersion: number
  migrationStatus: string
}

export type SettingsDoc = {
  direction: Direction
  sessionSize: number
  tier: Tier
  selectedTiers?: Tier[]
  settingsUpdatedAt: number
  /** Absent or empty means every word type. Only noun, verb, and adj are stored. */
  wordTypes?: WordType[]
}

export type ProgressDoc = {
  ease: number
  interval: number
  reps: number
  due: number
  /** 0 means the schedule was written before this clock existed. */
  updated_at: number
}

export type CardDoc = {
  de: string
  en: string
  article: CardContent['article']
  example_de: string
  example_en: string
  tags: string[]
  created_at: number
  updated_at: number
  /** 0 means the card is present. A positive time is a tombstone, not a missing document. */
  deletedAt: number
  rank?: number
  tier?: Tier
}

export type NamedDoc<T> = { id: string; data: T }

export type CloudDocs = {
  cards: NamedDoc<CardDoc>[]
  progress: NamedDoc<ProgressDoc>[]
  settings: SettingsDoc
  activity?: NamedDoc<ReviewEvent>[]
}

export function newUserAccount(uid: string): UserAccountDoc {
  return { deckId: uid, schemaVersion: SCHEMA_VERSION, migrationStatus: NEW_MIGRATION_STATUS }
}

export function settingsToDoc(settings: PublicSettings, settingsUpdatedAt: number): SettingsDoc {
  const doc: SettingsDoc = {
    direction: settings.direction,
    sessionSize: settings.sessionSize,
    tier: settings.tier,
    settingsUpdatedAt: settingsUpdatedAt > 0 ? settingsUpdatedAt : 0,
  }
  if (validSelectedTiers(settings.selectedTiers)) doc.selectedTiers = reviewTiers(settings)
  const wordTypes = normalizeWordTypes(settings.wordTypes)
  // An empty list is All, which is also what a document written before this field means.
  if (wordTypes.length > 0) doc.wordTypes = wordTypes
  return doc
}

export function progressToDoc(srs: Srs): ProgressDoc {
  return {
    ease: srs.ease,
    interval: srs.interval,
    reps: srs.reps,
    due: srs.due,
    updated_at: srs.updated_at && srs.updated_at > 0 ? srs.updated_at : 0,
  }
}

export function cardToDoc(card: CardContent, deletedAt = 0): CardDoc {
  const doc: CardDoc = {
    de: card.de,
    en: card.en,
    article: card.article,
    example_de: card.example_de,
    example_en: card.example_en,
    tags: [...card.tags],
    created_at: card.created_at,
    updated_at: card.updated_at,
    deletedAt: deletedAt > 0 ? deletedAt : 0,
  }
  if (typeof card.rank === 'number') doc.rank = card.rank
  if (card.tier === 1 || card.tier === 2 || card.tier === 3) doc.tier = card.tier
  return doc
}

function emptyCard(deletedAt: number): CardDoc {
  return {
    de: '',
    en: '',
    article: 'none',
    example_de: '',
    example_en: '',
    tags: [],
    created_at: 0,
    updated_at: deletedAt,
    deletedAt,
  }
}

/** One document per card id. A deleted id stays as a document with deletedAt set. */
export function filesToDocs(deck: DeckFile, user: UserFile | null): CloudDocs {
  const byId = new Map<string, CardDoc>()
  for (const card of deck.cards) {
    const deletedAt = Number(deck.deleted_ids[card.id]) || 0
    byId.set(card.id, cardToDoc(card, deletedAt))
  }
  for (const [id, time] of Object.entries(deck.deleted_ids)) {
    if (byId.has(id)) continue
    byId.set(id, emptyCard(Number(time) || 0))
  }
  const progress: NamedDoc<ProgressDoc>[] = []
  if (user) {
    for (const [id, srs] of Object.entries(user.progress)) {
      progress.push({ id, data: progressToDoc(srs) })
    }
  }
  return {
    cards: [...byId.entries()].map(([id, data]) => ({ id, data })),
    progress,
    ...(user?.activity ? { activity: Object.entries(user.activity).map(([id, data]) => ({ id, data })) } : {}),
    settings: settingsToDoc(
      user?.settings ?? { direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: [] },
      user?.settings_updated_at ?? 0,
    ),
  }
}

/**
 * Deck files keep deletions as ids and times, so a tombstone's vocabulary stays
 * on the document and is not copied back into the cards array.
 */
export function docsToFiles(docs: CloudDocs, profileName: string, updatedAt: number): { deck: DeckFile; user: UserFile } {
  const cards: CardContent[] = []
  const deleted_ids: Record<string, number> = {}
  const progress: Record<string, Srs> = {}
  for (const { id, data } of docs.cards) {
    if (data.deletedAt > 0) {
      deleted_ids[id] = data.deletedAt
      continue
    }
    const card: CardContent = {
      id,
      de: data.de,
      en: data.en,
      article: data.article,
      example_de: data.example_de,
      example_en: data.example_en,
      tags: [...data.tags],
      created_at: data.created_at,
      updated_at: data.updated_at,
    }
    if (typeof data.rank === 'number') card.rank = data.rank
    if (data.tier) card.tier = data.tier
    cards.push(card)
  }
  for (const { id, data } of docs.progress) {
    progress[id] = {
      ease: data.ease,
      interval: data.interval,
      reps: data.reps,
      due: data.due,
      ...(data.updated_at > 0 ? { updated_at: data.updated_at } : {}),
    }
  }
  return {
    deck: { version: 2, kind: 'deck', updated_at: updatedAt, cards, deleted_ids },
    user: {
      version: 2,
      kind: 'user',
      user: profileName,
      updated_at: updatedAt,
      settings_updated_at: docs.settings.settingsUpdatedAt,
      settings: {
        direction: docs.settings.direction,
        sessionSize: docs.settings.sessionSize,
        tier: docs.settings.tier,
        ...(validSelectedTiers(docs.settings.selectedTiers) ? { selectedTiers: reviewTiers(docs.settings) } : {}),
        wordTypes: normalizeWordTypes(docs.settings.wordTypes),
      },
      progress,
      ...(docs.activity?.length ? { activity: parseReviewActivity(Object.fromEntries(docs.activity.map(({ id, data }) => [id, data]))) } : {}),
    },
  }
}

/**
 * Turn a v2 deck file or a v1 snapshot into documents. A v1 snapshot's progress
 * is credited to profileName, matching legacyToFiles.
 */
export function remoteToDocs(raw: unknown, profileName: string): CloudDocs | null {
  const parsed = parseRemoteDeck(raw)
  if (!parsed) return null
  if (parsed.kind === 'legacy') {
    const files = legacyToFiles(parsed.snapshot, profileName)
    return filesToDocs(files.deck, files.user)
  }
  return filesToDocs(parsed.file, null)
}

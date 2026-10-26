import { validSelectedTiers } from './tiers.ts'
import { legacyToFiles, mergeProgress, parseDeckFile, parseSnapshot, parseUserFile } from './merge.ts'
import type { CardContent, DeckFile, PublicSettings, Srs, UserFile } from './types.ts'
import { isTier } from './types.ts'
import { validWordTypeList } from './word-types.ts'

export type MigrationMapping = {
  version: 1
  projectId: string
  deckId: string
  profiles: Record<string, string>
  v1Profile?: string
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Migration validation: ${message}`)
}

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validMigrationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}

function clock(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function validateMapping(raw: unknown): MigrationMapping {
  requireValue(object(raw) && raw.version === 1, 'mapping must have version 1')
  requireValue(typeof raw.projectId === 'string' && /^[a-z][a-z0-9-]{4,62}$/.test(raw.projectId), 'invalid projectId')
  requireValue(validMigrationId(raw.deckId), 'invalid deckId')
  requireValue(object(raw.profiles) && Object.keys(raw.profiles).length > 0, 'mapping has no profiles')
  const profiles: Record<string, string> = {}
  const uids = new Set<string>()
  for (const [profile, uid] of Object.entries(raw.profiles)) {
    requireValue(/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile) && profile !== 'guest', `invalid or guest profile ${profile}`)
    requireValue(validMigrationId(uid) && !uids.has(uid), `invalid or duplicate UID for ${profile}`)
    profiles[profile] = uid
    uids.add(uid)
  }
  requireValue(!uids.has(raw.deckId), 'legacy deckId must differ from personal UIDs')
  if (raw.v1Profile !== undefined) {
    requireValue(typeof raw.v1Profile === 'string' && Object.hasOwn(profiles, raw.v1Profile), 'v1Profile must be mapped explicitly')
  }
  return { version: 1, projectId: raw.projectId, deckId: raw.deckId, profiles,
    ...(raw.v1Profile ? { v1Profile: raw.v1Profile as string } : {}) }
}

export function validateSettings(raw: unknown): asserts raw is PublicSettings {
  requireValue(object(raw), 'missing settings')
  requireValue(raw.direction === 'de-en' || raw.direction === 'en-de', 'invalid direction')
  requireValue(clock(raw.sessionSize) && (raw.sessionSize as number) <= 500, 'invalid sessionSize')
  requireValue(raw.tier === undefined || isTier(raw.tier), 'invalid tier')
  requireValue(raw.selectedTiers === undefined || validSelectedTiers(raw.selectedTiers), 'invalid selectedTiers')
  requireValue(raw.wordTypes === undefined || validWordTypeList(raw.wordTypes), 'invalid wordTypes')
}

export function validateSrs(raw: unknown, id: string): asserts raw is Srs {
  requireValue(validMigrationId(id) && object(raw), `invalid progress ${id}`)
  requireValue(typeof raw.ease === 'number' && Number.isFinite(raw.ease) && raw.ease > 0 && raw.ease <= 10, `invalid ease ${id}`)
  requireValue(clock(raw.interval) && (raw.interval as number) <= 36500, `invalid interval ${id}`)
  requireValue(clock(raw.reps) && (raw.reps as number) <= 100000, `invalid reps ${id}`)
  requireValue(clock(raw.due) && (raw.updated_at === undefined || clock(raw.updated_at)), `invalid progress clock ${id}`)
}

export function validateCard(raw: unknown): asserts raw is CardContent {
  requireValue(object(raw) && validMigrationId(raw.id), 'invalid card id')
  for (const [field, max] of [['de', 200], ['en', 200], ['example_de', 1000], ['example_en', 1000]] as const) {
    requireValue(typeof raw[field] === 'string' && (raw[field] as string).length <= max, `invalid ${field} ${raw.id}`)
  }
  requireValue(['der', 'die', 'das', 'le', 'la', 'l_m', 'l_f', 'el', 'el_f', 'los', 'las', 'les_m', 'les_f', 'none'].includes(raw.article as string), `invalid article ${raw.id}`)
  requireValue(Array.isArray(raw.tags) && raw.tags.length <= 12 && raw.tags.every((tag) => typeof tag === 'string'), `invalid tags ${raw.id}`)
  requireValue(clock(raw.created_at) && clock(raw.updated_at), `invalid content clock ${raw.id}`)
  requireValue(raw.rank === undefined || (clock(raw.rank) && (raw.rank as number) <= 1000000), `invalid rank ${raw.id}`)
  requireValue(raw.tier === undefined || isTier(raw.tier), `invalid card tier ${raw.id}`)
}

export function validateTombstones(raw: unknown): asserts raw is Record<string, number> {
  requireValue(object(raw), 'missing tombstones')
  for (const [id, time] of Object.entries(raw)) requireValue(validMigrationId(id) && clock(time) && (time as number) > 0, `invalid tombstone ${id}`)
}

/** Validate before the permissive legacy parsers can drop or repair records. */
export function migrationFiles(rawDeck: unknown, rawUsers: Record<string, unknown>, mapping: MigrationMapping): {
  deck: DeckFile; users: Record<string, UserFile>; skipped: string[]
} {
  requireValue(object(rawDeck) && [1, 2].includes(rawDeck.version as number) && Array.isArray(rawDeck.cards), 'invalid data.json')
  requireValue(clock(rawDeck.updated_at), 'invalid deck clock')
  validateTombstones(rawDeck.deleted_ids)
  const ids = new Set<string>()
  for (const card of rawDeck.cards) {
    validateCard(card)
    requireValue(!ids.has(card.id), `duplicate card ${card.id}`)
    ids.add(card.id)
    if (rawDeck.version === 1) validateSrs((card as unknown as { srs: unknown }).srs, card.id)
  }
  let deck: DeckFile
  const users: Record<string, UserFile> = {}
  if (rawDeck.version === 1) {
    requireValue(mapping.v1Profile, 'v1 snapshot needs an explicitly mapped v1Profile')
    validateSettings(rawDeck.settings)
    requireValue(rawDeck.settings_updated_at === undefined || clock(rawDeck.settings_updated_at), 'invalid v1 settings clock')
    const split = legacyToFiles(parseSnapshot(rawDeck)!, mapping.v1Profile)
    deck = split.deck
    users[mapping.v1Profile] = split.user
  } else {
    requireValue(rawDeck.kind === 'deck', 'v2 data.json must be a deck')
    deck = parseDeckFile(rawDeck)!
  }
  const skipped: string[] = []
  for (const [profile, raw] of Object.entries(rawUsers)) {
    if (profile === 'guest' || !Object.hasOwn(mapping.profiles, profile)) { skipped.push(profile); continue }
    requireValue(object(raw) && raw.version === 2 && raw.kind === 'user' && raw.user === profile, `invalid user file ${profile}`)
    requireValue(clock(raw.updated_at) && (raw.settings_updated_at === undefined || clock(raw.settings_updated_at)), `invalid user clock ${profile}`)
    validateSettings(raw.settings)
    requireValue(object(raw.progress), `missing progress ${profile}`)
    for (const [id, srs] of Object.entries(raw.progress)) validateSrs(srs, id)
    const parsed = parseUserFile(raw)!
    const legacy = users[profile]
    if (legacy) {
      parsed.progress = mergeProgress(legacy.progress, parsed.progress)
      if ((legacy.settings_updated_at ?? 0) > (parsed.settings_updated_at ?? 0)) {
        parsed.settings = legacy.settings
        parsed.settings_updated_at = legacy.settings_updated_at
      }
    }
    users[profile] = parsed
  }
  for (const profile of Object.keys(mapping.profiles)) requireValue(Object.hasOwn(users, profile), `mapped profile ${profile} has no source data`)
  return { deck, users, skipped }
}

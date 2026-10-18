import { reviewTiers, validSelectedTiers } from './tiers.ts'
import type { Card, CardContent, DeckFile, PublicSettings, Snapshot, Srs, UserFile } from './types.ts'
import { normalizeWordTypes } from './word-types.ts'
import { parseStoredReviewActivity } from './streak.ts'

export function emptyDeck(now = Date.now()): DeckFile {
  return { version: 2, kind: 'deck', updated_at: now, cards: [], deleted_ids: {} }
}

export function emptyUser(user: string, now = Date.now()): UserFile {
  return {
    version: 2,
    kind: 'user',
    user,
    updated_at: now,
    settings: { direction: 'en-de', sessionSize: 20, tier: 1, wordTypes: [] },
    progress: {},
  }
}

function obj(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function int(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback
}

// --- reading remote files -------------------------------------------------

/** A v2 deck file. Rejects anything else so a corrupt write cannot wipe a deck. */
export function parseDeckFile(raw: unknown): DeckFile | null {
  const o = obj(raw)
  if (!o || o.version !== 2 || !Array.isArray(o.cards)) return null
  const cards: CardContent[] = []
  for (const entry of o.cards) {
    const c = obj(entry)
    if (!c || typeof c.id !== 'string' || c.id === '') continue
    // Pick the content fields explicitly. A deck file has no scheduling state, so
    // an srs that slipped in from an older build must not overwrite local progress.
    cards.push({
      id: c.id,
      de: typeof c.de === 'string' ? c.de : '',
      en: typeof c.en === 'string' ? c.en : '',
      article: (c.article ?? 'none') as CardContent['article'],
      example_de: typeof c.example_de === 'string' ? c.example_de : '',
      example_en: typeof c.example_en === 'string' ? c.example_en : '',
      tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
      rank: typeof c.rank === 'number' ? c.rank : undefined,
      tier: c.tier === 1 || c.tier === 2 || c.tier === 3 ? c.tier : undefined,
      created_at: int(c.created_at, 0),
      updated_at: int(c.updated_at, 0),
    })
  }
  return {
    version: 2,
    kind: 'deck',
    updated_at: int(o.updated_at, 0),
    cards,
    deleted_ids: obj(o.deleted_ids) as Record<string, number> ?? {},
  }
}

export function parseUserFile(raw: unknown): UserFile | null {
  const o = obj(raw)
  if (!o || o.version !== 2 || o.kind !== 'user' || !obj(o.progress)) return null
  const settings = obj(o.settings) ?? {}
  const tier = settings.tier
  return {
    version: 2,
    kind: 'user',
    user: typeof o.user === 'string' ? o.user : '',
    updated_at: int(o.updated_at, 0),
    settings: {
      direction: settings.direction === 'de-en' ? 'de-en' : 'en-de',
      sessionSize: Math.max(0, int(settings.sessionSize, 20)),
      tier: tier === 1 || tier === 2 || tier === 3 ? tier : 1,
      ...(validSelectedTiers(settings.selectedTiers) ? { selectedTiers: reviewTiers({ tier: 3, selectedTiers: settings.selectedTiers }) } : {}),
      wordTypes: normalizeWordTypes(settings.wordTypes),
    },
    settings_updated_at: typeof o.settings_updated_at === 'number' ? o.settings_updated_at : undefined,
    progress: o.progress as Record<string, Srs>,
    ...(o.activity !== undefined ? { activity: parseStoredReviewActivity(o.activity) } : {}),
  }
}

/** The pre-multi-user single-file snapshot, kept so an existing data.json can be claimed. */
export function parseSnapshot(raw: unknown): Snapshot | null {
  const o = obj(raw)
  if (!o || o.version !== 1 || !Array.isArray(o.cards)) return null
  const settings = obj(o.settings) ?? {}
  return {
    version: 1,
    updated_at: int(o.updated_at, 0),
    settings_updated_at: typeof o.settings_updated_at === 'number' ? o.settings_updated_at : undefined,
    settings: {
      direction: settings.direction === 'de-en' ? 'de-en' : 'en-de',
      sessionSize: Math.max(0, int(settings.sessionSize, 20)),
    },
    cards: o.cards as Card[],
    deleted_ids: obj(o.deleted_ids) as Record<string, number> ?? {},
  }
}

export type RemoteDeck =
  | { kind: 'deck'; file: DeckFile }
  | { kind: 'legacy'; snapshot: Snapshot }

/** Accepts either the v2 deck file or a v1 snapshot that still needs migrating. */
export function parseRemoteDeck(raw: unknown): RemoteDeck | null {
  const deck = parseDeckFile(raw)
  if (deck) return { kind: 'deck', file: deck }
  const snapshot = parseSnapshot(raw)
  return snapshot ? { kind: 'legacy', snapshot } : null
}

/**
 * Split a v1 snapshot into the two files it now lives in. The whole progress it
 * holds can only belong to the user opening it, so it is credited to them.
 */
export function legacyToFiles(snapshot: Snapshot, user: string): { deck: DeckFile; user: UserFile } {
  const cards: CardContent[] = []
  const progress: Record<string, Srs> = {}
  for (const card of snapshot.cards) {
    if (!card?.id) continue
    const { srs, ...content } = card
    cards.push(content as CardContent)
    if (srs) progress[card.id] = srs
  }
  return {
    deck: {
      version: 2,
      kind: 'deck',
      updated_at: snapshot.updated_at,
      cards,
      deleted_ids: { ...snapshot.deleted_ids },
    },
    user: {
      version: 2,
      kind: 'user',
      user,
      updated_at: snapshot.updated_at,
      // The v1 snapshot had one clock for everything, so it is the best available
      // settings clock. Without it a second device would see no settings opinion
      // and its own defaults would win.
      settings_updated_at: snapshot.settings_updated_at || snapshot.updated_at,
      settings: { ...snapshot.settings, tier: 1, wordTypes: [] },
      progress,
    },
  }
}

// --- merging --------------------------------------------------------------

function contentTime(c: Pick<CardContent, 'updated_at' | 'created_at'>): number {
  return c.updated_at || c.created_at || 0
}

/** Progress is merged on its own clock so a deck edit cannot undo a review. */
function srsTime(s: Srs | undefined): number {
  return typeof s?.updated_at === 'number' ? s.updated_at : 0
}

function mergeTombstones(
  local: Record<string, number>,
  remote: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...remote }
  for (const [id, ts] of Object.entries(local)) {
    const n = Number(ts) || 0
    out[id] = Math.max(Number(out[id]) || 0, n)
  }
  return out
}

/** Union cards by id, later content wins. Scheduling state is not part of a card here. */
export function mergeDeck(local: DeckFile, remote: DeckFile): DeckFile {
  const deleted_ids = mergeTombstones(local.deleted_ids, remote.deleted_ids)
  const map = new Map<string, CardContent>()
  for (const c of [...remote.cards, ...local.cards]) {
    if (!c?.id) continue
    const prev = map.get(c.id)
    if (!prev || contentTime(c) >= contentTime(prev)) map.set(c.id, c)
  }
  const cards = [...map.values()].filter((c) => {
    const del = Number(deleted_ids[c.id]) || 0
    if (!del) return true
    // Built-in cards have no restore path. An offline device must not revive a deletion.
    if (c.id.startsWith('seed-')) return false
    return del < contentTime(c)
  })
  return {
    version: 2,
    kind: 'deck',
    updated_at: Math.max(local.updated_at, remote.updated_at),
    cards,
    deleted_ids,
  }
}

/** Per-card scheduling union, last write wins. */
export function sameSrs(a: Srs, b: Srs): boolean {
  return a.ease === b.ease && a.interval === b.interval && a.reps === b.reps && a.due === b.due && srsTime(a) === srsTime(b)
}

export function mergeProgress(local: Record<string, Srs>, remote: Record<string, Srs>): Record<string, Srs> {
  const out: Record<string, Srs> = { ...local }
  for (const [id, srs] of Object.entries(remote)) {
    if (!srs || typeof srs !== 'object') continue
    const prev = out[id]
    if (!prev || srsTime(srs) >= srsTime(prev)) out[id] = srs
  }
  return out
}

/**
 * 0 is the legacy unknown sentinel, not epoch. Treat it like missing so the
 * snapshot clock can carry the decision.
 */
export function newerSettings(local: PublicSettings, localAt: number, remote: PublicSettings, remoteAt: number): PublicSettings {
  return localAt >= remoteAt ? local : remote
}

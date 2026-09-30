import { cardToDoc, progressToDoc, settingsToDoc, type CardDoc, type ProgressDoc, type SettingsDoc } from './firestore-docs.ts'
import { mergeDeck, mergeProgress, newerSettings, sameSrs } from './merge.ts'
import type { Card, CardContent, DeckFile, PendingRecords, PublicSettings, RecordMark, Srs } from './types.ts'

/** Strictly under Firestore's 500-write transaction cap. */
export const WRITE_CHUNK = 499

export function emptyPending(): PendingRecords {
  return { cards: {}, tombstones: {}, progress: {}, settings: null }
}

function wholeRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function asMark(value: unknown): RecordMark | null {
  if (!value || typeof value !== 'object') return null
  const revision = wholeRevision((value as { revision?: unknown }).revision)
  if (revision <= 0) return null
  return { revision, acked: Math.min(revision, wholeRevision((value as { acked?: unknown }).acked)) }
}

function asMarkMap(value: unknown): Record<string, RecordMark> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, RecordMark> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const mark = asMark(raw)
    if (mark) out[id] = mark
  }
  return out
}

export function normalizePending(value: unknown): PendingRecords {
  if (!value || typeof value !== 'object') return emptyPending()
  const raw = value as Partial<PendingRecords>
  return {
    cards: asMarkMap(raw.cards),
    tombstones: asMarkMap(raw.tombstones),
    progress: asMarkMap(raw.progress),
    settings: asMark(raw.settings),
  }
}

export function isDirty(mark: RecordMark | null | undefined): boolean {
  return !!mark && mark.revision > mark.acked
}

export function hasDirty(pending: PendingRecords): boolean {
  if (isDirty(pending.settings)) return true
  for (const mark of Object.values(pending.cards)) if (isDirty(mark)) return true
  for (const mark of Object.values(pending.tombstones)) if (isDirty(mark)) return true
  for (const mark of Object.values(pending.progress)) if (isDirty(mark)) return true
  return false
}

export function bumpMark(current: RecordMark | null | undefined, revision: number): RecordMark {
  return { revision, acked: current ? Math.min(current.acked, revision) : 0 }
}

/**
 * Ack only the revision that was loaded into the transaction.
 * A later local edit keeps its higher revision dirty.
 */
export function applyAck(mark: RecordMark, sentRevision: number): RecordMark {
  if (sentRevision <= 0 || sentRevision > mark.revision) return mark
  return { revision: mark.revision, acked: Math.max(mark.acked, sentRevision) }
}

export function ackAllowed(
  expected: { uid: string; generation: number },
  live: { uid: string | null; generation: number },
): boolean {
  return live.uid === expected.uid && live.generation === expected.generation
}

function contentKey(card: CardContent): string {
  return JSON.stringify([
    card.de,
    card.en,
    card.article,
    card.example_de,
    card.example_en,
    card.tags,
    card.rank ?? null,
    card.tier ?? null,
    card.created_at,
    card.updated_at,
  ])
}

export function contentChanged(previous: Card | undefined, next: Card): boolean {
  if (!previous) return true
  return contentKey(previous) !== contentKey(next)
}

export function progressChanged(previous: Card | undefined, next: Card): boolean {
  if (!previous) return true
  return !sameSrs(previous.srs, next.srs)
}

export function reconcileStagedProgress(staged: Srs, current: Srs): Srs {
  return mergeProgress({ card: staged }, { card: current }).card
}

export type PushItem =
  | { kind: 'card'; id: string; contentRevision: number; tombstoneRevision: number }
  | { kind: 'progress'; id: string; revision: number }
  | { kind: 'settings'; revision: number }

export function listPushItems(pending: PendingRecords): PushItem[] {
  const cards = new Map<string, { contentRevision: number; tombstoneRevision: number }>()
  for (const [id, mark] of Object.entries(pending.cards)) {
    if (isDirty(mark)) cards.set(id, { contentRevision: mark.revision, tombstoneRevision: 0 })
  }
  for (const [id, mark] of Object.entries(pending.tombstones)) {
    if (!isDirty(mark)) continue
    const prev = cards.get(id) ?? { contentRevision: 0, tombstoneRevision: 0 }
    prev.tombstoneRevision = mark.revision
    cards.set(id, prev)
  }
  const items: PushItem[] = []
  for (const id of [...cards.keys()].sort()) {
    const rev = cards.get(id)!
    items.push({ kind: 'card', id, contentRevision: rev.contentRevision, tombstoneRevision: rev.tombstoneRevision })
  }
  for (const id of Object.keys(pending.progress).sort()) {
    const mark = pending.progress[id]
    if (isDirty(mark)) items.push({ kind: 'progress', id, revision: mark.revision })
  }
  if (pending.settings && isDirty(pending.settings)) items.push({ kind: 'settings', revision: pending.settings.revision })
  return items
}

export function chunkItems<T>(items: T[], size = WRITE_CHUNK): T[][] {
  if (size < 1) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export type RejectedPush = { item: PushItem; code: string }

function rejectionCode(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const reason = code.split('/').at(-1)
  return reason === 'permission-denied' || reason === 'invalid-argument' || reason === 'out-of-range' ? reason : null
}

export async function runDirtyQueue(
  items: PushItem[],
  ops: {
    push: (item: PushItem) => Promise<'wrote' | 'noop'>
    ack: (item: PushItem) => Promise<void>
    locked: () => boolean
  },
): Promise<{ clean: boolean; chunkSizes: number[]; rejected: RejectedPush[] }> {
  const chunks = chunkItems(items)
  const chunkSizes = chunks.map((chunk) => chunk.length)
  const rejected: RejectedPush[] = []
  if (!ops.locked()) return { clean: false, chunkSizes, rejected }
  for (const chunk of chunks) {
    for (const item of chunk) {
      if (!ops.locked()) return { clean: false, chunkSizes, rejected }
      try {
        await ops.push(item)
      } catch (error) {
        const code = rejectionCode(error)
        if (!code) return { clean: false, chunkSizes, rejected }
        rejected.push({ item, code })
        continue
      }
      if (!ops.locked()) return { clean: false, chunkSizes, rejected }
      try {
        await ops.ack(item)
      } catch {
        return { clean: false, chunkSizes, rejected }
      }
    }
  }
  return { clean: ops.locked() && rejected.length === 0, chunkSizes, rejected }
}

function deckOf(id: string, card: CardContent | null, deletedAt: number): DeckFile {
  return {
    version: 2,
    kind: 'deck',
    updated_at: 0,
    cards: card ? [{ ...card, id }] : [],
    deleted_ids: deletedAt > 0 ? { [id]: deletedAt } : {},
  }
}

function contentFromDoc(id: string, doc: CardDoc): CardContent {
  const card: CardContent = {
    id,
    de: doc.de,
    en: doc.en,
    article: doc.article,
    example_de: doc.example_de,
    example_en: doc.example_en,
    tags: [...doc.tags],
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  }
  if (typeof doc.rank === 'number') card.rank = doc.rank
  if (doc.tier === 1 || doc.tier === 2 || doc.tier === 3) card.tier = doc.tier
  return card
}

function contentTime(card: CardContent): number {
  return card.updated_at || card.created_at || 0
}

function tombstoneWins(id: string, deletedAt: number, card: CardContent | null): boolean {
  if (deletedAt <= 0) return false
  if (id.startsWith('seed-')) return true
  if (!card) return true
  return deletedAt >= contentTime(card)
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export function cardDocsEqual(a: CardDoc, b: CardDoc): boolean {
  return a.de === b.de
    && a.en === b.en
    && a.article === b.article
    && a.example_de === b.example_de
    && a.example_en === b.example_en
    && sameList(a.tags, b.tags)
    && a.created_at === b.created_at
    && a.updated_at === b.updated_at
    && a.deletedAt === b.deletedAt
    && a.rank === b.rank
    && a.tier === b.tier
}

function blankContent(id: string, deletedAt: number): CardContent {
  return {
    id,
    de: '',
    en: '',
    article: 'none',
    example_de: '',
    example_en: '',
    tags: [],
    created_at: 0,
    updated_at: deletedAt,
  }
}

/**
 * Merge one card with the server document. Null means the server already
 * matches, so the transaction must not write. Tombstone text already stored
 * on the server is left in place when the deletion time does not change.
 * A custom card that wins over an older tombstone is stored with deletedAt 0.
 * A positive deletedAt would make the next pull treat that edit as deleted.
 */
export function planCardWrite(
  id: string,
  local: CardContent | null,
  localDeletedAt: number,
  remote: CardDoc | null,
): CardDoc | null {
  const remoteDeleted = remote && remote.deletedAt > 0 ? remote.deletedAt : 0
  // A positive deletedAt is a tombstone. Its vocabulary is not a live card,
  // matching docsToFiles, so a stale seed cannot come back from leftover text.
  const remoteLive = remote && remoteDeleted === 0 ? contentFromDoc(id, remote) : null
  const merged = mergeDeck(deckOf(id, local, localDeletedAt), deckOf(id, remoteLive, remoteDeleted))
  const deletedAt = Number(merged.deleted_ids[id]) || 0
  const card = merged.cards.find((item) => item.id === id) ?? null
  if (tombstoneWins(id, deletedAt, card)) {
    if (remote && remote.deletedAt === deletedAt) return null
    if (remote) return { ...remote, deletedAt }
    return cardToDoc(blankContent(id, deletedAt), deletedAt)
  }
  if (!card) return null
  const next = cardToDoc(card, 0)
  if (remote && cardDocsEqual(next, remote)) return null
  return next
}

function srsFromProgress(doc: ProgressDoc): Srs {
  return {
    ease: doc.ease,
    interval: doc.interval,
    reps: doc.reps,
    due: doc.due,
    ...(doc.updated_at > 0 ? { updated_at: doc.updated_at } : {}),
  }
}

function progressEqual(a: ProgressDoc, b: ProgressDoc): boolean {
  return a.ease === b.ease && a.interval === b.interval && a.reps === b.reps && a.due === b.due && a.updated_at === b.updated_at
}

/**
 * Scheduling uses mergeProgress. An equal progress clock keeps the remote
 * schedule, which is the rule the GitHub client already ships. Content and
 * settings ties prefer the local record.
 */
export function planProgressWrite(local: Srs | null, remote: ProgressDoc | null): ProgressDoc | null {
  if (!local) return null
  const remoteSrs = remote ? srsFromProgress(remote) : null
  const merged = mergeProgress({ card: local }, remoteSrs ? { card: remoteSrs } : {})
  const winner = merged.card
  if (!winner) return null
  const next = progressToDoc(winner)
  if (remote && progressEqual(next, remote)) return null
  return next
}

function settingsEqual(a: SettingsDoc, b: SettingsDoc): boolean {
  return a.direction === b.direction
    && a.sessionSize === b.sessionSize
    && a.tier === b.tier
    && a.settingsUpdatedAt === b.settingsUpdatedAt
}

export function planSettingsWrite(
  local: PublicSettings,
  localAt: number,
  remote: SettingsDoc | null,
): SettingsDoc | null {
  const remoteSettings: PublicSettings = remote
    ? { direction: remote.direction, sessionSize: remote.sessionSize, tier: remote.tier }
    : { direction: 'de-en', sessionSize: 20, tier: 1 }
  const remoteAt = remote?.settingsUpdatedAt ?? 0
  const winner = newerSettings(local, localAt, remoteSettings, remoteAt)
  const next = settingsToDoc(winner, Math.max(localAt, remoteAt || 0))
  if (remote && settingsEqual(next, remote)) return null
  return next
}

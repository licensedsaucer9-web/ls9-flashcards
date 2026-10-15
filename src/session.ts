import type { Card, Tier, WordType } from './types.ts'
import { inSelectedTier } from './tiers.ts'
import { inSelectedWordTypes } from './word-types.ts'

/** Due-only when possible; otherwise review the matching cards soonest due. */
export function selectReviewCandidates(
  cards: readonly Card[], tier: Tier, types: readonly WordType[], now = Date.now(),
): { cards: Card[]; dueCount: number } {
  const matching = inSelectedTier([...cards], tier)
    .filter((card) => inSelectedWordTypes(card, types))
    .sort((a, b) => a.srs.due - b.srs.due || a.de.localeCompare(b.de, 'de'))
  const due = matching.filter((card) => card.srs.due <= now)
  return { cards: due.length ? due : matching, dueCount: due.length }
}

/** 0 means the whole eligible queue, including future cards when caught up. */
export function sessionCount(due: number, sessionSize: number): number {
  if (due <= 0) return 0
  if (!sessionSize || sessionSize < 0) return due
  return Math.min(sessionSize, due)
}

export function suggestSessionSize(due: number): number {
  if (due <= 0) return 20
  if (due <= 8) return due
  if (due <= 20) return 10
  if (due <= 40) return 20
  return 30
}

export const SESSION_PRESETS = [10, 20, 30, 0] as const

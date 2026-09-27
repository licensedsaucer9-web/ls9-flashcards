import type { Card, Tier } from './types.ts'
import { TIER_CUMULATIVE, TIERS } from './types.ts'

/**
 * A card's tier is baked from its position in the deck's own frequency order, because
 * the deck is a curated content-word list: its 100th most common word sits far down a
 * 50,000-word corpus list. A card with no tier of its own — a card the user added —
 * lands in the widest tier.
 */
export function tierOf(card: Pick<Card, 'rank' | 'tier'>): Tier {
  return card.tier === 1 || card.tier === 2 || card.tier === 3 ? card.tier : 3
}

/** Higher tiers include the lower ones, so the queue for tier N is every card of tier <= N. */
export function inTier<T extends Pick<Card, 'rank' | 'tier'>>(card: T, tier: Tier): boolean {
  return tierOf(card) <= tier
}

export function inSelectedTier<T extends Pick<Card, 'rank' | 'tier'>>(cards: T[], tier: Tier): T[] {
  return cards.filter((card) => inTier(card, tier))
}

export function tierCounts<T extends Pick<Card, 'rank' | 'tier'>>(cards: T[]): Record<Tier, number> {
  const counts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 }
  for (const card of cards) counts[tierOf(card)] += 1
  return counts
}

/** The label the UI shows: tier 2 is the 100 words of tier 1 plus the next 150. */
export function tierLabel(tier: Tier, counts?: Record<Tier, number>): string {
  if (tier === 1) return counts ? `Tier 1 · ${counts[1]} words` : 'Tier 1 · 100 words'
  if (tier === 2) return counts ? `Tier 2 · ${counts[1] + counts[2]} words` : 'Tier 2 · 250 words'
  return counts ? `Tier 3 · ${counts[1] + counts[2] + counts[3]} words` : 'Tier 3 · all'
}

export const TIER_NOTES: Record<Tier, string> = {
  1: 'The 100 most common words. Start here.',
  2: 'Adds the next 150, so 250 words in total.',
  3: 'Everything in the deck, including your own cards.',
}

export { TIERS, TIER_CUMULATIVE }

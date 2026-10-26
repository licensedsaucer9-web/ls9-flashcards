import { clampSrs, MAX_EASE, MAX_INTERVAL_DAYS } from './limits.ts'
import type { Grade, Srs } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_EASE = 1.3
const DEFAULT_EASE = 2.5

export function newSrs(now = Date.now()): Srs {
  return { ease: DEFAULT_EASE, interval: 0, reps: 0, due: now }
}

/** SuperMemo-2 with Anki-style Again / Hard / Good / Easy. Interval is in days. */
export function review(stored: Srs, grade: Grade, now = Date.now()): Srs {
  // A schedule saved before the caps existed may be past them; start from one the server accepts.
  const srs = clampSrs(stored)
  const ease = srs.ease
  const interval = srs.interval
  const reps = srs.reps
  // Reviewing ahead of schedule proves little, so it never lengthens the interval.
  const early = interval > 0 && now < srs.due

  if (grade === 'again') {
    return {
      ease: Math.max(MIN_EASE, ease - 0.2),
      interval: 0,
      reps: 0,
      due: now,
    }
  }

  // Knew the word, missed grammatical gender. Requeue now; smaller ease hit than Again.
  if (grade === 'wrong_gender') {
    return {
      ease: Math.max(MIN_EASE, ease - 0.1),
      interval: 0,
      reps: 0,
      due: now,
    }
  }

  let nextEase = ease
  if (grade === 'hard') nextEase = Math.max(MIN_EASE, ease - 0.15)
  if (grade === 'easy') nextEase = Math.min(MAX_EASE, ease + 0.15)

  let nextInterval: number
  if (grade === 'hard') {
    nextInterval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2))
  } else if (grade === 'good') {
    if (reps === 0) nextInterval = 1
    else if (reps === 1) nextInterval = 6
    else nextInterval = Math.max(1, Math.round(interval * nextEase))
  } else {
    if (reps === 0) nextInterval = 4
    else if (reps === 1) nextInterval = Math.max(4, Math.round(6 * 1.3))
    else nextInterval = Math.max(1, Math.round(interval * nextEase * 1.3))
  }

  if (early) nextInterval = Math.min(nextInterval, interval)
  nextInterval = Math.min(MAX_INTERVAL_DAYS, nextInterval)

  return {
    ease: nextEase,
    interval: nextInterval,
    reps: reps + 1,
    due: now + nextInterval * DAY_MS,
  }
}

export function isDue(srs: Srs, now = Date.now()): boolean {
  return srs.due <= now
}

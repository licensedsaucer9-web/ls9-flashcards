import { clampSrs, MAX_EASE, MAX_INTERVAL_DAYS } from './limits.ts'
import type { Grade, Srs } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_EASE = 1.3
const DEFAULT_EASE = 2.5
/** Easy's extra growth on top of ease. */
const EASY_BONUS = 1.3
/** Hard's growth: the interval barely moves. */
const HARD_FACTOR = 1.2
/** Share of the interval a lapse keeps, so relearning resumes above day one. */
const AGAIN_KEEP = 0.25
const WRONG_GENDER_KEEP = 0.5
/**
 * Practical ceiling for new growth: ten years. The server accepts up to MAX_INTERVAL_DAYS, and a
 * stored interval already past this ceiling is held by a passing grade rather than shortened.
 */
export const MAX_SCHEDULE_DAYS = 3650

export function newSrs(now = Date.now()): Srs {
  return { ease: DEFAULT_EASE, interval: 0, reps: 0, due: now }
}

/**
 * SM-2 ladder for the first steps, then multiplicative growth by ease (Easy also by EASY_BONUS).
 * Interval is in days. reps counts passing grades since the last lapse; interval > 0 with
 * reps === 0 is a lapsed card that is relearning from the interval it kept.
 */
export function review(stored: Srs, grade: Grade, now = Date.now()): Srs {
  // A schedule saved before the caps existed may be past them; start from one the server accepts.
  const srs = clampSrs(stored)
  const ease = srs.ease
  const interval = srs.interval
  const reps = srs.reps
  // Reviewing ahead of schedule proves little, so it never lengthens the interval.
  const early = interval > 0 && now < srs.due

  // Forgot it: requeue now with an ease penalty, keeping part of the interval as memory of the lapse.
  // Knew the word but missed grammatical gender: the same, milder.
  if (grade === 'again' || grade === 'wrong_gender') {
    const gender = grade === 'wrong_gender'
    return {
      ease: Math.max(MIN_EASE, ease - (gender ? 0.1 : 0.2)),
      interval: Math.floor(interval * (gender ? WRONG_GENDER_KEEP : AGAIN_KEEP)),
      reps: 0,
      due: now,
    }
  }

  let nextEase = ease
  if (grade === 'hard') nextEase = Math.max(MIN_EASE, ease - 0.15)
  if (grade === 'easy') nextEase = Math.min(MAX_EASE, ease + 0.15)

  let nextInterval: number
  if (reps === 0) {
    // New card (interval 0): 1 / 1 / 4 days. Relearning: Good resumes the kept interval.
    if (grade === 'hard') nextInterval = Math.max(1, Math.round(interval / 2))
    else if (grade === 'good') nextInterval = Math.max(1, interval)
    else nextInterval = Math.max(4, Math.round(interval * EASY_BONUS))
  } else if (grade === 'hard') {
    nextInterval = Math.max(1, Math.round(interval * HARD_FACTOR))
  } else {
    // Good grows by ease, at least one day; Easy also by the bonus, at least a day past Good.
    const good = Math.max(reps === 1 ? 6 : 1, interval + 1, Math.round(interval * ease))
    nextInterval = grade === 'good'
      ? good
      : Math.max(reps === 1 ? 8 : 1, good + 1, Math.round(interval * nextEase * EASY_BONUS))
  }

  // Passing grades never shorten an interval that is already past the practical ceiling.
  nextInterval = Math.min(nextInterval, Math.max(MAX_SCHEDULE_DAYS, interval))
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

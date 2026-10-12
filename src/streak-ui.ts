import { getReviewActivity } from './db.ts'
import { esc } from './dom.ts'
import { calendarDay, calculateStreak, streakLabel } from './streak.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'

let lastDay: number | undefined
let lastZone = 'UTC'
let refreshGeneration = 0

/** Passive text, deliberately without live announcements or notifications. */
export function streakPlaceholder(): string {
  return '<details class="streak" data-streak><summary><span data-streak-label></span></summary><p data-streak-help></p></details>'
}

export async function refreshStreak(): Promise<void> {
  const generation = ++refreshGeneration
  const nodes = [...document.querySelectorAll<HTMLElement>('[data-streak]')]
  if (!nodes.length) return
  const lock = captureStudyLock()
  const activity = await getReviewActivity()
  if (generation !== refreshGeneration || !studyLockCurrent(lock)) return
  const streak = calculateStreak(activity)
  lastZone = streak.timeZone
  lastDay = calendarDay(Date.now(), lastZone)
  for (const node of nodes) {
    if (!node.isConnected) continue
    node.dataset.state = streak.state
    node.querySelector('[data-streak-label]')!.textContent = streakLabel(streak)
    node.querySelector('[data-streak-help]')!.innerHTML = `10 graded reviews cover today. Extra reviews repair earlier shortfalls, and repair progress carries over. Repeated cards and every grade count. Days follow ${esc(streak.timeZone)}. Extra reviews do not prepay future days.`
  }
}

export function quietlyRefreshStreak(): void {
  // A blocked database already has the app's normal database notice.
  void refreshStreak().catch(() => {})
}

export function refreshStreakDay(): void {
  if (lastDay !== undefined && calendarDay(Date.now(), lastZone) !== lastDay) quietlyRefreshStreak()
}

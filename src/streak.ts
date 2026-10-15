/** Immutable, uniquely identified saved grades. No card content is needed. */
export type ReviewEvent = { at: number; timeZone: string }
export type ReviewActivity = Record<string, ReviewEvent>

export const DAILY_TARGET = 10
const DAY = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()
// Kept identical to the activity timeZone pattern in firestore.rules (tested).
export const REVIEW_TIME_ZONE_PATTERN = '^(UTC|[A-Za-z_]+/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)?)$'
const reviewTimeZonePattern = new RegExp(REVIEW_TIME_ZONE_PATTERN)

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(timeZone, value)
  }
  return value
}

export function validReviewEvent(id: string, value: unknown): value is ReviewEvent {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) return false
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as ReviewEvent
  if (Object.keys(row).sort().join(',') !== 'at,timeZone'
    || !Number.isSafeInteger(row.at) || row.at < 0 || row.at > 253402214400000
    || typeof row.timeZone !== 'string' || row.timeZone.length > 100
    || !reviewTimeZonePattern.test(row.timeZone)) return false
  try { formatter(row.timeZone); return true } catch { return false }
}

/** Tolerate corrupt external activity without discarding unrelated account data. */
export function filterReviewEvents(rows: { id: string; data: unknown }[]): {
  activity: { id: string; data: ReviewEvent }[]; skipped: number
} {
  const activity: { id: string; data: ReviewEvent }[] = []
  let skipped = 0
  for (const row of rows) {
    if (validReviewEvent(row.id, row.data)) activity.push({ id: row.id, data: row.data })
    else skipped++
  }
  return { activity, skipped }
}

export function parseReviewActivity(value: unknown): ReviewActivity {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review activity')
  const activity: ReviewActivity = {}
  for (const [id, event] of Object.entries(value)) {
    if (!validReviewEvent(id, event)) throw new Error('Invalid review activity')
    activity[id] = { ...event }
  }
  return activity
}

const warnedStoredEvents = new Set<string>()

/** Repair only legacy zone spellings; retain strict validation of every other field. */
export function parseStoredReviewActivity(value: unknown): ReviewActivity {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review activity')
  const activity: ReviewActivity = {}
  let skipped = 0
  for (const [id, raw] of Object.entries(value)) {
    // Validate the entire shape before tolerating an unsupported legacy zone.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof (raw as ReviewEvent).timeZone !== 'string'
      || !validReviewEvent(id, { ...raw, timeZone: 'UTC' })) throw new Error('Invalid review activity')
    const event = raw as ReviewEvent
    try { activity[id] = { ...event, timeZone: canonicalReviewTimeZone(event.timeZone) } }
    catch {
      if (!warnedStoredEvents.has(id)) { warnedStoredEvents.add(id); skipped++ }
    }
  }
  if (skipped) console.warn(`Skipped ${skipped} stored review activity events with unsupported time zones`)
  return activity
}

/** Refuse a corrupt/colliding ID instead of silently changing earned credit. */
export function mergeReviewActivity(local: ReviewActivity, incoming: ReviewActivity): ReviewActivity {
  const merged = { ...local }
  for (const [id, event] of Object.entries(incoming)) {
    const before = merged[id]
    if (before && (before.at !== event.at || before.timeZone !== event.timeZone)) throw new Error('Conflicting review activity')
    merged[id] = event
  }
  return merged
}

/** Chromium can report raw offsets; Etc/GMT uses the opposite sign. */
export function canonicalReviewTimeZone(zone: string): string {
  if (zone === 'GMT' || zone === 'UTC') return 'UTC'
  const offset = /^([+-])(\d{2}):00$/.exec(zone)
  if (offset) {
    const hours = Number(offset[2])
    zone = hours === 0 ? 'UTC' : `Etc/GMT${offset[1] === '+' ? '-' : '+'}${hours}`
  }
  if (zone.length > 100 || !reviewTimeZonePattern.test(zone)) throw new Error('Invalid review time zone')
  // Do not replace unsupported offsets/zones with UTC and change their day boundary.
  formatter(zone)
  return zone
}

export function deviceTimeZone(): string {
  return canonicalReviewTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
}

/** Earliest saved event wins, with ID as a deterministic tie-break after offline merges. */
export function streakTimeZone(activity: ReviewActivity, fallback = deviceTimeZone()): string {
  let first: [string, ReviewEvent] | undefined
  for (const entry of Object.entries(activity)) {
    if (!first || entry[1].at < first[1].at || (entry[1].at === first[1].at && entry[0] < first[0])) first = entry
  }
  return canonicalReviewTimeZone(first?.[1].timeZone ?? fallback)
}

/** Calendar-date ordinal; DST changes do not make a short/long day count twice. */
export function calendarDay(at: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(at)
  const number = (name: string) => Number(parts.find((part) => part.type === name)!.value)
  return Date.UTC(number('year'), number('month') - 1, number('day')) / DAY
}

export type Streak = { state: 'on' | 'off' | 'broken'; days: number; today: number; repair: number; timeZone: string }

export function calculateStreak(activity: ReviewActivity, now = Date.now()): Streak {
  const timeZone = streakTimeZone(activity)
  const today = calendarDay(now, timeZone)
  const counts = new Map<number, number>()
  for (const event of Object.values(activity)) {
    if (event.at > now) continue
    const day = calendarDay(event.at, timeZone)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  let start: number | undefined
  let previous = 0
  let debt = 0
  for (const [day, count] of [...counts.entries()].sort(([a], [b]) => a - b)) {
    if (start === undefined) {
      if (count < DAILY_TARGET) continue
      start = day
    } else debt += (day - previous - 1) * DAILY_TARGET
    // Surplus repairs only already elapsed days, and never prepays a future day.
    debt = Math.max(0, debt - Math.max(0, count - DAILY_TARGET))
    if (day < today) debt += Math.max(0, DAILY_TARGET - count)
    previous = day
  }
  if (start !== undefined) debt += Math.max(0, today - previous - 1) * DAILY_TARGET
  const done = Math.min(DAILY_TARGET, counts.get(today) ?? 0)
  const days = start === undefined ? 0 : today - start + (done === DAILY_TARGET ? 1 : 0)
  return { state: debt > 0 ? 'broken' : done === DAILY_TARGET ? 'on' : 'off', days, today: done, repair: debt, timeZone }
}

export function streakLabel(streak: Streak): string {
  if (streak.state === 'broken') return `💀 ${streak.repair} ${streak.repair === 1 ? 'review' : 'reviews'} to repair · ${streak.today}/10 today`
  const days = `${streak.days}-day streak`
  return streak.state === 'on' ? `🔥 ${days}` : `🌙 ${days} · ${streak.today}/10 today`
}

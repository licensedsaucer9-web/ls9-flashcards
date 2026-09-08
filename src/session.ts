/** 0 means the whole due queue. */
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

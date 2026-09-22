import type { Card, Snapshot } from './types.ts'

export function emptySnapshot(now = Date.now()): Snapshot {
  return {
    version: 1,
    updated_at: now,
    settings: { direction: 'de-en', sessionSize: 20 },
    settings_updated_at: now,
    cards: [],
    deleted_ids: {},
  }
}

export function parseSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o.cards)) return null
  const settings = (o.settings ?? {}) as Record<string, unknown>
  const direction = settings.direction === 'en-de' ? 'en-de' : 'de-en'
  const sessionSize =
    typeof settings.sessionSize === 'number' && Number.isFinite(settings.sessionSize)
      ? Math.max(0, Math.floor(settings.sessionSize))
      : 20
  const deleted_ids =
    o.deleted_ids && typeof o.deleted_ids === 'object' && !Array.isArray(o.deleted_ids)
      ? (o.deleted_ids as Record<string, number>)
      : {}
  return {
    version: 1,
    updated_at: typeof o.updated_at === 'number' ? o.updated_at : 0,
    settings_updated_at: typeof o.settings_updated_at === 'number' ? o.settings_updated_at : undefined,
    settings: { direction, sessionSize },
    cards: o.cards as Card[],
    deleted_ids,
  }
}

function cardTouched(c: Card): number {
  return c.updated_at || c.created_at || 0
}

/** Union cards by id (later updated_at wins). Honor deletions that are newer than the card. */
export function mergeSnapshots(local: Snapshot, remote: Snapshot): Snapshot {
  const deleted_ids: Record<string, number> = { ...remote.deleted_ids }
  for (const [id, ts] of Object.entries(local.deleted_ids)) {
    const n = Number(ts) || 0
    deleted_ids[id] = Math.max(Number(deleted_ids[id]) || 0, n)
  }

  const map = new Map<string, Card>()
  for (const c of [...remote.cards, ...local.cards]) {
    if (!c?.id) continue
    const prev = map.get(c.id)
    if (!prev || cardTouched(c) >= cardTouched(prev)) map.set(c.id, c)
  }

  const cards = [...map.values()].filter((c) => {
    const del = Number(deleted_ids[c.id]) || 0
    // Built-in cards have no restore path. An offline device must not revive a deletion.
    if (del && c.id.startsWith('seed-')) return false
    return !(del && del >= cardTouched(c))
  })

  const localSettingsTime = local.settings_updated_at ?? local.updated_at
  const remoteSettingsTime = remote.settings_updated_at ?? remote.updated_at
  const localSettingsWin = localSettingsTime >= remoteSettingsTime
  const settings = localSettingsWin ? local.settings : remote.settings

  return {
    version: 1,
    updated_at: Math.max(local.updated_at, remote.updated_at),
    settings_updated_at: localSettingsWin ? localSettingsTime : remoteSettingsTime,
    settings,
    cards,
    deleted_ids,
  }
}

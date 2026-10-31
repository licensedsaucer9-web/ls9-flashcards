import { type Card, type DeckFile, type LocalDeck, type PullCursor, type Settings, type UserFile } from './types.ts'
import { mergeDeck, mergeProgress, newerSettings, sameSrs } from './merge.ts'
import { applyAck, bumpMark, hasDirty, reconcileStagedProgress, type PushItem } from './record-sync.ts'
import { newSrs } from './srs.ts'
import { parseStoredReviewActivity, type ReviewActivity } from './streak.ts'
import { captureStudyLock, studyLockCurrent } from './study-lock.ts'
import { activeUserSlug } from './user.ts'
import { localDeckFile, localUserFile } from './db-cards.ts'
import { type CloudScope, LOCAL_DECK_ID, activeCards, cloudScopeCurrent, deckTombstones, load, mergeActivityInTransaction, mergeTombstones, namesFor, normalizeSettings, openDb, publicSettings, replacePreferences, storeOriginalPreferences, txDone, value } from './db-core.ts'

/** `applied` is false when the binding or deck changed first and nothing was merged. */
export type MergeResult = { deck: DeckFile; user: UserFile; revision: number; pending: boolean; applied: boolean }

function untouchedMerge(user: string): MergeResult {
  const settings = normalizeSettings(null)
  return {
    deck: localDeckFile([], settings),
    user: localUserFile([], settings, user),
    revision: 0,
    pending: false,
    applied: false,
  }
}

/** Apply a shared deck file. Card content merges; this user's progress is never touched. */
export async function mergeDeckIntoDb(remote: DeckFile, user = activeUserSlug(), scope?: CloudScope): Promise<MergeResult> {
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return untouchedMerge(user)
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) {
      tx.abort()
      await current.done.catch(() => {})
      return untouchedMerge(user)
    }
    const store = tx.objectStore('cards')
    const local = localDeckFile(current.cards, current.settings)
    const merged = mergeDeck(local, remote)

    const byId = new Map(activeCards(current.cards, current.settings).map((card) => [card.id, card]))
    // merged.cards is the union of both sides minus anything a tombstone removed,
    // so it is the whole truth. Seeding the result from the local cards instead
    // would keep every card a merge just deleted.
    const next = new Map<string, Card>()
    for (const content of merged.cards) {
      const mine = byId.get(content.id)
      // mergeDeck already settled which content wins. The only thing this device
      // owns here is the schedule, and a deck file never carries one.
      if (current.cards.some(card => card.id === content.id && card.deckId !== current.settings.activeDeckId)) continue
      next.set(content.id, { ...content, deckId: current.settings.activeDeckId, srs: mine?.srs ?? newSrs() })
    }

    for (const card of activeCards(current.cards, current.settings)) store.delete(card.id)
    for (const card of next.values()) store.put(card)
    mergeTombstones(current.settings, merged.deleted_ids)
    tx.objectStore('settings').put(current.settings)
    await current.done
    const cards = [...next.values()]
    return {
      deck: merged,
      user: localUserFile(cards, current.settings, user, current.activity),
      revision: current.settings.localRevision,
      pending: current.settings.localRevision > current.settings.acknowledgedRevision,
      applied: true,
    }
  } finally {
    db.close()
  }
}

/** Apply one user's scheduling file. Ignores progress for cards this deck does not have. */
export async function mergeProgressIntoDb(remote: UserFile, user = activeUserSlug(), scope?: CloudScope): Promise<MergeResult> {
  const incomingActivity = parseStoredReviewActivity(remote.activity)
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return untouchedMerge(user)
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const current = await load(tx)
    if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) {
      tx.abort()
      await current.done.catch(() => {})
      return untouchedMerge(user)
    }
    const store = tx.objectStore('cards')
    const next = new Map(activeCards(current.cards, current.settings).map((card) => [card.id, card]))
    const merged = mergeProgress(Object.fromEntries(activeCards(current.cards, current.settings).map((c) => [c.id, c.srs])), remote.progress)
    for (const [id, srs] of Object.entries(merged)) {
      const mine = next.get(id)
      // A deleted card must not come back just because progress for it arrived.
      if (!mine || !srs) continue
      // mergeProgress already decided the winner, including the tie case where both
      // sides have no clock — that is how a schedule migrated from a v1 snapshot, which
      // predates per-user progress clocks, gets adopted rather than dropped.
      if (!sameSrs(srs, mine.srs)) next.set(id, { ...mine, srs })
    }

    const deck = await value(tx.objectStore('decks').get(current.settings.activeDeckId)) as LocalDeck
    const extra = deck.origin !== 'original'
    const localPreferences = extra ? deck : current.settings
    const localSettingsAt = extra ? deck.settingsUpdatedAt ?? 0 : current.settings.settingsUpdatedAt
    // A user file's updated_at is the newest of its settings *and* its progress, so it
    // must not stand in for the settings clock — otherwise any remote review would
    // look like a settings change and rewrite every profile file.
    const remoteSettingsAt = remote.settings_updated_at ?? 0
    const settings = newerSettings(publicSettings(localPreferences), localSettingsAt, remote.settings, remoteSettingsAt)

    for (const card of activeCards(current.cards, current.settings)) store.delete(card.id)
    for (const card of next.values()) store.put(card)
    const settingsUpdatedAt = Math.max(localSettingsAt, remoteSettingsAt || 0)
    if (extra) tx.objectStore('decks').put({ ...replacePreferences({ ...deck }, settings), settingsUpdatedAt })
    else {
      Object.assign(replacePreferences(current.settings, settings), { settingsUpdatedAt })
      storeOriginalPreferences(tx, current.settings)
    }
    current.activity = mergeActivityInTransaction(tx, current, incomingActivity, false)
    tx.objectStore('settings').put(current.settings)
    await current.done
    const cards = [...next.values()]
    return {
      deck: localDeckFile(cards, current.settings),
      user: localUserFile(cards, current.settings, user, current.activity),
      revision: current.settings.localRevision,
      pending: current.settings.localRevision > current.settings.acknowledgedRevision,
      applied: true,
    }
  } finally {
    db.close()
  }
}

export async function acknowledgeRevision(includedRevision: number, user = activeUserSlug(), scope?: CloudScope): Promise<boolean> {
  const { lock, name } = namesFor(user)
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return false
    const tx = db.transaction(scope ? ['settings', 'decks', 'cards'] : ['settings'], 'readwrite')
    const done = txDone(tx)
    const settings = normalizeSettings(await value(tx.objectStore('settings').get('settings')) as Settings | undefined)
    const liveIds = new Set(scope ? await value(tx.objectStore('cards').getAllKeys()) : [])
    if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, settings)) {
      tx.abort()
      await done.catch(() => {})
      return false
    }
    // The revision belongs to the account, while cloud snapshots contain only
    // the selected deck. Check the full queue in this same write transaction.
    const accountPending = scope && hasDirty({
      ...settings.pending,
      // Older clients left dirty content/schedule marks after deletion. Check
      // every deck's live rows atomically so those orphan marks cannot block
      // the account clock, while inactive decks' live content still does.
      cards: Object.fromEntries(Object.entries(settings.pending.cards)
        .filter(([id]) => liveIds.has(id))),
      progress: Object.fromEntries(Object.entries(settings.pending.progress)
        .filter(([id]) => liveIds.has(id))),
    })
    if (!accountPending) {
      settings.acknowledgedRevision = Math.max(
        settings.acknowledgedRevision,
        Math.min(includedRevision, settings.localRevision),
      )
      tx.objectStore('settings').put(settings)
    }
    const pending = !!accountPending || settings.localRevision > settings.acknowledgedRevision
    await done
    if (!studyLockCurrent(lock)) return false
    return pending
  } finally {
    db.close()
  }
}

/** The cursor this deck's last completed pull recorded for `key`, if any. */
export async function readPullCursor(key: string, scope: CloudScope): Promise<PullCursor | null> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return null
    const tx = db.transaction(['decks'], 'readonly')
    const deck = await value(tx.objectStore('decks').get(scope.deckId)) as LocalDeck | undefined
    const cursor = deck?.pullCursor
    return cursor && cursor.key === key ? cursor : null
  } finally {
    db.close()
  }
}

/** Call only after the pulled records were merged; a lost write just means the next pull reads more. */
export async function recordPullCursor(cursor: PullCursor, scope: CloudScope): Promise<void> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['decks', 'settings'], 'readwrite')
    const done = txDone(tx)
    const [deck, settings] = await Promise.all([
      value(tx.objectStore('decks').get(scope.deckId)) as Promise<LocalDeck | undefined>,
      value(tx.objectStore('settings').get('settings')) as Promise<Settings | undefined>,
    ])
    if (!deck || !settings || !cloudScopeCurrent(scope, settings)) {
      tx.abort()
      await done.catch(() => {})
      return
    }
    tx.objectStore('decks').put({ ...deck, pullCursor: cursor })
    await done
  } finally {
    db.close()
  }
}

export type CloudSnapshot = { cards: Map<string, Card>; settings: Settings; activity: ReviewActivity }

/** Cards and pending markers for one cloud push. Null when the account changed mid-read. */
export async function readCloudSnapshot(scope?: CloudScope): Promise<CloudSnapshot | null> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return null
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const { cards, settings, activity, done } = await load(tx)
    if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, settings)) {
      tx.abort()
      await done.catch(() => {})
      return null
    }
    const deck = await value(tx.objectStore('decks').get(settings.activeDeckId)) as LocalDeck | undefined
    await done
    if (!studyLockCurrent(lock)) return null
    const scoped = activeCards(cards, settings)
    const ids = new Set(scoped.map(card => card.id))
    const tombstones = deckTombstones(settings)
    settings.deletedIds = tombstones
    settings.pending.cards = Object.fromEntries(Object.entries(settings.pending.cards).filter(([id]) => ids.has(id)))
    settings.pending.progress = Object.fromEntries(Object.entries(settings.pending.progress).filter(([id]) => ids.has(id)))
    settings.pending.tombstones = Object.fromEntries(Object.entries(settings.pending.tombstones).filter(([id]) => Object.hasOwn(tombstones, id)))
    if (deck?.origin !== 'original') {
      Object.assign(replacePreferences(settings, publicSettings(deck!)), { settingsUpdatedAt: deck?.settingsUpdatedAt ?? 0 })
      settings.pending.settings = settings.pending.extraSettings?.[deck!.id] ?? null
    }
    delete settings.pending.extraSettings
    return { cards: new Map(scoped.map((card) => [card.id, card])), settings, activity }
  } finally {
    db.close()
  }
}

/**
 * Record the revision a transaction committed. A lock that no longer names the
 * same account writes nothing, so the acknowledgement cannot land on another uid.
 */
export async function acknowledgePending(
  item: PushItem,
  expect: { uid: string; generation: number; scope?: CloudScope },
): Promise<boolean> {
  const live = captureStudyLock()
  if (live.uid !== expect.uid || live.generation !== expect.generation) return false
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock) || lock.uid !== expect.uid) return false
    const tx = db.transaction(['settings', 'decks'], 'readwrite')
    const done = txDone(tx)
    const decksRequest = tx.objectStore('decks').get(item.deckId ?? expect.scope?.deckId ?? LOCAL_DECK_ID)
    const request = tx.objectStore('settings').get('settings')
    let applied = false
    let aborted = false
    request.onsuccess = () => {
      if (!studyLockCurrent(lock) || captureStudyLock().uid !== expect.uid) {
        aborted = true
        tx.abort()
        return
      }
      const settings = normalizeSettings(request.result as Settings | undefined)
      if (!cloudScopeCurrent(expect.scope, settings)
        || (item.deckId !== undefined && item.deckId !== settings.activeDeckId)
        || (item.kind === 'card' && [settings.pending.cards[item.id], settings.pending.tombstones[item.id]]
          .some(mark => mark?.deckId !== undefined && mark.deckId !== (item.deckId ?? expect.scope?.deckId ?? settings.activeDeckId)))) {
        aborted = true
        tx.abort()
        return
      }
      if (item.kind === 'settings') {
        const deck = decksRequest.result as LocalDeck | undefined
        if (deck && deck.origin !== 'original') {
          const mark = settings.pending.extraSettings?.[deck.id]
          if (mark) settings.pending.extraSettings![deck.id] = applyAck(mark, item.revision)
        } else if (settings.pending.settings) settings.pending.settings = applyAck(settings.pending.settings, item.revision)
      } else if (item.kind === 'progress' || item.kind === 'activity') {
        const marks = item.kind === 'progress' ? settings.pending.progress : settings.pending.activity
        const mark = marks?.[item.id]
        if (mark) {
          const next = applyAck(mark, item.revision)
          if (item.kind === 'activity' && next.acked === next.revision) delete marks![item.id]
          else marks![item.id] = next
        }
      } else {
        if (item.contentRevision > 0) {
          const mark = settings.pending.cards[item.id]
          if (mark) settings.pending.cards[item.id] = applyAck(mark, item.contentRevision)
        }
        if (item.tombstoneRevision > 0) {
          const mark = settings.pending.tombstones[item.id]
          if (mark) settings.pending.tombstones[item.id] = applyAck(mark, item.tombstoneRevision)
        }
      }
      tx.objectStore('settings').put(settings)
      applied = true
    }
    await done.catch((error) => {
      if (aborted || !studyLockCurrent(lock)) return
      throw error
    })
    return applied && studyLockCurrent(lock) && captureStudyLock().uid === expect.uid
  } finally {
    db.close()
  }
}

/** Attach schedules that were copied before the matching cards existed. */
export async function applyStagedProgress(scope?: CloudScope): Promise<void> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['cards', 'settings', 'activity', 'decks'], 'readwrite')
    const current = await load(tx)
    const staged = current.settings.stagedProgress
    if (!staged || !studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) {
      if (!studyLockCurrent(lock) || !cloudScopeCurrent(scope, current.settings)) tx.abort()
      await current.done.catch(() => {})
      return
    }
    const store = tx.objectStore('cards')
    const byId = new Map(activeCards(current.cards, current.settings).map((card) => [card.id, card]))
    let changed = false
    const rev = current.settings.localRevision + 1
    for (const [id, srs] of Object.entries(staged)) {
      delete staged[id]
      const mine = byId.get(id)
      if (!mine) continue
      const merged = reconcileStagedProgress(srs, mine.srs)
      if (sameSrs(merged, mine.srs)) continue
      store.put({ ...mine, srs: merged })
      current.settings.pending.progress[id] = bumpMark(current.settings.pending.progress[id], rev)
      changed = true
    }
    if (!Object.keys(staged).length) delete current.settings.stagedProgress
    else current.settings.stagedProgress = staged
    if (changed) current.settings.localRevision = rev
    tx.objectStore('settings').put(current.settings)
    await current.done
  } finally {
    db.close()
  }
}

import { type LocalDeck, type PublicSettings, type Settings } from './types.ts'
import { bumpMark } from './record-sync.ts'
import { studyLockCurrent } from './study-lock.ts'
import { reviewTiers, sameSelectedTiers, validSelectedTiers } from './tiers.ts'
import { normalizeWordTypes, sameWordTypes } from './word-types.ts'
import { namesFor, normalizeSettings, openDb, publicSettings, replacePreferences, tier, txDone, value } from './db-core.ts'

export async function getSettings(): Promise<Settings> {
  const { lock, name } = namesFor()
  const db = await openDb(name, false)
  try {
    if (!studyLockCurrent(lock)) return normalizeSettings(null)
    const tx = db.transaction(db.objectStoreNames.contains('decks') ? ['settings', 'decks'] : ['settings'], 'readonly')
    const settings = normalizeSettings((await value(tx.objectStore('settings').get('settings'))) as Settings | undefined)
    if (tx.objectStoreNames.contains('decks')) {
      const deck = await value(tx.objectStore('decks').get(settings.activeDeckId)) as LocalDeck | undefined
      if (deck?.direction !== undefined) replacePreferences(settings, publicSettings(deck))
    }
    return studyLockCurrent(lock) ? settings : normalizeSettings(null)
  } finally {
    db.close()
  }
}

export async function putSettings(next: Partial<PublicSettings>): Promise<void> {
  const { lock, name } = namesFor()
  const db = await openDb(name)
  try {
    if (!studyLockCurrent(lock)) return
    const tx = db.transaction(['decks', 'settings'], 'readwrite')
    const done = txDone(tx)
    const settings = normalizeSettings(await value(tx.objectStore('settings').get('settings')) as Settings | undefined)
    const deck = await value(tx.objectStore('decks').get(settings.activeDeckId)) as LocalDeck | undefined
    if (!studyLockCurrent(lock)) { tx.abort(); await done.catch(() => {}); return }
    if (!deck) { await done; return }
    const selectedTiers = next.selectedTiers ?? (next.tier === undefined ? deck.selectedTiers : undefined)
    const preferences: PublicSettings = {
      direction: next.direction ?? deck.direction,
      sessionSize: next.sessionSize === undefined ? deck.sessionSize : normalizeSettings(next).sessionSize,
      tier: tier(next.tier ?? deck.tier),
      ...(validSelectedTiers(selectedTiers) ? { selectedTiers: reviewTiers({ tier: 4, selectedTiers }) } : {}),
      wordTypes: next.wordTypes === undefined ? deck.wordTypes : normalizeWordTypes(next.wordTypes),
    }
    tx.objectStore('decks').put(replacePreferences({ ...deck }, preferences))
    if (deck.origin === 'original') {
      if (settings.direction !== preferences.direction || settings.sessionSize !== preferences.sessionSize
        || settings.tier !== preferences.tier || !sameSelectedTiers(settings, preferences) || !sameWordTypes(settings.wordTypes, preferences.wordTypes)) {
        settings.settingsUpdatedAt = Math.max(Date.now(), settings.settingsUpdatedAt + 1)
        settings.pending.settings = bumpMark(settings.pending.settings, settings.localRevision + 1)
      }
      replacePreferences(settings, preferences)
      settings.localRevision += 1
      tx.objectStore('settings').put(settings)
    }
    if (deck.origin !== 'original' && (deck.direction !== preferences.direction || deck.sessionSize !== preferences.sessionSize
      || deck.tier !== preferences.tier || !sameSelectedTiers(deck, preferences) || !sameWordTypes(deck.wordTypes, preferences.wordTypes))) {
      tx.objectStore('decks').put({ ...replacePreferences({ ...deck }, preferences), settingsUpdatedAt: Math.max(Date.now(), (deck.settingsUpdatedAt ?? 0) + 1) })
      settings.localRevision += 1
      ;(settings.pending.extraSettings ??= {})[deck.id] = bumpMark(settings.pending.extraSettings?.[deck.id], settings.localRevision)
      tx.objectStore('settings').put(settings)
    }
    await done
  } finally { db.close() }
}

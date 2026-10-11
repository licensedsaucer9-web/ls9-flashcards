import { createHash } from 'node:crypto'
import { filesToDocs } from '../src/firestore-docs.ts'
import { planCardWrite, planProgressWrite, planSettingsWrite } from '../src/record-sync.ts'
import { migrationFiles, validateMapping } from '../src/migration-data.ts'
import { mergeReviewActivity } from '../src/streak.ts'

export function same(a, b) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

export function prepareMigration(snapshot, rawMapping) {
  const mapping = validateMapping(rawMapping)
  if (snapshot.version !== 1 || !/^[a-f0-9]{40}$/.test(snapshot.commit) || !snapshot.users || !snapshot.deck) {
    throw new Error('Export must have version 1, a recorded Git commit, deck, and users')
  }
  const files = migrationFiles(snapshot.deck, snapshot.users, mapping)
  const fingerprint = createHash('sha256').update(JSON.stringify({ commit: snapshot.commit, files, mapping })).digest('hex')
  const items = []
  const cards = new Map(files.deck.cards.map((card) => [card.id, card]))
  const ids = new Set([...cards.keys(), ...Object.keys(files.deck.deleted_ids)])
  for (const id of [...ids].sort()) {
    const source = cards.get(id) ?? null
    const deletedAt = files.deck.deleted_ids[id] || 0
    items.push({ path: `decks/${mapping.deckId}/cards/${id}`, kind: 'card',
      source: { card: source, deletedAt }, merge: (remote) => planCardWrite(id, source, deletedAt, remote) })
  }
  for (const [profile, user] of Object.entries(files.users)) {
    const uid = mapping.profiles[profile]
    const docs = filesToDocs(files.deck, user)
    for (const { id, data } of docs.activity ?? []) {
      items.push({ path: `users/${uid}/activity/${id}`, kind: 'activity', source: data,
        merge: (remote) => {
          if (remote) { mergeReviewActivity({ [id]: remote }, { [id]: data }); return null }
          return data
        } })
    }
    for (const { id, data } of docs.progress) {
      items.push({ path: `users/${uid}/progress/${id}`, kind: 'progress', source: data,
        merge: (remote) => planProgressWrite(user.progress[id], remote) })
    }
    items.push({ path: `users/${uid}/settings/current`, kind: 'settings', source: docs.settings,
      merge: (remote) => planSettingsWrite(user.settings, user.settings_updated_at ?? 0, remote) })
  }
  return { mapping, files, items, fingerprint, commit: snapshot.commit }
}

function accountPlan(plan, before, needsWrites = false) {
  const { mapping, fingerprint, commit } = plan
  const paths = [`decks/${mapping.deckId}`, ...Object.values(mapping.profiles).map((uid) => `users/${uid}`)]
  const deck = before[0]
  if (deck && (!Array.isArray(deck.memberUids) || !same([...deck.memberUids].sort(), Object.values(mapping.profiles).sort()))) {
    throw new Error('Existing legacy deck membership differs from the reviewed mapping')
  }
  const next = [{ memberUids: Object.values(mapping.profiles).sort() }]
  for (let index = 1; index < paths.length; index++) {
    const user = before[index]
    if (user && (user.deckId !== mapping.deckId || user.schemaVersion !== 1)) {
      throw new Error(`${paths[index]} already belongs to a different deck/schema; refusing to reassign it`)
    }
    const complete = !needsWrites && user?.migrationStatus === 'complete' && user?.migrationSource === fingerprint
    next.push({ ...user, deckId: mapping.deckId, schemaVersion: 1,
      migrationStatus: complete ? 'complete' : 'pending', migrationSource: fingerprint, sourceCommit: commit })
  }
  return { paths, next }
}

/** Store interface: get, list, and atomic(paths, callback returning next documents). */
export async function runMigration(plan, store, { dryRun = true, report = () => {} } = {}) {
  const paths = [`decks/${plan.mapping.deckId}`, ...Object.values(plan.mapping.profiles).map((uid) => `users/${uid}`)]
  const beforeAccounts = await Promise.all(paths.map((path) => store.get(path)))
  // Completed migrations stay untouched on a no-op rerun. A repair or a new
  // snapshot returns to pending before any source record is changed.
  let needsWrites = false
  for (const item of plan.items) if (item.merge(await store.get(item.path)) !== null) needsWrites = true
  const accounts = accountPlan(plan, beforeAccounts, needsWrites)
  const counts = {}
  const collections = [`decks/${plan.mapping.deckId}/cards`, ...Object.values(plan.mapping.profiles).map((uid) => `users/${uid}/progress`)]
  for (const collection of collections) counts[collection] = { before: (await store.list(collection)).length,
    source: plan.items.filter((item) => item.path.startsWith(`${collection}/`)).length }
  if (!dryRun) await store.atomic(paths, (before) => accountPlan(plan, before, needsWrites).next)
  for (let index = 0; index < paths.length; index++) {
    report({ path: paths[index], before: beforeAccounts[index], after: accounts.next[index], state: same(beforeAccounts[index], accounts.next[index]) ? 'already imported' : 'write' })
  }
  let writes = 0
  const expected = new Map()
  for (const item of plan.items) {
    let result
    const compute = ([before]) => {
      const changed = item.merge(before)
      const after = changed ?? before
      if (!after) throw new Error(`No result for ${item.path}`)
      result = { path: item.path, kind: item.kind, source: item.source, before, after,
        state: changed ? 'write' : 'already imported' }
      return [after]
    }
    if (dryRun) compute([await store.get(item.path)])
    else await store.atomic([item.path], compute)
    if (result.state === 'write') writes++
    expected.set(item.path, result.after)
    report(result)
  }
  if (dryRun) return { dryRun: true, writes, counts, skipped: plan.files.skipped, commit: plan.commit }
  // Exact readback of the transaction result, allowing only a later merge winner.
  for (const item of plan.items) {
    const actual = await store.get(item.path)
    if (!actual || (!same(actual, expected.get(item.path)) && item.merge(actual) !== null)) {
      throw new Error(`Readback verification failed for ${item.path}; migration remains pending`)
    }
    report({ path: item.path, verified: true, source: item.source, actual,
      comparison: same(actual, expected.get(item.path)) ? 'exact committed value' : 'server advanced' })
  }
  for (const collection of collections) {
    const rows = await store.list(collection)
    const expectedIds = plan.items.filter((item) => item.path.startsWith(`${collection}/`)).map((item) => item.path.split('/').at(-1))
    if (expectedIds.some((id) => !rows.some((row) => row.id === id))) throw new Error(`Readback count verification failed for ${collection}`)
    counts[collection].after = rows.length
    if (rows.length < counts[collection].before) throw new Error(`Records disappeared from ${collection}`)
  }
  const userPaths = paths.slice(1)
  await store.atomic(userPaths, (before) => before.map((user, index) => {
    if (user?.deckId !== plan.mapping.deckId || user?.migrationSource !== plan.fingerprint) throw new Error(`Mapping changed during import: ${userPaths[index]}`)
    return { ...user, migrationStatus: 'complete' }
  }))
  return { dryRun: false, writes, counts, skipped: plan.files.skipped, commit: plan.commit,
    state: writes ? 'imported and verified' : 'already imported' }
}

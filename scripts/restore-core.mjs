import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { object, validMigrationId } from '../src/migration-data.ts'
import { same } from './migration-core.mjs'
import { credentialPath, privatePath, readPrivateJson, snapshotDigest } from './migration-files.mjs'

const LIVE_PROJECTS = new Set(['flashcards-ls9-prod', 'flashcards-ls9-auth-test'])
const TOP_KEYS = ['version', 'kind', 'exportedAt', 'users', 'decks', 'sha256']
const ACCOUNT_KEYS = ['deckId', 'schemaVersion', 'migrationStatus']
const MIGRATED_KEYS = ['migrationSource', 'sourceCommit']
const SETTINGS_KEYS = ['direction', 'sessionSize', 'tier', 'settingsUpdatedAt']
const PROGRESS_KEYS = ['ease', 'interval', 'reps', 'due', 'updated_at']
const CARD_KEYS = ['de', 'en', 'article', 'example_de', 'example_en', 'tags', 'created_at', 'updated_at', 'deletedAt']
const CARD_OPTIONAL = ['rank', 'tier']
const CLOCKS = {
  progress: ['updated_at', 'due'],
  settings: ['settingsUpdatedAt'],
  card: ['updated_at', 'created_at', 'deletedAt'],
}

function fail(message) {
  throw new Error(`Unsupported Firestore backup: ${message}`)
}

function clock(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}

function keysExactly(value, allowed) {
  const keys = Object.keys(value)
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
}

function text(value, max) {
  return typeof value === 'string' && value.length <= max
}

/** Production and the real-data rehearsal project are never an isolated target. */
export function assertRestoreTarget(projectId) {
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) {
    throw new Error('Restore target project is invalid')
  }
  if (LIVE_PROJECTS.has(projectId)) {
    throw new Error(`Refusing to restore ${projectId}; that project is not an isolated restore target`)
  }
}

export function reserveRestoreReport(path) {
  const destination = privatePath(path)
  if (existsSync(destination)) throw new Error('Restore report already exists; use a new filename')
  return destination
}

function parseBackup(text) {
  try {
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('invalid id')
      return value
    })
  } catch (error) {
    if (error.message.startsWith('Unsupported Firestore backup:')) throw error
    throw new Error('Backup is truncated or not JSON')
  }
}

export function readFirestoreBackup(path) {
  return prepareRestore(parseBackup(readFileSync(privatePath(path), 'utf8')))
}

function accountDoc(uid, value) {
  if (!object(value) || !validMigrationId(value.deckId) || value.schemaVersion !== 1) fail(`invalid account ${uid}`)
  if (!['new', 'pending', 'complete'].includes(value.migrationStatus)) fail(`invalid account ${uid}`)
  const migrated = value.migrationStatus !== 'new'
  const allowed = migrated ? [...ACCOUNT_KEYS, ...MIGRATED_KEYS] : ACCOUNT_KEYS
  if (!keysExactly(value, allowed)) fail(`invalid account ${uid}`)
  if (migrated) {
    if (typeof value.migrationSource !== 'string' || !/^[a-f0-9]{64}$/.test(value.migrationSource)) fail(`invalid account ${uid}`)
    if (typeof value.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceCommit)) fail(`invalid account ${uid}`)
  }
}

function settingsDoc(uid, value) {
  if (!object(value) || !keysExactly(value, SETTINGS_KEYS)) fail(`invalid settings ${uid}`)
  if (value.direction !== 'de-en' && value.direction !== 'en-de') fail(`invalid settings ${uid}`)
  if (!clock(value.sessionSize, 500) || ![1, 2, 3].includes(value.tier) || !clock(value.settingsUpdatedAt)) fail(`invalid settings ${uid}`)
}

function progressDoc(uid, id, value) {
  if (!validMigrationId(id) || !object(value) || !keysExactly(value, PROGRESS_KEYS)) fail(`invalid progress ${uid}/${id}`)
  if (typeof value.ease !== 'number' || !Number.isFinite(value.ease) || value.ease <= 0 || value.ease > 10) fail(`invalid progress ${uid}/${id}`)
  if (!clock(value.interval, 36500) || !clock(value.reps, 100000) || !clock(value.due) || !clock(value.updated_at)) {
    fail(`invalid progress ${uid}/${id}`)
  }
}

function cardDoc(deckId, id, value) {
  if (!validMigrationId(id) || !object(value)) fail(`invalid card ${deckId}/${id}`)
  const keys = Object.keys(value)
  if (keys.some((key) => !CARD_KEYS.includes(key) && !CARD_OPTIONAL.includes(key))) fail(`invalid card ${deckId}/${id}`)
  if (CARD_KEYS.some((key) => !Object.hasOwn(value, key))) fail(`invalid card ${deckId}/${id}`)
  if (!text(value.de, 200) || !text(value.en, 200) || !text(value.example_de, 1000) || !text(value.example_en, 1000)) {
    fail(`invalid card ${deckId}/${id}`)
  }
  if (!['der', 'die', 'das', 'none'].includes(value.article)) fail(`invalid card ${deckId}/${id}`)
  if (!Array.isArray(value.tags) || value.tags.length > 12 || value.tags.some((tag) => typeof tag !== 'string')) fail(`invalid card ${deckId}/${id}`)
  if (!clock(value.created_at) || !clock(value.updated_at) || !clock(value.deletedAt)) fail(`invalid card ${deckId}/${id}`)
  if (Object.hasOwn(value, 'rank') && !clock(value.rank, 1000000)) fail(`invalid card ${deckId}/${id}`)
  if (Object.hasOwn(value, 'tier') && ![1, 2, 3].includes(value.tier)) fail(`invalid card ${deckId}/${id}`)
}

function assignments(users, decks) {
  const members = new Map()
  for (const [deckId, entry] of Object.entries(decks)) {
    const memberUids = entry.deck.memberUids
    if (!Array.isArray(memberUids) || memberUids.length === 0) fail(`invalid deck ${deckId}`)
    const seen = new Set()
    for (const uid of memberUids) {
      if (!validMigrationId(uid) || seen.has(uid)) fail(`invalid deck ${deckId}`)
      seen.add(uid)
      if (!Object.hasOwn(users, uid)) fail(`deck ${deckId} lists an account that is not in the backup`)
      if (members.has(uid)) fail(`account ${uid} is a member of more than one deck`)
      if (users[uid].account.deckId !== deckId) fail(`account ${uid} names a different deck than its membership`)
      members.set(uid, deckId)
    }
  }
  for (const [uid, user] of Object.entries(users)) {
    if (!Object.hasOwn(decks, user.account.deckId)) fail(`account ${uid} names a deck that is not in the backup`)
    if (members.get(uid) !== user.account.deckId) fail(`account ${uid} is not a member of their deck`)
  }
}

/** Validate a checksummed kind:firestore dump before any network client exists. */
export function prepareRestore(snapshot) {
  if (!object(snapshot)) fail('expected an object')
  if (snapshot.kind !== 'firestore') {
    if (snapshot.commit || snapshot.deck) throw new Error('Restore requires a kind:firestore backup, not a GitHub snapshot')
    throw new Error('Restore requires a kind:firestore backup')
  }
  if (typeof snapshot.sha256 !== 'string' || snapshot.sha256 !== snapshotDigest(snapshot)) {
    throw new Error('Backup checksum does not match')
  }
  if (snapshot.version !== 1 || !keysExactly(snapshot, TOP_KEYS)) fail('unsupported version or fields')
  if (typeof snapshot.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(snapshot.exportedAt)) {
    fail('invalid exportedAt')
  }
  if (!object(snapshot.users) || !object(snapshot.decks)) fail('users and decks must be objects')
  const items = []
  let progress = 0
  let settings = 0
  let cards = 0
  let tombstones = 0
  for (const uid of Object.keys(snapshot.users).sort()) {
    if (!validMigrationId(uid)) fail('invalid account id')
    const user = snapshot.users[uid]
    if (!object(user) || !keysExactly(user, ['account', 'settings', 'progress'])) fail(`invalid user ${uid}`)
    accountDoc(uid, user.account)
    items.push({ path: `users/${uid}`, kind: 'account', data: user.account })
    if (user.settings !== null) {
      settingsDoc(uid, user.settings)
      items.push({ path: `users/${uid}/settings/current`, kind: 'settings', data: user.settings })
      settings++
    }
    if (!object(user.progress)) fail(`invalid progress ${uid}`)
    for (const id of Object.keys(user.progress).sort()) {
      progressDoc(uid, id, user.progress[id])
      items.push({ path: `users/${uid}/progress/${id}`, kind: 'progress', data: user.progress[id] })
      progress++
    }
  }
  for (const deckId of Object.keys(snapshot.decks).sort()) {
    if (!validMigrationId(deckId)) fail('invalid deck id')
    const deck = snapshot.decks[deckId]
    if (!object(deck) || !keysExactly(deck, ['deck', 'cards']) || !object(deck.deck) || !keysExactly(deck.deck, ['memberUids'])) {
      fail(`invalid deck ${deckId}`)
    }
    if (!object(deck.cards)) fail(`invalid deck ${deckId}`)
    items.push({ path: `decks/${deckId}`, kind: 'deck', data: deck.deck })
    for (const id of Object.keys(deck.cards).sort()) {
      cardDoc(deckId, id, deck.cards[id])
      items.push({ path: `decks/${deckId}/cards/${id}`, kind: 'card', data: deck.cards[id] })
      cards++
      if (deck.cards[id].deletedAt > 0) tombstones++
    }
  }
  assignments(snapshot.users, snapshot.decks)
  items.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return {
    sha256: snapshot.sha256,
    items,
    userIds: Object.keys(snapshot.users),
    deckIds: Object.keys(snapshot.decks),
    counts: {
      users: Object.keys(snapshot.users).length,
      decks: Object.keys(snapshot.decks).length,
      cards,
      progress,
      settings,
      tombstones,
    },
  }
}

export function preflightRestore({ dumpPath, projectId, credentialName, reportPath }) {
  const plan = readFirestoreBackup(dumpPath)
  assertRestoreTarget(projectId)
  const serviceAccount = readPrivateJson(credentialPath(credentialName))
  if (!object(serviceAccount) || serviceAccount.project_id !== projectId) {
    throw new Error('Service account project does not match the requested project')
  }
  return { plan, reportPath: reserveRestoreReport(reportPath) }
}

// Ordinary parent queries omit a deleted account or deck even when progress,
// settings, or cards remain. Those surviving documents are still part of the target.
const ROOTS = { users: ['settings', 'progress'], decks: ['cards'] }

async function collectTarget(store) {
  const present = new Map()
  for (const [collection, knownChildren] of Object.entries(ROOTS)) {
    const rows = await store.list(collection)
    const data = new Map(rows.map((row) => [row.id, row.data]))
    const ids = new Set([...data.keys(), ...await store.listDocumentIds(collection)])
    for (const id of ids) {
      if (data.has(id)) present.set(`${collection}/${id}`, data.get(id))
      const docPath = `${collection}/${id}`
      const children = new Set([...knownChildren, ...await store.listSubcollections(docPath)])
      for (const child of children) {
        for (const row of await store.list(`${docPath}/${child}`)) present.set(`${docPath}/${child}/${row.id}`, row.data)
      }
    }
  }
  return present
}

function newerTarget(kind, before, data) {
  const fields = CLOCKS[kind]
  if (!fields) return false
  return fields.some((field) => typeof before?.[field] === 'number' && typeof data?.[field] === 'number' && before[field] > data[field])
}

function tally(documents) {
  return {
    documents,
    creates: documents.filter((row) => row.state === 'create').length,
    unchanged: documents.filter((row) => row.state === 'unchanged').length,
    newer: documents.filter((row) => row.state === 'newer-target').length,
    conflicts: documents.filter((row) => row.state === 'conflict' || row.state === 'newer-target').length,
    extras: documents.filter((row) => row.state === 'extra-target').length,
  }
}

function resultOf(plan, projectId, dryRun, state, classified, started) {
  return {
    dryRun, projectId, sha256: plan.sha256, state,
    counts: plan.counts,
    creates: classified.creates,
    unchanged: classified.unchanged,
    conflicts: classified.conflicts,
    newer: classified.newer,
    extras: classified.extras,
    documents: classified.documents,
    elapsedMs: Date.now() - started,
  }
}

function writeReport(destination, result) {
  const body = {
    version: 1,
    kind: 'firestore-restore-report',
    projectId: result.projectId,
    dumpSha256: result.sha256,
    dryRun: result.dryRun,
    state: result.state,
    elapsedMs: result.elapsedMs,
    documents: result.documents.map((row) => ({ path: row.path, kind: row.kind, state: row.state })),
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  writeFileSync(destination, `${JSON.stringify(body)}\n`, { flag: 'wx', mode: 0o600 })
}

async function verifyRestore(store, plan) {
  const present = await collectTarget(store)
  const dumpPaths = new Set(plan.items.map((item) => item.path))
  for (const item of plan.items) {
    if (!present.has(item.path) || !same(await store.get(item.path), item.data)) {
      throw new Error('Readback verification failed')
    }
  }
  for (const path of present.keys()) {
    if (!dumpPaths.has(path)) throw new Error('Readback verification failed')
  }
}

export function publicRestoreSummary(result) {
  return {
    dryRun: result.dryRun,
    projectId: result.projectId,
    sha256: result.sha256,
    state: result.state,
    users: result.counts.users,
    decks: result.counts.decks,
    cards: result.counts.cards,
    progress: result.counts.progress,
    settings: result.counts.settings,
    tombstones: result.counts.tombstones,
    creates: result.creates,
    unchanged: result.unchanged,
    conflicts: result.conflicts,
    newer: result.newer,
    extras: result.extras,
    elapsedMs: result.elapsedMs,
  }
}

/**
 * Compare a validated backup to the target. Dry-run never writes.
 * Apply creates missing documents only. Any different, newer, or extra
 * target document fails closed before the first write.
 */
export async function runRestore(plan, store, { dryRun = true, projectId, reportPath } = {}) {
  assertRestoreTarget(projectId)
  const destination = reportPath ? reserveRestoreReport(reportPath) : null
  const started = Date.now()
  let classified = tally([])
  let reported = false
  const finish = (state) => {
    const result = resultOf(plan, projectId, dryRun, state, classified, started)
    if (destination && !reported) {
      writeReport(destination, result)
      reported = true
    }
    return result
  }
  try {
    const present = await collectTarget(store)
    const dumpPaths = new Set(plan.items.map((item) => item.path))
    const documents = []
    for (const item of plan.items) {
      const before = present.has(item.path) ? present.get(item.path) : null
      const state = before === null ? 'create' : same(before, item.data) ? 'unchanged'
        : newerTarget(item.kind, before, item.data) ? 'newer-target' : 'conflict'
      documents.push({ path: item.path, kind: item.kind, state })
    }
    for (const path of present.keys()) {
      if (!dumpPaths.has(path)) documents.push({ path, kind: 'extra', state: 'extra-target' })
    }
    documents.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    classified = tally(documents)
    if (classified.conflicts > 0 || classified.extras > 0) return finish('refused')
    if (dryRun) return finish('dry-run')
    const byPath = new Map(plan.items.map((item) => [item.path, item]))
    for (const row of documents) {
      if (row.state !== 'create') continue
      const item = byPath.get(row.path)
      await store.atomic([row.path], ([before]) => {
        if (before == null) return [structuredClone(item.data)]
        if (same(before, item.data)) return [before]
        throw new Error('Target changed during restore; refusing to overwrite')
      })
    }
    await verifyRestore(store, plan)
    return finish(classified.creates === 0 ? 'already restored' : 'restored and verified')
  } catch (error) {
    try { finish('interrupted') } catch { /* keep the restore error */ }
    throw error
  }
}

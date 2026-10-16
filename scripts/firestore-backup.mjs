// Daily private Firestore backup. Stdout is aggregate status only.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { configDirectory, exportFirestore } from './migration-files.mjs'

const KEEP = 14
const require = createRequire(import.meta.url)

export function firestoreValue(value) {
  if (!value || typeof value !== 'object') throw new Error('Unsupported Firestore value')
  if ('nullValue' in value) return null
  if ('stringValue' in value) return value.stringValue
  if ('booleanValue' in value) return value.booleanValue
  if ('integerValue' in value) {
    const number = Number(value.integerValue)
    if (!Number.isSafeInteger(number)) throw new Error('Unsupported Firestore integer')
    return number
  }
  if ('doubleValue' in value) return value.doubleValue
  if ('mapValue' in value) {
    const fields = value.mapValue.fields ?? {}
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, firestoreValue(item)]))
  }
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(firestoreValue)
  throw new Error('Unsupported Firestore value')
}

export function backupCounts(snapshot) {
  let cards = 0
  let progress = 0
  let settings = 0
  let tombstones = 0
  let activity = 0
  for (const user of Object.values(snapshot.users)) {
    progress += Object.keys(user.progress ?? {}).length
    activity += Object.keys(user.activity ?? {}).length
    if (user.settings) settings += 1
    for (const deck of Object.values(user.decks ?? {})) {
      progress += Object.keys(deck.progress).length
      if (deck.settings) settings += 1
    }
  }
  for (const deck of Object.values(snapshot.decks)) {
    for (const card of Object.values(deck.cards ?? {})) {
      cards += 1
      if (card.deletedAt > 0) tombstones += 1
    }
  }
  return {
    users: Object.keys(snapshot.users).length,
    decks: Object.keys(snapshot.decks).length,
    cards, progress, settings, tombstones, activity,
  }
}

export function expiredBackups(names, keep = KEEP) {
  const dumps = names.filter((name) => /^firestore-\d{8}T\d{6}Z\.json$/.test(name)).sort()
  return dumps.slice(0, Math.max(0, dumps.length - keep))
}

function fieldsOf(fields) {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => [key, firestoreValue(value)]))
}

async function readJson(url, token) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Firestore read failed (${response.status})`)
  return response.json()
}

export function cliStore(token, projectId) {
  const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
  return {
    get: async (path) => {
      const body = await readJson(`${root}/${path}`, token)
      return body?.fields ? fieldsOf(body.fields) : null
    },
    list: async (path) => {
      const rows = []
      let page
      do {
        const url = new URL(`${root}/${path}`)
        url.searchParams.set('pageSize', '300')
        if (page) url.searchParams.set('pageToken', page)
        const body = await readJson(url, token)
        if (!body) break
        for (const doc of body.documents ?? []) rows.push({ id: doc.name.split('/').at(-1), data: fieldsOf(doc.fields) })
        page = body.nextPageToken
      } while (page)
      return rows
    },
  }
}

async function cliAccessToken() {
  const configPath = join(homedir(), '.config/configstore/firebase-tools.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const tokens = config.tokens
  if (!tokens?.access_token || !tokens.refresh_token) throw new Error('Firebase CLI is not logged in')
  if (Number(tokens.expires_at) > Date.now() + 60_000) return tokens.access_token
  const { clientId, clientSecret } = require('firebase-tools/lib/api.js')
  const body = new URLSearchParams({
    client_id: clientId(), client_secret: clientSecret(), refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
  })
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  })
  const next = await response.json()
  if (!response.ok || !next.access_token) throw new Error('Firebase CLI token refresh failed')
  tokens.access_token = next.access_token
  tokens.expires_in = next.expires_in
  tokens.expires_at = Date.now() + Number(next.expires_in) * 1000
  if (next.refresh_token) tokens.refresh_token = next.refresh_token
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return tokens.access_token
}

function writeStatus(directory, status) {
  const exports = join(directory, 'exports')
  mkdirSync(exports, { recursive: true, mode: 0o700 })
  writeFileSync(join(exports, 'backup-status.json'), `${JSON.stringify(status)}\n`, { mode: 0o600 })
}

function prune(directory) {
  const exports = join(directory, 'exports')
  for (const name of expiredBackups(readdirSync(exports))) rmSync(join(exports, name))
}

export async function runBackup({ store, directory }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const destination = join(directory, 'exports', `firestore-${stamp}.json`)
  const started = Date.now()
  try {
    const result = await exportFirestore(store, destination)
    const snapshot = JSON.parse(readFileSync(destination, 'utf8'))
    const status = {
      ok: true, at: snapshot.exportedAt, sha256: result.sha256, ...backupCounts(snapshot),
      elapsedMs: Date.now() - started, file: basename(destination),
    }
    writeStatus(directory, status)
    prune(directory)
    return status
  } catch (error) {
    writeStatus(directory, { ok: false, at: new Date().toISOString(), error: error.message })
    throw error
  }
}

async function main() {
  const projectId = 'flashcards-ls9-prod'
  const store = cliStore(await cliAccessToken(), projectId)
  const status = await runBackup({ store, directory: configDirectory })
  console.log(JSON.stringify(status))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

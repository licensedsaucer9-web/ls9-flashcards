import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const configDirectory = resolve(process.env.GERMAN_FLASHCARDS_PRIVATE_DIR || join(homedir(), '.config/german-flashcards'))

export function privatePath(input) {
  let ancestor = resolve(input)
  const suffix = []
  while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
  const path = join(realpathSync(ancestor), ...suffix)
  let directory = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path)
  while (!existsSync(directory)) directory = dirname(directory)
  try {
    execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { stdio: 'pipe' })
  } catch { return path }
  throw new Error('Private exports, mappings, and credentials must stay outside Git repositories')
}

export function readPrivateJson(path) {
  return JSON.parse(readFileSync(privatePath(path), 'utf8'))
}

export function credentialPath(name = 'service-account.json') {
  const path = privatePath(join(configDirectory, name))
  const root = realpathSync(configDirectory)
  const rel = relative(root, path)
  if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) throw new Error('Credentials must be inside the private operator directory')
  return path
}

export function snapshotDigest(snapshot) {
  const { sha256: _digest, ...body } = snapshot
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function readExport(path) {
  const snapshot = readPrivateJson(path)
  if (snapshot.sha256 !== snapshotDigest(snapshot)) throw new Error('Export checksum does not match; export the recorded commit again')
  return snapshot
}

function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** Admin SDK dump of users, progress, decks, and cards. Not a GitHub snapshot. */
export async function exportFirestore(store, output) {
  const destination = privatePath(output)
  if (existsSync(destination)) throw new Error('Export already exists; use a new timestamped filename')
  const decks = {}
  for (const deck of (await store.list('decks')).sort(byId)) {
    const cards = {}
    for (const row of (await store.list(`decks/${deck.id}/cards`)).sort(byId)) cards[row.id] = row.data
    decks[deck.id] = { deck: deck.data, cards }
  }
  const users = {}
  for (const user of (await store.list('users')).sort(byId)) {
    const progress = {}
    for (const row of (await store.list(`users/${user.id}/progress`)).sort(byId)) progress[row.id] = row.data
    const activity = {}
    for (const row of (await store.list(`users/${user.id}/activity`)).sort(byId)) activity[row.id] = row.data
    // Nested settings/progress do not require a users/{uid}/decks/{id}
    // parent document. Discover extra decks from their ownership documents.
    const userDecks = {}
    for (const [deckId, entry] of Object.entries(decks)) {
      if (entry.deck.ownerUid !== user.id) continue
      const deckProgress = {}
      for (const row of (await store.list(`users/${user.id}/decks/${deckId}/progress`)).sort(byId)) deckProgress[row.id] = row.data
      userDecks[deckId] = {
        settings: await store.get(`users/${user.id}/decks/${deckId}/settings/current`),
        progress: deckProgress,
      }
    }
    users[user.id] = {
      account: user.data,
      settings: await store.get(`users/${user.id}/settings/current`),
      progress,
      decks: userDecks,
      ...(Object.keys(activity).length ? { activity } : {}),
    }
  }
  const snapshot = {
    version: 2,
    kind: 'firestore',
    exportedAt: new Date().toISOString(),
    users,
    decks,
  }
  snapshot.sha256 = snapshotDigest(snapshot)
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  writeFileSync(destination, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 })
  return { path: destination, sha256: snapshot.sha256, users: Object.keys(users), decks: Object.keys(decks) }
}

/** git show reads one immutable commit, never the clone's working files. */
export function exportRepository(repo, commit, output) {
  const destination = privatePath(output)
  if (existsSync(destination)) throw new Error('Export already exists; use a new timestamped filename')
  const git = (...args) => execFileSync('git', ['-C', resolve(repo), ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const sha = git('rev-parse', '--verify', `${commit}^{commit}`).trim()
  const names = git('ls-tree', '-r', '--name-only', '-z', sha).split('\0').filter(Boolean)
  if (!names.includes('data.json')) throw new Error('Recorded commit has no data.json')
  const users = {}
  for (const name of names.filter((name) => /^users\/[^/]+\.json$/.test(name)).sort()) {
    if (!/^users\/[a-z0-9][a-z0-9-]{0,39}\.json$/.test(name)) throw new Error(`Invalid profile filename ${name}`)
    users[basename(name, '.json')] = JSON.parse(git('show', `${sha}:${name}`))
  }
  const snapshot = { version: 1, commit: sha, exportedAt: new Date().toISOString(),
    sourceRepository: basename(resolve(repo)), deck: JSON.parse(git('show', `${sha}:data.json`)), users }
  snapshot.sha256 = snapshotDigest(snapshot)
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  writeFileSync(destination, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 })
  return { path: destination, commit: sha, profiles: Object.keys(users), sha256: snapshot.sha256 }
}

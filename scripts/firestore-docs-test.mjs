// Pure adapters between deck/user files and Firestore documents. No emulator.
import {
  docsToFiles,
  filesToDocs,
  newUserAccount,
  remoteToDocs,
} from '../src/firestore-docs.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const live = {
  id: 'seed-01',
  de: 'Hund',
  en: 'dog',
  article: 'der',
  example_de: 'Der Hund schläft.',
  example_en: 'The dog is sleeping.',
  tags: ['a1', 'noun'],
  rank: 102,
  tier: 1,
  created_at: 10,
  updated_at: 20,
}

const customId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

const account = newUserAccount('uid-1')
assert(account.deckId === 'uid-1', 'a new account points at decks/{uid}')
assert(account.schemaVersion === 1, 'schema version is 1')
assert(account.migrationStatus === 'new', 'a client-created account is not migrated')

const deck = {
  version: 2,
  kind: 'deck',
  updated_at: 100,
  cards: [live, { ...live, id: customId, rank: undefined, tier: undefined, tags: [] }],
  deleted_ids: { 'seed-99': 77, 'seed-01': 50 },
}
const user = {
  version: 2,
  kind: 'user',
  user: 'joakim',
  updated_at: 100,
  settings_updated_at: 0,
  settings: { direction: 'en-de', sessionSize: 0, tier: 2 },
  progress: {
    'seed-01': { ease: 2.5, interval: 3, reps: 2, due: 400, updated_at: 80 },
    [customId]: { ease: 1.3, interval: 0, reps: 0, due: 0 },
  },
}

const docs = filesToDocs(deck, user)
const byId = new Map(docs.cards.map((entry) => [entry.id, entry.data]))
assert(byId.size === 3, `one document per id, got ${byId.size}`)
assert(byId.get('seed-01').de === 'Hund' && byId.get('seed-01').deletedAt === 50, 'a deleted live card keeps its content and its tombstone time')
assert(byId.get('seed-99').deletedAt === 77 && byId.get('seed-99').de === '', 'a deleted-only id stays as a document')
assert(byId.get(customId).deletedAt === 0 && byId.get(customId).rank === undefined, 'a custom id with no rank stays a live card')
assert(docs.progress.length === 2, 'progress is one document per scheduled card')
assert(docs.settings.direction === 'en-de' && docs.settings.sessionSize === 0 && docs.settings.tier === 2, 'settings fields are copied')
assert(docs.settings.settingsUpdatedAt === 0, 'a missing settings clock stays 0')

const round = docsToFiles(docs, 'joakim', 100)
assert(round.deck.cards.map((card) => card.id).join() === customId, 'tombstones leave the cards array')
assert(round.deck.deleted_ids['seed-01'] === 50 && round.deck.deleted_ids['seed-99'] === 77, 'tombstone times come back')
assert(round.deck.cards[0].de === 'Hund' && round.deck.cards[0].tags.length === 0, 'live vocabulary round-trips')
assert(round.user.progress['seed-01'].updated_at === 80, 'a progress clock round-trips')
assert(round.user.progress[customId].updated_at === undefined, 'a missing progress clock is omitted')
assert(round.user.settings_updated_at === 0, 'settings clock 0 is kept')
assert(!('missing' in round.deck.deleted_ids), 'a missing document is not a tombstone')

const onlyDeleted = filesToDocs(
  { version: 2, kind: 'deck', updated_at: 1, cards: [], deleted_ids: { 'seed-99': 77 } },
  null,
)
assert(onlyDeleted.cards.length === 1 && onlyDeleted.cards[0].data.deletedAt === 77, 'deletion without content is still a document')
assert(onlyDeleted.progress.length === 0, 'a deck file alone has no progress')
assert(onlyDeleted.settings.direction === 'de-en' && onlyDeleted.settings.settingsUpdatedAt === 0, 'missing user settings fall back to defaults')

const snapshot = {
  version: 1,
  updated_at: 1000,
  settings_updated_at: 900,
  settings: { direction: 'en-de', sessionSize: 15 },
  cards: [{ ...live, srs: { ease: 2.5, interval: 1, reps: 1, due: 50, updated_at: 40 } }],
  deleted_ids: { 'seed-99': 77 },
}
const fromLegacy = remoteToDocs(snapshot, 'joakim')
assert(fromLegacy, 'a v1 snapshot parses')
const legacyCards = new Map(fromLegacy.cards.map((entry) => [entry.id, entry.data]))
assert(legacyCards.get('seed-01').deletedAt === 0 && legacyCards.get('seed-99').deletedAt === 77, 'legacy deletions become tombstone documents')
assert(fromLegacy.progress.length === 1 && fromLegacy.progress[0].id === 'seed-01', 'legacy progress is kept')
assert(fromLegacy.progress[0].data.ease === 2.5 && fromLegacy.progress[0].data.updated_at === 40, 'legacy SRS fields are copied')
assert(fromLegacy.settings.direction === 'en-de' && fromLegacy.settings.tier === 1, 'legacy settings gain the default tier')
assert(fromLegacy.settings.settingsUpdatedAt === 900, 'an explicit legacy settings clock is kept')
const credited = docsToFiles(fromLegacy, 'joakim', 1000)
assert(credited.user.user === 'joakim', 'legacy progress is credited to the named profile')

const undated = remoteToDocs({ ...snapshot, settings_updated_at: undefined }, 'joakim')
assert(undated.settings.settingsUpdatedAt === 1000, 'a v1 snapshot without a settings clock uses its updated_at')

const fromDeck = remoteToDocs(
  { version: 2, kind: 'deck', updated_at: 5, cards: [live], deleted_ids: {} },
  'joakim',
)
assert(fromDeck.progress.length === 0 && fromDeck.cards.length === 1, 'a v2 deck file contributes vocabulary only')
assert(remoteToDocs({ version: 9 }, 'joakim') === null, 'an unknown payload is rejected')
assert(remoteToDocs(null, 'joakim') === null, 'null is rejected')

console.log('firestore docs ok')

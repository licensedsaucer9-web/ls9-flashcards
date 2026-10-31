// The IndexedDB layer, split by area (#122). Everything is re-exported from here so imports stay `./db.ts`.
export { DatabaseBlockedError, type DatabaseEvent, onDatabaseEvent, attachDatabaseGuards, type CloudScope, normalizeSettings } from './db-core.ts'
export { getDecks, getActiveDeck, putDeckFeatures, getDeckCardCounts, createLocalDeck, addStarterDeck, renameDeck, deleteLocalDeck, switchActiveDeck, recordCloudDeckId, recordAssignedDeck } from './db-decks.ts'
export { getSettings, putSettings } from './db-settings.ts'
export { getReviewActivity, saveReview } from './db-activity.ts'
export { localDeckFile, localUserFile, readLocalState, getAllCards, getCard, putCard, putCards, insertMissingSeeds, deleteCard, countCards, type DueByTier, getDueByTier, selectDueCards, getDueCards } from './db-cards.ts'
export { type MergeResult, mergeDeckIntoDb, mergeProgressIntoDb, acknowledgeRevision, type CloudSnapshot, readCloudSnapshot, acknowledgePending, applyStagedProgress } from './db-cloud.ts'
export { importLegacyData, localDatabaseHasWork } from './db-legacy.ts'
export { type GuestCopyMode, copyGuestDatabase } from './db-guest.ts'

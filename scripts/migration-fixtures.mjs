// Synthetic records only. No private deck, mapping, or export is stored in Git.
export const mapping = { version: 1, projectId: 'demo-german-flashcards', deckId: 'legacy-deck', profiles: { alice: 'uid-alice', bob: 'uid-bob' } }
export const srs = (over = {}) => ({ ease: 2.5, interval: 4, reps: 3, due: 1000, updated_at: 100, ...over })
export const card = (id, over = {}) => ({ id, de: 'Hund', en: 'dog', article: 'der', example_de: '', example_en: '', tags: [], created_at: 1, updated_at: 100, ...over })
export const user = (profile, over = {}) => ({ version: 2, kind: 'user', user: profile, updated_at: 100, settings_updated_at: 100,
  settings: { direction: 'en-de', sessionSize: 10, tier: 2 }, progress: { 'custom-1': srs() }, ...over })
export function snapshot(over = {}) {
  return { version: 1, commit: 'a'.repeat(40), deck: { version: 2, kind: 'deck', updated_at: 100,
    cards: [card('custom-1'), card('seed-01')], deleted_ids: { 'seed-02': 50 } },
  users: { alice: user('alice'), bob: user('bob', { progress: { 'custom-1': srs({ reps: 9 }) } }), stranger: user('stranger') }, ...over }
}

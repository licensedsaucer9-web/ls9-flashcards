const {
  wordTypes,
  wordTypeLabel,
  wordTypeBadgeHtml,
  reviewFaces,
  tagsWithWordType,
  editorWordType,
  editorTagField,
  normalizeWordTypes,
  validWordTypeList,
  inSelectedWordTypes,
  toggleWordType,
  countWordTypes,
  noDueWordTypeMessage,
  wordTypeSelectionLabel,
} = await import('../src/word-types.ts')
const { importCsv } = await import('../src/csv.ts')
const { selectDueCards } = await import('../src/db.ts')
const { sessionCount } = await import('../src/session.ts')
const { validateSettings } = await import('../src/migration-data.ts')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const noun = { de: 'Mann', en: 'man', article: 'der', tags: ['a1', 'noun'] }
const verb = { de: 'sein', en: 'to be', article: 'none', tags: ['verb'] }
const adj = { de: 'gut', en: 'good', article: 'none', tags: ['adj'] }
const both = { de: 'Orange', en: 'orange', article: 'die', tags: ['adj', 'noun'] }
const untyped = { de: 'hmm', en: 'hmm', article: 'none', tags: [] }
const articleOnly = { de: 'Haus', en: 'house', article: 'das', tags: [] }
const explicitOther = { de: 'Haus', en: 'house', article: 'das', tags: ['other'] }

assert(wordTypes(noun).join() === 'noun', 'noun tag')
assert(wordTypeLabel('noun') === 'noun' && wordTypeLabel('verb') === 'verb' && wordTypeLabel('adj') === 'adj.', 'labels')
assert(wordTypes(both).join() === 'noun,adj', `fixed order noun then adj, got ${wordTypes(both)}`)
assert(wordTypes({ tags: ['verb', 'noun', 'adj'], article: 'none' }).join() === 'noun,verb,adj', 'full fixed order')
assert(wordTypes(untyped).length === 0, 'untyped')
assert(wordTypes(articleOnly).join() === 'noun', 'article without a tag is a noun')
assert(wordTypes(explicitOther).length === 0, 'explicit other is untyped even with an article')
assert(wordTypes({ tags: ['Verb'], article: 'none' }).join() === 'verb', 'tag case ignored')
assert(wordTypes({ tags: ['noun', 'noun'], article: 'none' }).join() === 'noun', 'duplicate type once')

const badge = wordTypeBadgeHtml(both)
assert(badge.includes('>noun · adj.<'), `badge text ${badge}`)
assert(badge.includes('aria-label="Word type: noun, adjective"'), `badge aria ${badge}`)
assert(wordTypeBadgeHtml(adj).includes('aria-label="Word type: adjective"'), 'adjective spoken')
assert(wordTypeBadgeHtml(adj).includes('>adj.<'), 'adj. visible')
assert(wordTypeBadgeHtml(untyped) === '', 'untyped has no badge')
assert(wordTypeBadgeHtml(articleOnly).includes('>noun<'), 'inferred noun badge')
assert(wordTypeBadgeHtml(explicitOther) === '', 'explicit other has no badge')

const en = reviewFaces(noun, 'en-de')
assert(en.front.className === 'face front', `EN front class ${en.front.className}`)
assert(!en.front.className.includes('gender'), 'EN front has no gender class')
assert(!en.front.kickerHtml.includes('article'), `EN front kicker ${en.front.kickerHtml}`)
assert(!en.front.wordClass, 'EN front word has no gender class')
assert(en.front.wordText === 'man', 'EN front is the English word')
assert(!en.front.wordText.includes('Mann'), 'EN front hides German')
assert(en.front.kickerHtml.includes('word-type'), 'EN front has the badge')
assert(en.back.className === 'face back gender-der', `back keeps gender: ${en.back.className}`)
assert(en.back.kickerHtml.includes('class="article der"'), 'back shows the article')
assert(en.back.wordText === 'der Mann', 'back shows German')

const de = reviewFaces(noun, 'de-en')
assert(de.front.className === 'face front gender-der', 'DE front keeps gender')
assert(de.front.kickerHtml.includes('class="article der"'), 'DE front keeps the article')
assert(de.front.kickerHtml.includes('aria-label="Word type: noun"'), 'DE badge says noun, not the article')
assert(de.front.wordText === 'der Mann', 'DE front still shows the German head')
const verbFront = reviewFaces(verb, 'de-en').front
assert(!verbFront.kickerHtml.includes('class="article'), 'verb front has no article')
assert(verbFront.kickerHtml.includes('>verb<'), 'verb badge replaces the old fallback')
assert(!verbFront.kickerHtml.includes('>word<'), 'no generic word fallback')
assert(reviewFaces(untyped, 'de-en').front.kickerHtml === '', 'untyped DE front has no kicker')

assert(editorWordType(['a1', 'noun'], 'der') === 'noun', 'editor reads noun')
assert(editorWordType(['adj', 'noun'], 'die') === 'noun', 'editor select is the first fixed type')
assert(editorWordType([], 'das') === 'noun', 'editor infers noun from article')
assert(editorWordType(['other'], 'der') === 'other', 'editor keeps explicit other')
assert(editorWordType([], 'none') === 'other', 'editor other when untyped')
assert(editorTagField(['a1', 'noun', 'topic']) === 'a1, topic', `type tags leave the field: ${editorTagField(['a1', 'noun', 'topic'])}`)

assert(
  JSON.stringify(tagsWithWordType('a1, topic', 'verb', ['a1', 'noun', 'topic'])) === '["a1","verb","topic"]',
  'changing type keeps other tags in place',
)
assert(
  JSON.stringify(tagsWithWordType('a1, topic', 'noun', ['a1', 'noun', 'adj', 'topic'])) === '["a1","noun","adj","topic"]',
  'unchanged select keeps every type',
)
assert(JSON.stringify(tagsWithWordType('a1', 'other', ['a1', 'verb'])) === '["a1","other"]', 'other replaces the type')
assert(JSON.stringify(tagsWithWordType('custom', 'adj', [])) === '["adj","custom"]', 'new tags follow the type')
assert(
  !tagsWithWordType('noun, a1', 'verb', ['noun', 'a1']).includes('noun'),
  'select wins over a type typed into tags',
)

const now = 1_700_000_000_000
const legacy = importCsv('de,en,article,example_de\nZaun,fence,der,Der Zaun.\nlaufen,to run,none,Ich laufe.\n', [], now)
assert(legacy.errors.length === 0, `legacy csv errors ${legacy.errors}`)
assert(legacy.imported.length === 2, 'legacy csv imports')
assert(
  legacy.imported[0].tags.includes('imported') && legacy.imported[0].tags.includes('noun'),
  `guess noun ${legacy.imported[0].tags}`,
)
assert(legacy.imported[1].tags.join() === 'imported', `no guess without article ${legacy.imported[1].tags}`)

const typed = importCsv(
  'de,en,article,example_de,type\nOrange,orange,die,Die Orange.,adjective\nschnell,fast,none,Er ist schnell.,other\nHaus,house,der,Das Haus.,other\ngehen,to go,none,Ich gehe.,verb\nbogus,x,none,x,particle\n',
  [],
  now,
)
assert(typed.imported.length === 4, `typed import count ${typed.imported.length} ${typed.errors}`)
assert(typed.imported[0].tags.includes('adj') && typed.imported[0].tags.includes('imported'), 'adjective alias')
assert(typed.imported[1].tags.includes('other') && !typed.imported[1].tags.includes('noun'), 'explicit other')
assert(typed.imported[2].tags.includes('other') && !typed.imported[2].tags.includes('noun'), 'other overrides the noun guess')
assert(wordTypes(typed.imported[2]).length === 0, 'imported other with an article stays untyped')
assert(typed.imported[3].tags[0] === 'verb', 'verb column')
assert(typed.errors.length === 1 && typed.errors[0].includes('type'), `bad type ${typed.errors}`)

const positional = importCsv('flüstern,to whisper,none,Bitte flüstern.,verb\n', [], now)
assert(
  positional.imported.length === 1 && positional.imported[0].tags.includes('verb'),
  `positional type ${positional.imported[0]?.tags}`,
)

const extraIgnored = importCsv('Hund,dog,der,Der Hund.,a note that is not a type\n', [], now)
assert(
  extraIgnored.errors.length === 0 && extraIgnored.imported[0].tags.includes('noun') && !extraIgnored.imported[0].tags.includes('a note that is not a type'),
  `extra column ignored ${extraIgnored.errors} ${extraIgnored.imported[0]?.tags}`,
)

const mid = importCsv('de,en,type,article,example_de\nKatze,cat,noun,die,Die Katze.\n', [], now)
assert(
  mid.imported.length === 1 && mid.imported[0].article === 'die' && mid.imported[0].tags.includes('noun') && mid.imported[0].example_de === 'Die Katze.',
  `named columns ${JSON.stringify(mid)}`,
)

const blankType = importCsv('de,en,article,example_de,type\nBaum,tree,der,Der Baum.,\n', [], now)
assert(blankType.imported.length === 1 && blankType.imported[0].tags.includes('noun'), 'blank type still guesses noun')

assert(normalizeWordTypes(undefined).length === 0, 'missing filter is All')
assert(normalizeWordTypes('noun').length === 0, 'a non-list is All')
assert(normalizeWordTypes(['verb', 'noun', 'verb', 'adverb', 'adjective']).join() === 'noun,verb,adj', 'unknown dropped, aliases kept, sorted, unique')
assert(validWordTypeList(['verb', 'noun']), 'any order of known types is valid')
assert(!validWordTypeList(['noun', 'noun']), 'duplicates are not a stored list')
assert(!validWordTypeList(['adverb']), 'unknown type is rejected')
assert(!validWordTypeList('noun'), 'a string is not a type list')
validateSettings({ direction: 'de-en', sessionSize: 20, tier: 1 })
validateSettings({ direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['adj'] })
let rejectedType = false
try { validateSettings({ direction: 'de-en', sessionSize: 20, tier: 1, wordTypes: ['adverb'] }) } catch { rejectedType = true }
assert(rejectedType, 'migration rejects an unknown word type')

assert(inSelectedWordTypes(untyped, []), 'All includes an untyped card')
assert(inSelectedWordTypes(explicitOther, []), 'All includes an explicit other')
assert(!inSelectedWordTypes(explicitOther, ['noun']), 'explicit other is not a noun')
assert(inSelectedWordTypes(articleOnly, ['noun']), 'an article with no tag is a noun')
assert(!inSelectedWordTypes(verb, ['noun']), 'a verb is not a noun')
assert(inSelectedWordTypes(both, ['adj']) && inSelectedWordTypes(both, ['noun']), 'a card with two types matches either')

assert(toggleWordType([], 'verb').join() === 'verb', 'the first type leaves All')
assert(toggleWordType(['verb'], 'noun').join() === 'noun,verb', 'a second type is added')
assert(toggleWordType(['noun', 'verb'], 'noun').join() === 'verb', 'one type can be turned off')
assert(toggleWordType(['verb'], 'verb').length === 0, 'the last type returns to All')
assert(wordTypeSelectionLabel([]) === '', 'All has no extra label')
assert(wordTypeSelectionLabel(['verb', 'noun']) === 'Nouns, Verbs', 'selection label follows noun, verb, adjective order')
assert(noDueWordTypeMessage(['verb'], 1) === 'No verbs due in Tier 1', 'one type says what is missing')
assert(noDueWordTypeMessage(['verb', 'noun'], 1) === 'No nouns or verbs due in Tier 1', 'two types are joined with or')
assert(noDueWordTypeMessage(['adj', 'verb', 'noun'], 2) === 'No nouns, verbs or adjectives due in Tier 2', 'three types stay in fixed order')

const counts = countWordTypes([
  { tags: ['noun'], due: true },
  { tags: ['verb'], due: false },
  { tags: ['noun', 'adj'], due: true },
  { tags: ['other'], article: 'none', due: true },
])
assert(counts.all.words === 4 && counts.all.due === 3, 'All counts every card once')
assert(counts.noun.words === 2 && counts.noun.due === 2, 'noun counts include a card that is also an adjective')
assert(counts.verb.words === 1 && counts.verb.due === 0, 'a not-due verb is a word but not due')
assert(counts.adj.words === 1 && counts.adj.due === 1, 'the shared card counts as an adjective too')

function dueCard(id, de, tags, tier, due, article = 'none') {
  return {
    id, de, en: de, article, example_de: '', example_en: '', tags, tier,
    created_at: 1, updated_at: 1,
    srs: { ease: 2.5, interval: 1, reps: 1, due, updated_at: 1 },
  }
}
const nowDue = 1_000
const deck = [
  dueCard('n1', 'Mann', ['noun'], 1, nowDue, 'der'),
  dueCard('n2', 'Frau', ['noun'], 1, nowDue + 5, 'die'),
  dueCard('n3', 'Kind', ['noun'], 1, nowDue + 9, 'das'),
  dueCard('v1', 'sein', ['verb'], 1, nowDue + 2),
  dueCard('u1', 'hmm', [], 1, nowDue + 3),
  dueCard('b1', 'Orange', ['adj', 'noun'], 1, nowDue + 4, 'die'),
  dueCard('later', 'Haus', ['noun'], 1, nowDue + 50, 'das'),
  dueCard('wide', 'Zeit', ['noun'], 2, nowDue, 'die'),
]
const before = JSON.stringify(deck.map((card) => card.srs))
const nouns = selectDueCards(deck, 1, ['noun'], nowDue + 10)
assert(nouns.map((card) => card.id).join() === 'n1,b1,n2,n3', `nouns in tier 1, once each, by due time: ${nouns.map((card) => card.id)}`)
assert(selectDueCards(deck, 1, ['verb'], nowDue + 10).map((card) => card.id).join() === 'v1', 'verbs alone')
assert(selectDueCards(deck, 1, ['adj'], nowDue + 10).map((card) => card.id).join() === 'b1', 'adjectives alone')
const combined = selectDueCards(deck, 1, ['verb', 'noun'], nowDue + 10)
assert(combined.map((card) => card.id).join() === 'n1,v1,b1,n2,n3', 'combining types is a union and still one copy of a shared card')
assert(!combined.some((card) => card.id === 'u1'), 'an untyped card is outside a type selection')
const allTypes = selectDueCards(deck, 1, [], nowDue + 10)
assert(allTypes.some((card) => card.id === 'u1') && allTypes.some((card) => card.id === 'v1'), 'All keeps untyped cards and every type')
assert(!allTypes.some((card) => card.id === 'later' || card.id === 'wide'), 'not-due cards and higher tiers stay out')
assert(JSON.stringify(deck.map((card) => card.srs)) === before, 'filtering does not change a schedule')
assert(deck.find((card) => card.id === 'later').srs.due === nowDue + 50, 'a filtered-out card keeps its due time')
assert(sessionCount(nouns.length, 0) === nouns.length, 'session size 0 means every matching due card')
assert(sessionCount(nouns.length, 2) === 2, 'session size still caps the filtered queue')
assert(sessionCount(selectDueCards(deck, 1, ['verb'], nowDue + 10).length, 20) === 1, 'a short filtered queue is not padded')

console.log('word-types-test: ok')

# Built-in language decks

German–English has **764** cards: the original 514 in tiers 1-3 and 250 rarer words in
tier 4 (see [German tier 4](#german-tier-4)). French–English and Spanish–English each have **567**:
356 nouns, 121 verbs and 90 adjectives. These are curated beginner content-word
sets covering people, home, food, clothing, travel, nature, time, work, school,
communication and everyday actions. They are not a translation of the German
list. Shared concepts have language-specific vocabulary, gender and examples;
regional choices favor metropolitan French and European Spanish (for example
`ordinateur`, `ordenador`, `zumo`, `patata`). Adjectives use masculine singular
citation forms. Nouns referring to people use the gender of the displayed form,
not a claim that every person in that role is male.

Open **Decks → Starter decks → Add French** or **Add Spanish**. The action adds
and selects that language explicitly; it never replaces German or another deck.
The button becomes **Select**. It is safe to use repeatedly. Both directions,
examples, card editing, cumulative tiers, word-type filters, per-deck session
preferences and normal SRS are available. Streak activity remains account-wide.
Built-ins, including German, are protected from whole-deck deletion to retain
their identity and history; individual cards can be deleted normally.

Each new deck has 100 cards in tier 1, another 150 in tier 2, and 317 in tier 3.
They have no tier 4 for now: their tiers already cover all 567 words, so Review hides
their empty `T4` pill. Higher tiers include lower tiers. The numbers are deck positions after sorting
by that language's corpus ranks, not raw corpus-rank cutoffs.

## Content and ranking provenance

`src/decks/vocabulary.tsv` contains original vocabulary selection, English
glosses and parallel verb examples. Its first column is an immutable card key;
append new keys, never recycle them or renumber existing entries. The generator
creates noun examples using the natural topic-introduction construction
“Nous parlons de …” / “Hablamos de …” with the correct contractions, and adjective
examples with a masculine pronoun or an explicit referent. These deliberately
simple repeated frames support beginners without importing corpus sentences.
The checked-in JSON files contain the complete examples, translations, article
metadata, ranks, matched corpus forms and tiers used by the app.

Ranks are from Hermit Dave's [FrequencyWords](https://github.com/hermitdave/FrequencyWords)
French and Spanish **OpenSubtitles 2018** 50,000-word lists, pinned at revision
`525f9b560de45753a5ea01069454e72e9aa541c6`. Upstream identifies the
[OpenSubtitles source](https://opus.nlpl.eu/OpenSubtitles2018.php) and licenses
its content under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
(the generator code's MIT license is distinct). Attribution: Hermit Dave,
FrequencyWords; OpenSubtitles 2018 via OPUS. The French/Spanish TSV and JSON
content, including the derived rankings, are distributed under **CC BY-SA 4.0**;
this is an exception to the repository's MIT code license. Changes here are the
curated vocabulary, original bilingual examples and derived ranks/tiers. No
subtitle dialogue or full frequency list is bundled.

The generator looks up the exact lower-case citation form. Reflexive and
multiword expressions use the head token; explicit overrides cover cases such
as Spanish `vestirse` → `vestir` and French `petit-déjeuner` → `déjeuner`.
`rankForm` records the actual lookup, so this is a surface-frequency proxy,
not a claim of lemmatized frequency. There are no unmatched entries. Ranks are
independent by language; equal ranks are ordered by immutable card ID. The
source file's SHA-256 is recorded in each generated JSON.

Reproduce from the repository root (network only to download the pinned inputs):

```sh
revision=525f9b560de45753a5ea01069454e72e9aa541c6
curl -fL "https://raw.githubusercontent.com/hermitdave/FrequencyWords/$revision/content/2018/fr/fr_50k.txt" -o /tmp/fr_50k.txt
curl -fL "https://raw.githubusercontent.com/hermitdave/FrequencyWords/$revision/content/2018/es/es_50k.txt" -o /tmp/es_50k.txt
node scripts/build-starter-decks.mjs /tmp/fr_50k.txt /tmp/es_50k.txt --check
node --experimental-strip-types scripts/starter-decks-test.mjs
```

Omit `--check` to regenerate after a deliberate content edit. The content test
checks unique stable IDs and front/back pairs, required bilingual fields,
NFC/Unicode integrity, word classes, language article sets and all cumulative
tier positions. Editorial choices include feminine `la mano`, masculine
`le problème` / `el problema`, and French elision retaining its gender.
Automated structural checks do not constitute independent native-speaker review.

## German tier 4

Tier 4 adds 250 German words (165 nouns, 40 verbs, 45 adjectives), each less frequent
than every word in tiers 1-3. They live in `src/seed-tier4.ts`, appended to the deck by
`src/seed.ts`, with the same fields as the original seeds: article, German and English
example, and `['b1', <type>]` tags so word-type filters, gender grading and Hard mode
work unchanged. The archived `ls9-flashcards-data` repository is not involved.

**Source.** The same corpus and inflection heuristic as tiers 1-3:
`scripts/rank-words.mjs` against Hermit Dave's FrequencyWords German **OpenSubtitles 2018**
lists at the revision pinned above. Tiers 1-3 were ranked on `de_50k.txt`; tier 4 words
are all past that list, so they are ranked on `de_full.txt` (1,157,685 lines), whose first
50,000 lines are exactly `de_50k.txt`. Both therefore share one rank scale.

**Cut-off.** Three original compounds (`Nachrichtensendung`, `Terminplaner`,
`Platzkarte`) are not in the 50k list and carry 900000+ placeholder ranks. In the full
list the rarest tier 1-3 word is `Platzkarte`, via `platzkarten`, at rank **100,105**
(`TIER_3_MAX_RANK`). Every tier 4 rank is above it; tier 4 spans ranks 100,138 to
551,370, within the 1,000,000 rank limit in `firestore.rules`. Inflected forms are
included in a word's rank exactly as for tiers 1-3, so a word with a common inflection
was not eligible. The existing rows, including their placeholders, are unchanged.

**No overlap.** No tier 4 word is a tiers 1-3 word, compared by lower-cased lemma, and
none is a duplicate or an inflected form (the same endings as the ranker) of another
deck word; English glosses and front/back pairs are unique too. Compounds of existing
words (`Winterjacke` beside `Jacke`) are separate lemmas and allowed.

**IDs and sync.** IDs are `seed-515` to `seed-764`, after the existing `seed-01` …
`seed-514` and disjoint from the `seed-fr-`/`seed-es-` starters. Seed content clocks
are zero. Opening the app runs the normal original-deck seed update, which inserts
only absent IDs without a tombstone: existing accounts receive the 250 cards (queued
for upload with fresh, unstudied schedules) without touching existing cards, edits,
schedules, tiers or deletions, and a deleted tier 4 seed stays deleted. Fresh accounts
seed all 764. Existing study scopes keep their meaning, so tier 4 is opt-in on
existing decks; see [architecture](architecture.md).

Verify from the repository root (network only to download the pinned list):

```sh
revision=525f9b560de45753a5ea01069454e72e9aa541c6
curl -fL "https://raw.githubusercontent.com/hermitdave/FrequencyWords/$revision/content/2018/de/de_full.txt" -o /tmp/de_full.txt
node scripts/rank-words.mjs /tmp/de_full.txt --check > /dev/null
node --experimental-strip-types scripts/seed-tier4-test.mjs
```

`--check` recomputes every rank, confirms `TIER_3_MAX_RANK` and that every tier 4 word
is rarer. `seed-tier4-test.mjs` (in `npm test`) checks the checked-in data: count, IDs,
no overlap or near-duplicates, fields and limits, Hard-mode answers and the cut-off.
Tier selection and the seed update for a pre-tier-4 database are covered by
`scripts/tier-selection-ui-test.mjs`. As with the other built-ins, automated checks are
not a native-speaker review.

**Deployment prerequisite.** `firestore.rules` now accepts tier 4 on cards and in the
`tier` and `selectedTiers` settings fields. The currently recorded production rules
reject them. Every existing account uploads the new cards on its next open, and
rejected writes stay pending and keep the sync status red, so deploy the updated rules through the
normal operator procedure **before** this client is published (master publishes Pages;
Pages does not deploy rules). The change is additive, so older clients keep working
under the new rules.

## Compatibility, seeds and sync

The historical `de`, `en`, `example_de`, `example_en` field names and `de-en` /
`en-de` direction tokens now mean target/base language. Keeping these wire names
avoids a data migration. Existing German IDs, database version, account assignment,
progress and default provisioning remain unchanged. New accounts still start with
German only. Starter cards use `seed-fr-KEY` / `seed-es-KEY`, retaining the existing
`seed-` tombstone protection. Seed content clocks are zero. Repeated addition
only inserts absent IDs without tombstones: it never overwrites user content,
schedules, tiers or preferences. Future seed corrections apply to fresh additions;
existing user edits are preserved. Appending new keys makes them available on the
next explicit catalog selection. Reopening alone does not reseed a starter.

A starter deck ID is a domain-separated SHA-256-derived UUID in the existing
extra-deck namespace, stable per Firebase UID and language, or per device-study
database and language. Addition and selection commit atomically with cards and
pending upload marks. Local metadata carries a `starter` catalog key. No new
Firestore collection, document field or IndexedDB schema version is needed.

Because the ID is derived from the UID, another signed-in account could create
that deck document first. Sync detects a deck it can neither create nor read and
records a fresh random `cloudId` on the local deck row; Firestore paths then use
that ID while local cards and pending marks keep the starter ID. The first
recorded `cloudId` wins: a tab that falls back concurrently adopts it rather
than overwriting it. A device that
falls back this way does not converge with the account's other devices for that
starter.

French article tokens are `le`, `la`, `l_m`, `l_f`, `les_m`, `les_f` and `none`.
Spanish uses `el`, `la`, `el_f`, `los`, `las` and `none`. The elided French tokens
display `l’` without a space and retain masculine/feminine information; Spanish
`el_f` displays `el` while retaining feminine gender (for example `el agua`).
Badges and editor labels show that gender; masculine/feminine colors reuse the
German palette. German `der`, `die`, `das` behavior remains unchanged. CSV import
accepts all supported article tokens and the same generic front/back columns.

**Deployment prerequisite:** the additive article whitelist in `firestore.rules`
must be deployed separately through the normal operator procedure before these
new cards can sync against production. The currently recorded production rules
reject these new tokens. Pages does not deploy rules; this change does not deploy,
publish a preview or touch any account. Old German clients remain compatible
with the additive rules, but should be upgraded before opening these decks because
they cannot render the new article tokens correctly. New client/operator validation
and guarded restore accept the same values. No schema-version migration is needed.

All cards, tombstones, progress and preferences follow the existing private
extra-deck sync paths. Names, selection, capability switches and the deck list
remain device-local. On another device signed into the **same account**, explicitly
adding the same starter derives the same private deck ID; normal sync then merges
its edits, deletions, schedules and study preferences. Wait for sync before study
when recovering an existing account's starter on a new device. Offline addition
cannot discover newer cloud state. Generic extra decks still require their ID
in the other device's local list; there is no automatic deck-list discovery or
sharing redesign. Device-study data is separate; the existing confirmed copy
flows and their limitations still apply.

Supported Firestore version-2 dumps include these decks, article tokens, owned
progress/settings and tombstones. The updated guarded restore must be used for
new article values; an older operator checkout rejects them. Dumps do not restore
local deck names, selections or capability switches; re-add the same starter on
the same account to attach its deterministic ID. CSV is a vocabulary import,
not an SRS/preferences/tombstone backup.

## Verification

`npm test` includes the structural content/cloud tests and a synthetic version-2
export/restore of both complete starters with progress, preferences, tombstones
and ownership. `npm run test:rules` includes valid new article values and denied
non-member access, alongside the existing private extra-deck tests. CI runs the
full regression suite; all browser/account/emulator fixtures are synthetic.

`npm run test:starter-ui` runs `scripts/starter-decks-ui-test.mjs`. The new test
checks both additions and directions, language-specific gender/editor labels,
editing, repeated addition/reopen, card deletion retention, per-deck preferences,
German content/schedule preservation and account-wide streak accumulation. Its
second phase uses a built service worker for offline reopen and grading of both
decks. Locally run `npm run build` first. CI uses the staged Firebase artifact,
in device-study mode, with `STARTER_ARTIFACT_DIR=dist-firebase` and
`STARTER_APP_BASE=/ls9-flashcards-site/`.

These synthetic checks do not establish production rules deployment, publication,
installed-device acceptance or a real two-device production recovery result.
Those operational checks remain separate from implementation and use the existing
rollout plan/runbooks. No production or real rehearsal data was modified.

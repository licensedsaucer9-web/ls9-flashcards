# Architecture and data guarantees

This describes the implementation as of 2026-10-17, including published streaks,
multiple decks, per-deck preferences/progress, and swipe tab navigation.
For what is deployed and what remains, use the
[rollout plan](firebase-rollout-plan.md).

## Build modes

Vite's `account-backend` plugin swaps `src/account.ts` and
`src/sync-backend.ts` for the Google/Firestore implementations only when
`VITE_SYNC_BACKEND=firebase`. Without that flag, the app studies locally.

Ordinary Firebase builds use the public production configuration in
`src/firebase-web.ts`. An explicit override needs all four
`VITE_FIREBASE_*` values; partial configuration does not fall through to
production. The rehearsal builder selects the test project explicitly and
uses `VITE_REHEARSAL_PREVIEW=true`. `npm run recovery-bridge:build` writes
`dist-recovery-bridge` with `VITE_RECOVERY_BRIDGE=true` and base
`/german-flashcards-site/`. That artifact keeps the original storage prefix
and the installed app's manifest identity, refuses an account that is not a
completed legacy assignment, and is not a Pages publish input. A signed-out
open reads the legacy database and does not seed or import into it. Web
configuration is public; Admin SDK credentials belong only to local operator
commands.

Every app build embeds its package version, full Git source commit, dirty-source
flag, backend/project, base path, build mode and emulator flag. The same public
identity is emitted as `release.json` and precached by the service worker.
Settings reads the bundled identity without network access, so an installed
offline client reports the version it is actually running. A source change
alters the bundled identity and worker precache revision.

`release:build` requires a clean committed source tree and matching publication
gates (both currently master-only and disabled on pull requests),
explicitly selects production public configuration, clears preview/emulator
modes, runs type/build/artifact checks, then writes `release-candidate.json`.
That manifest binds the identity and sorted SHA-256 file inventory; local
verification rejects added, missing or modified files. It is an artifact
fingerprint, not a signature or a proof that the release gates passed. CI
retains the candidate only after its other tests pass. Post-publication
read-only verification compares served bytes and the public `gh-pages` commit,
with before/after branch checks. The site commit is recorded then, rather than
invented at build time: embedding a commit inside itself would change that
commit. Production data/device acceptance remains separate.

## Identity and storage

The LS9 product/package rename keeps the original `german-flashcards`
storage prefixes and `GERMAN_FLASHCARDS_PRIVATE_DIR` variable. Repository and
URL names are separate from data identity; see [the rename record](rename.md).

Google Authentication uses browser-local persistence. Firebase UID selects
the account's IndexedDB database and Firestore ownership; a name or email
is only a label. Guest and legacy profile databases stay separate and are
not deleted or renamed on sign-in. Copying device data requires confirmation.

A new account gets a deterministic personal deck at `decks/{uid}`.
Provisioning keeps an existing account's assigned deck. An Admin import
preassigns legacy users to `legacy-german`, where vocabulary is shared but
each user's progress and settings stay private.

The rehearsal uses the `german-flashcards-rehearsal` storage prefix. It
preserves the root app's databases, profile list, preferences, and token keys.
It accepts only a schema-1, completed legacy assignment; missing or pending
assignments cannot create personal decks. An authenticated session can
therefore remain in device study while showing an import guard. Current
source shows **Signed in to Google** and **Sign out of Google** in that state.

Ordinary builds remove the obsolete `german-flashcards.github` and
`german-flashcards.github.shas` keys on launch. The source has no active
GitHub data transport, and the published Firebase app has no GitHub writer.
The archived legacy repository is a frozen pre-Firebase recovery snapshot.

Theme selection (Dark or Light) is stored in the browser’s localStorage under
the build’s storage prefix, independently of accounts, decks, and Firestore.
Startup restores it before rendering the app; missing or invalid choices use
the original Dark palette. If storage is blocked, switching still works for
the current page and Settings reports that it could not persist the choice.
Shared CSS color tokens cover screens, cards, controls, semantic article/grade
colors, shadows and dialogs; browser theme-color follows the active palette.

## Firestore layout

| Path | Contents and access |
| --- | --- |
| `users/{uid}` | Owner-readable account metadata, deck assignment, schema version, migration status. |
| `users/{uid}/settings/current` | Owner-only direction, session size, tier, and settings clock. |
| `users/{uid}/progress/{cardId}` | Owner-only SRS state and its clock. |
| `users/{uid}/decks/{deckId}/progress/{cardId}` | Owner-only extra-deck SRS state; missing means unstudied. |
| `users/{uid}/decks/{deckId}/settings/current` | Owner-only extra-deck preferences and settings clock, using the original settings shape. |
| `users/{uid}/activity/{eventId}` | Owner-only saved-review timestamp and time zone, keyed by UUID; payload immutable, owner deletion allowed. |
| `decks/{deckId}` | Explicit deck membership. Clients cannot alter membership or assign themselves to a legacy deck. |
| `decks/{deckId}/cards/{cardId}` | Vocabulary, content clock, optional rank/tier, and deletion tombstone; deck members can edit. |

Rules also permit a signed-in user to create a private extra deck at a lowercase
version-4 UUID, matching `createLocalDeck`'s `crypto.randomUUID()` ids (which also
pass `validId`). The id must differ from their uid and have no existing account
document at `users/{deckId}`. `ownerUid` must equal their uid and `memberUids`
must contain only that uid. This excludes generated alphanumeric Auth UIDs,
including accounts that have not provisioned yet. Admin-created custom Auth UIDs
must reserve the UUID namespace for extra decks: Firestore rules cannot inspect
Auth accounts or protect a future custom UID that deliberately uses a deck UUID.
Existing uid-named personal-deck creation is unchanged. Card ids keep their
existing 1–81 character validation. Ownership and membership cannot be changed by clients.
These decks reuse the existing card validation. When an extra deck is selected,
the client creates its private deck document if absent and syncs its cards and
tombstones. The original German deck keeps the account's assigned path. Extra
deck schedules and preferences use the owner-only nested paths above. Names and
selection stay local; another client
needs that deck's ID in its local deck list to select it. The additive production
rules were deployed separately and verified on 2026-10-16; Pages never deploys
rules. See the [operating record](firebase-rollout-plan.md#current-operations--2026-10-17).

`firestore.rules` denies unauthenticated access and validates client shapes,
ownership, membership, and immutable account assignment. Rules do not govern
Admin SDK operations. The operator importer validates its own inputs and
project/credential pairing.

## Local commits and synchronization

IndexedDB version 3 adds one `decks` metadata row for the existing German deck,
without copying cards, changing schedules, or reseeding. Its id is the known
account assignment, otherwise `local-german`; learning the assignment replaces
that fallback row rather than adding another deck. `activeDeckId` lives only on
the local settings row and is omitted from public settings and Firestore writes.
Decks renders this stored row. IndexedDB version 4 stamps cards missing `deckId`
with that original deck id, preserving their content, schedules, and streak events.
Learning a cloud assignment also renames ownership on the original deck's cards
and tombstones. Local reads, review queues, counts, edits and sync projections
use the active deck; schedules remain on each card. Deletion clocks retain a
local deck-ownership map alongside `deletedIds`. Seed insertion always targets
the original deck, including when another deck is active. Decks can create empty
local decks and switch the active deck. The card editor and CSV import write to
that active deck. CSV duplicate matching uses the trimmed, case-insensitive
front/back pair within that deck, so another deck may contain the same pair.
Imports accept `de,en` or `front,back`, with optional `article`, `type`,
`example_de`/`example_front`, and `example_en`/`example_back` columns. Omitted
optional columns stay empty (article defaults to `none`); imported cards are due
immediately. Importing neither seeds cards nor changes another deck's schedule
or streak activity.

IndexedDB is the durable offline store. Every mutation commits data, its
local revision, and the affected records' pending markers atomically.
Firestore uses an in-memory cache, leaving the durable queue in IndexedDB.
IndexedDB version 5 copies the existing direction, session size, tier, and
word-type selection onto the original deck row. Every deck stores its own study
preferences; Review, Decks, and session selection read the active deck's values.
New local decks start at 20 cards, target→English (`de-en`), tier 3, and all word
types. The former boolean deck capability is named `supportsWordTypes` so
`wordTypes` can hold the selected classes. The account settings row remains a
mirror of the original deck's preferences for existing cloud sync and migration
formats. Extra-deck preference edits have their own settings clock and pending
marker; they do not change that mirror. Cloud merges update only the selected
deck's preferences and schedules. Each pass pulls only the active deck plus
account activity, and uploads that deck's pending records. Unstudied extra cards
do not create empty progress documents. Account activity remains shared across
decks; pending work in an inactive deck prevents account-wide acknowledgement.
The additive progress/settings rules are included in the separately verified
2026-10-16 production rules. Source or client publication alone never deploys rules.

Deck names can be renamed locally, including the original deck. Deleting a local
deck requires confirmation showing its name and card count, and atomically removes
its metadata, preferences, cards and owned pending/deletion records. Deleting the
active deck selects a remaining deck. The original deck has no delete control and
storage also refuses deletion of the original or last remaining deck. Deck deletion
retains account streak events and does not delete Firestore documents.

Decks also stores local Articles, Word types, and Tiers switches on each deck.
The original German deck enables all three; New deck disables all three.
Disabled extras hide their controls, editor fields, and study badges. Disabled
word types and tiers ignore the saved filters when building the review queue;
turning them back on restores those selections. Article switches never populate
or clear card articles. Hidden editor fields preserve existing card metadata,
and Gender is offered only when Articles is enabled and the card has an article.
These switches stay on this device and do not change cloud document formats.

Database connections close after operations and on `versionchange`;
blocked upgrades surface an actionable notice.

All foreground triggers share a serialized pull/merge/push loop. Sync runs
on launch, return to foreground, connectivity return, **Sync now**, and after
a debounced local change. Hiding or leaving the app pauses the timer; it
does not attempt a full background upload. There is no realtime listener or
background polling. Two clients kept visible may need **Sync now** to see
one another's latest work.

Each dirty record uses a server transaction to read, merge, and write only
when needed. Acknowledgement clears only the revision actually confirmed;
a newer local edit stays pending. Failed or rejected records remain pending,
and an unchanged sync does not rewrite every card. UID/session guards refuse
stale reads, writes, copies, or acknowledgements after an account change.

**Saved on this device** means work has committed locally and remains pending.
**Synced** means the account's pending records have been acknowledged by
Firestore. It does not mean an independent historical backup exists.

## Merge and deletion rules

Vocabulary, SRS progress, and settings have separate clocks, so a card edit
cannot undo a review and assembling a snapshot does not refresh settings.

- Content uses `updated_at` (falling back to `created_at`); equal clocks
  prefer the local value.
- Progress uses its own `updated_at`; equal clocks prefer the remote value.
- Settings use `settingsUpdatedAt`; equal clocks prefer local settings.
- Tombstones retain the greatest deletion time. Deleted built-in seed IDs
  remain deleted despite reseeding or stale content. A custom card can win
  over an older tombstone if its content clock is newer.

These are wall-clock decisions. Clock skew and simultaneous reviews of the
same card remain limitations; there is no review-event merge.

## Tab navigation

The primary tabs are Review, Decks, Cards, and Settings, in that order. Their
hash routes remain `#/`, `#/decks`, `#/deck`, and `#/settings`. A single-finger
horizontal swipe in the main content moves to the adjacent tab through normal
hash navigation, with no wrapping at either end. Swipes require at least 60 CSS
pixels and horizontal movement at least 1.5 times the vertical movement. Vertical
scrolling, form controls, cancelled gestures, and screens with hidden tabs do not
switch tabs. Mouse navigation remains click-only.

## Scheduling and recovery limits

The scheduler is SM-2-style: first Hard/Good = 1 day, second Good = 6 days,
first Easy = 4 days. Again and Gender requeue immediately, with a smaller ease
penalty for Gender. The account stores the latest SRS state per card, with
no interval multiplier, detailed review history, or FSRS.

Review saves the active deck's tier, word-type selection, and session size.
Its compact size row offers 10 / 20 / 30 / All and a Custom dialog in increments
of five. Done saves the choice; Cancel, Escape, and tapping outside discard it.
Previously saved sizes remain valid until changed. Decks saves review direction. Cards starts its browse tier filter at the saved
tier, but browsing does not write preferences. Settings retains account, install,
and SRS information. These control locations do not change storage or deck
assignment. Extra decks keep their own preferences and schedules; streak
activity remains account-wide.

An optional `selectedTiers` settings list stores exact tier buckets. When absent,
legacy `tier` expands cumulatively to preserve its previous scope. The scalar
remains the highest selected tier for older clients and Cards browsing. A newer
legacy settings write replaces an exact selection with its cumulative scope.
The additive field is validated in rules and preserved in sync, copy and backup/restore.

A review session starts from a captured queue within the selected exact
tier buckets and word-type filter. It uses only due cards when any match. When none
are due, it selects future cards in ascending due-time order and applies the
same session-size cap (All includes the whole eligible queue). Selecting cards
does not reschedule them; grading a review-ahead card uses the normal SRS and
progress-save path. Cards arriving from sync do not join that running session;
start a new session to include them.

### Hard mode

Review offers a Hard mode switch, off by default and remembered in this browser
(across decks/accounts, like appearance). It is captured when a session starts;
review direction, filters, session size and scheduling still use the active deck.
Hard mode replaces flipping and manual grades with an answer form. A correct
first answer saves Easy; another mistake offers one retry without revealing the
answer or writing progress/activity. A correct retry saves Good, an incorrect
retry saves Hard. A correct word with a recognized wrong-gender article saves
Gender immediately on either attempt and requeues through the existing scheduler.
The saved answer and automatic grade remain visible until Next card. A failed
save stays on the result with Retry saving and reuses the same activity ID.

Matching runs locally against the saved translation, with slash/semicolon-separated
alternatives accepted individually. Case, whitespace, apostrophe typography and
trailing sentence punctuation are normalized; accents and spelling are preserved.
There is no inferred synonym or fuzzy-spelling grading. Target-language nouns
require their article when the deck enables articles. Missing articles, number
errors and misspelled words are ordinary mistakes. Gender grading only applies
when answering into the target language; an elided French l’ cannot distinguish
gender in typed text. Typed attempts stay in memory and are never synced or logged;
only the existing SRS update and anonymous activity event are saved.

## Forgiving streaks

IndexedDB version 2 adds an `activity` store. A grade commits the schedule,
its UUID activity event and both pending markers in one transaction. Retrying
the same UUID does not reschedule or count again. Imports, seed writes and
ordinary card edits do not earn streak credit. Read-only legacy/recovery opens
keep the existing database version; the first write upgrades it without removing
cards or preferences. Older installed clients need the new build to write a
version-2 database.

Events store only `{ at, timeZone }`, with no card content or grade. Firestore
allows owner reads/creates/deletes and prohibits updates. Invalid external events
are skipped during pull and restore with aggregate counts; rules check timezone
format while the app checks that same format and validates the actual zone with
Intl. Before the first saved event fixes the profile zone, device `GMT` and zero
offsets become `UTC`; whole-hour offsets become equivalent `Etc/GMT` zones
(whose signs are inverted). Unsupported offsets are refused rather than changing
their calendar boundaries. Reads of stored activity and user-file imports repair
legacy raw whole-hour offsets and `GMT` to those canonical forms. Unsupported
stored zones are skipped with a once-per-event aggregate warning; local reads
atomically persist the repairs and remove skipped events and their pending marks.
Other event fields and cloud/restore validation remain strict. Sync pulls and unions
the account's activity and pushes pending UUIDs with create-or-identical-no-op
transactions. Different devices retain both events even when the SRS merge picks
one schedule. Conflicting payloads for a UUID are refused. Activity remains after
card deletion and survives confirmed device copies, user-file serialization,
private backup and isolated restore. It is separate from settings merge clocks.
The current full-account pull includes activity, so reads/storage grow with the
number of saved reviews; acknowledged activity pending marks are removed, while
events remain unless the owner explicitly deletes them.

Calendar days use a fixed profile zone chosen from the earliest tracked event;
UUID order breaks timestamp ties. Concurrent first studies in different zones
converge after sync to that same choice, and all events are grouped in that zone.
Travelling does not change it. Dates, rather than elapsed 24-hour intervals,
handle daylight-saving boundaries. Device clock accuracy remains an assumption.

The first day with at least 10 reviews activates the streak. Subsequent past-day
shortfalls accumulate, with today's first 10 reserved for today and excess
reducing older debt first. Surplus cannot prepay future days. Partial repairs
persist; clearing the debt restores the elapsed continuous streak including
repaired days. An unfinished current day is off, and becomes debt only on rollover.
The counter refreshes after grades/sync, on foreground and at a day boundary,
without rebuilding the captured review queue. It has no live announcements,
notification permissions, reminders or messages.

Legacy migration preserves card IDs, clocks, settings, progress, and
tombstones. The Admin completion marker verifies the imported snapshot;
device-only data and real second-device checks are separate evidence.
The [migration runbook](firebase-migration.md) explains the confirmed copy
and repeat-import behavior.

`npm run migrate -- backup` writes a private Firestore dump with a checksum.
Version 2 includes extra deck ownership/cards and nested per-deck settings and
progress, alongside the original German paths, activity and tombstones. The
restore accepts version-1 dumps too. The operator checkout was updated to this
code on 2026-10-17, after that day's successful scheduled backup. Verify a new
version-2 dump and isolated extra-deck restore before calling that coverage
qualified. The off-machine copy job succeeded that morning; job success and
restore qualification are separate evidence.
`npm run migrate -- restore` puts that dump back only onto an isolated
target, and only where the target is empty or already identical. It does not
restore Google Auth identities, IndexedDB, rules, or hosting. The frozen
legacy repository cannot back up reviews made later in Firebase. The procedure
and its limits are in [Firebase setup](firebase-setup.md#restore-a-firestore-dump).

## Deck selection during cloud sync

A cloud pass pins its study lock and selected deck ID. Cloud merges,
progress application, snapshots and acknowledgements check that scope against
`activeDeckId` inside their IndexedDB transaction. The in-memory generation
counter alone cannot detect another tab changing the shared selection. If the
selection no longer matches, the transaction aborts rather than applying cloud
cards or settings to a local deck. Snapshots already captured for the original
deck remain scoped to that deck; a later selection cannot change their contents.

Selecting either deck schedules its pending sync, including extra-deck content,
deletions, progress, and preferences. Card marks and queued acknowledgements carry the deck
ID, and an acknowledgement naming a different deck is refused. A rejected
extra-deck write remains pending there; returning to German still syncs its
independent queue. Account-wide revision acknowledgement checks every deck’s
cloud-eligible pending records atomically, so a clean selected deck cannot hide
unsynced work elsewhere from the status badge or sign-out warning. Extra-deck
progress and settings participate in that acknowledgement. The two-tab browser regression uses synthetic data and a
stubbed cloud transport to exercise the real cloud orchestration and IndexedDB;
it does not require an account or contact Firebase.

## Additional language starters

The optional French and Spanish built-ins reuse the private extra-deck paths and
legacy wire field names. Their deterministic per-account IDs and zero-clock
seed content preserve normal merges, user edits and seed tombstones; selection
and new-card insertion are atomic. Built-ins are protected from whole-deck deletion.
No database/schema migration is required. The article whitelist is additive and
requires a separate rules deployment before production sync. See
[starter-decks.md](starter-decks.md) for article/gender tokens, identity, seed-update
policy, content licensing, supported backups and device-local deck-list limits.

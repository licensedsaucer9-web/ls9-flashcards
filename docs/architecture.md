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
uses `VITE_REHEARSAL_PREVIEW=true`. Web
configuration is public; Admin SDK credentials belong only to local operator
commands.

Every app build embeds its package version, full Git source commit, dirty-source
flag, backend/project, base path, build mode and emulator flag. The same public
identity is emitted as `release.json` and precached by the service worker.
Settings reads the bundled identity without network access, so an installed
offline client reports the version it is actually running. A source change
alters the bundled identity and worker precache revision.
The worker serves the app shell only for app navigations. Other `*.html`
pages, such as the standalone `speech-test.html`, and the auth-spike paths go
to the network, and `speech-test.html` is not precached
(`npm run test:sw-navigation`).

Settings → Send feedback writes one create-only document to the top-level
`feedback` collection (message, optional email, app version, server time, and
the uid only when signed in). Device-only builds cannot send it. The draft stays
in memory across Settings re-renders and failed sends; offline or refused sends
say so inline. A slow send is not abandoned: the form stays locked and says it
is still sending until the queued write succeeds or fails, so a retry cannot
create a second document (`scripts/feedback-send-test.mjs`). See [Firebase setup](firebase-setup.md#app-feedback).

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
URL names are separate from data identity; see [the rename record](archive/rename.md).

Google Authentication uses browser-local persistence. Firebase UID selects
the account's IndexedDB database and Firestore ownership; a name or email
is only a label. Guest and legacy profile databases stay separate and are
not deleted or renamed on sign-in. Copying device data requires confirmation.
There is no in-app copy from a legacy per-user profile (`german-flashcards:<profile>`)
into an account; such a database stays on the device, unread.

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

Theme selection (Dark, Light, Halloween, Christmas, NeoPunk, Nature, Coffee, Dissonant, Cute Pink, Cuter Pink, Mint or Lavender) is stored in the browser’s localStorage under
the build’s storage prefix, independently of accounts, decks, and Firestore.
Startup restores it before rendering the app; missing or invalid choices use
the original Dark palette. If storage is blocked, switching still works for
the current page and Settings reports that it could not persist the choice.
Shared CSS color tokens cover screens, cards, controls, semantic article/grade
colors, shadows and dialogs; browser theme-color follows the active palette.
NeoPunk adds neon glow, uppercase headings with a glitch animation and a CRT
scanline layer painted behind the app (it never covers cards or takes pointer
events); with `prefers-reduced-motion: reduce` it keeps the static glow and
runs no animations or transitions. Coffee is a warm espresso/cream palette.
Dissonant is intentionally jarring (acid green, hot orange, magenta, muddy
purple, mismatched accents) yet keeps WCAG AA text contrast and has no motion.
Cute Pink, Cuter Pink, Mint and Lavender are light pastel palettes: soft backgrounds with
dark text, a deeper per-theme accent for primary and selected controls, and
control borders at 3:1; all text meets WCAG AA and there is no motion.
Cuter Pink uses a deeper, more saturated pink background than Cute Pink.

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
New local decks start at 20 cards, target→English (`de-en`), tier 4 (every tier), and all word
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
a debounced local change. Card, progress and activity writes carry a
server-assigned `syncedAt` (`serverTimestamp()`, enforced as `request.time`
by the rules, or left unchanged when an older client copies a document back).
Each deck row keeps a pull cursor for `uid/cloudId`: the newest `syncedAt` it
has merged. The first pull of a deck on a device reads every card, progress
record and review event. Later pulls read only documents with `syncedAt` after
the cursor; until one pull has re-read it, that query also reaches two minutes
behind the cursor. Card deletions are tombstone documents, so they arrive the
same way. Once a day (and while no pulled document has a `syncedAt` yet) a
full pull re-reads every card and progress record, so writes from clients
older than the cursor still arrive. Of the activity it reads the last 30 days
plus every event with `syncedAt` after the cursor, so an older review another
device uploaded late still arrives. The cursor is stored, and the pull counts
as recent for the light and foreground intervals below, only after both
merges applied; the cursor is removed with its deck. Settings are a single document and are read on every pull.

A pass after a local change (a *light* pass) skips the pull while one for that
deck finished less than five minutes ago and only pushes the dirty records;
each push reads and merges the record it writes in a transaction, so a stale
device cannot overwrite a newer record. Return to foreground and reconnect pull
at most every ten minutes. Launch, sign-in and **Sync now** always pull.
Another device's changes can therefore take up to ten minutes to appear without
**Sync now**. The account's deck assignment and each extra deck's creation
check are kept in memory once they succeed (both documents are immutable). An
exhausted Firestore quota (`resource-exhausted`) is not retried: the status
reads "Daily cloud limit reached, studying offline until it resets", changes
stay pending, and an account this device has opened before opens from its local
copy. Hiding or leaving the app pauses the timer; it
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

The scheduler (`src/srs.ts`, #132) is a hybrid: a short SM-2 ladder for the
first steps, then multiplicative growth by each card's ease. The account stores
only the latest `ease`, `interval` (days), `reps` and `due` per card, with no
interval multiplier, detailed review history, or FSRS.

- **New card:** Hard/Good = 1 day, Easy = 4 days. Second Good is at least 6 days,
  second Easy at least 8.
- **Later:** Good = interval × ease (at least one day longer); Easy = interval ×
  ease × 1.3 (at least one day longer than Good) and raises ease by 0.15; Hard =
  interval × 1.2 (holds or grows slightly) and lowers ease by 0.15. Ease stays
  within 1.3–10, so consecutive Easy grades always lengthen the interval, by
  more than 3× each time: 4 → 15 → 58 → 234 → 989 → 3650 days.
- **Ceiling:** new growth stops at 3650 days (ten years, `MAX_SCHEDULE_DAYS`),
  well under the server's 36,500. A longer interval stored by an older build is
  held by a passing grade, not shortened.
- **Lapses:** Again requeues now, lowers ease by 0.2 and keeps a quarter of the
  interval; Gender keeps half and lowers ease by 0.1. `reps` returns to 0, so the
  card is relearning: Good resumes the kept interval, Hard halves it, Easy
  multiplies it by 1.3, and growth continues from there. Repeated lapses wear
  the kept interval down to 0, which is a new card.
- **Early reviews** never lengthen an interval.
- There is no random fuzz, so cards graded alike on the same day stay together.

Why this method: it keeps the stored fields and Firestore rules unchanged, so
there is no migration and older clients keep working, and it is easy to test.
Pure SM-2 restarted a lapsed card at day one; a fixed ladder or Leitner boxes
ignore how hard each word is; FSRS has the best evidence base but needs new
per-card state, a rules change, a migration, fitted parameters and ideally a
review history that the app does not keep. Ease can still drift down after many
Hard grades ("ease hell"); only Easy raises it.

Existing schedules need no conversion: each card continues from its stored
interval and ease. Older clients write the same shape; one that reviews a
relearning card (interval above 0 with `reps` 0) treats it as new, which only
shortens that card's next interval.

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

There are four tiers (`TIERS` in `src/types.ts`). Tier 4 holds 250 German words
that are rarer than every tier 1-3 word; see [starter-decks.md](starter-decks.md#german-tier-4).
Rules, sync, copy, migration validation and guarded restore accept tier 4
on cards, in the `tier` scalar and in `selectedTiers` (one to four distinct tiers).
A card without a valid tier, such as one the user added, counts as tier 3, so a
scope saved before tier 4 existed keeps its own cards and does not grow: legacy
`tier: 3` and an exact `[1, 2, 3]` stay tiers 1-3, and tier 4 is opt-in. New
accounts still start on Tier 1; new local and extra decks default to tier 4.
Review hides the `T4` pill when the deck has no tier 4 cards (French and Spanish)
and it is not selected. Pre-tier-4 clients read a tier 4 setting as tier 1 and
ignore an exact selection that contains 4, so upgrade every device.

Tier pills read exactly `T<n>: <due>` (`tierPillLabel()` in `src/tiers.ts`), where the
number is the count of that tier's cards with `due <= now`, the same rule as the review
queue; on Cards, whose browse filter is cumulative, it is the cumulative due count. Each
pill's accessible name is `Tier <n>, <due> due` (`tierPillName()`). Presentation only.
Word-type pills read the type and its due count (`Nouns 5`), with the accessible name
`Nouns, 5 due`.

A review session starts from a captured queue within the selected exact
tier buckets and word-type filter. It uses only due cards when any match. When none
are due, it selects future cards in ascending due-time order and applies the
same session-size cap (All includes the whole eligible queue). Selecting cards
does not reschedule them; grading a review-ahead card uses the normal SRS and
progress-save path. Cards arriving from sync do not join that running session;
start a new session to include them.

### Speech

Settings offers a Speech switch, off by default and remembered in this browser
(`<prefix>.speech` in `localStorage`, like appearance; never synced). When it is
on and the browser has `speechSynthesis`, review shows a 🔊 “Speak word” button
for the visible face: the prompt before reveal and the answer after it (Hard
mode shows one on each). Deck language names map to BCP-47 tags (German `de-DE`,
Spanish `es-ES`, French `fr-FR`, Norwegian `nb-NO`, English `en-GB`); a voice
with the exact tag, then the same primary language, is chosen when listed,
otherwise the browser picks. Unknown languages leave the choice to the browser.
Without the API the button is hidden and the switch says speech is unavailable.
Speech is cancelled when the card changes or review is left.

A separate Speech input switch (`<prefix>.speech-input`, same rules: off by
default, this browser only, never synced) adds a 🎤 “Answer by voice” button
beside the Hard-mode answer field, only when the answer is in the target
language (`en-de`) and the browser has `SpeechRecognition` or
`webkitSpeechRecognition`. Otherwise the button is not rendered; without the
API the switch is disabled. The note says audio may go to Apple or Google
servers. A tap cancels speech output and starts one recognition in the deck's
target language (`src/speech-input.ts`); a second tap stops it. The transcript
fills the answer field for the learner to check and submit, so grading is the
typed path. Because Safari has no silence timeout and may stall, the app shows
“Starting…” until the engine starts (up to 8 s; up to 30 s while microphone
access still reads `prompt`, since Safari may keep that state after a grant
without a change event), ends a silent attempt after
7 s, accepts an interim result that stays unchanged for 1.5 s when no final
arrives, and stops any attempt after 15 s. Each finished attempt is aborted and
detached, so a late error (such as a muted `audio-capture`) cannot affect the
next one. Listening is aborted on repaint or card change, on leaving review and
when the tab is hidden. No audio or transcript is stored.

### Hard mode

Review offers a Hard mode switch, off by default and remembered in this browser
(across decks/accounts, like appearance). It is captured when a session starts;
review direction, filters, session size and scheduling still use the active deck.
Hard mode replaces flipping and manual grades with an answer form. A correct
first answer saves Easy; another mistake offers one retry without revealing the
answer or writing progress/activity. A correct retry saves Good, an incorrect
retry saves Again, so a forgotten card comes back now instead of later. A correct word with a recognized wrong-gender article saves
Gender immediately on either attempt and requeues through the existing scheduler.
The saved answer and automatic grade remain visible until Next card. A failed
save stays on the result with Retry saving and reuses the same activity ID.

Matching runs locally against the saved translation, with slash/semicolon-separated
alternatives accepted individually. Separators inside parenthetical glosses do not
create alternatives. Trailing glosses such as “teacher (m)” may be omitted.
Case, whitespace, apostrophe typography and
sentence punctuation anywhere in the answer ("a beer please" matches "A beer, please.") are
normalized, and the German ß and umlauts are interchangeable with their ss/ae/oe/ue spellings;
other accents and spelling are preserved.
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
ordinary card edits do not earn streak credit. Read-only opens
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
Only a device's first pull reads all activity; incremental pulls read new
events and the daily full pull the last 30 days plus new events, so storage, not routine reads,
grows with the number of saved reviews. Acknowledged activity pending marks are removed, while
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

## Copying a signed-out device into an account

After sign-in, "Copy" moves the device's decks into the account, in two kinds:

- **German deck → German deck.** Progress and settings, plus word-list edits and
  deletions in vocabulary mode. The pairing is original deck to original deck,
  whichever deck is open on the device or in the account.
- **French and Spanish starters → the account's own starter deck of that language.**
  Starter IDs are derived from the owner, so the account's ID differs from the
  device's; the deck is created with its seed cards when the account lacks it.
  Reviewed cards bring their schedules; vocabulary mode also brings edits, added
  cards and deletions (deletions are owned by the account's starter deck), and the
  deck's preferences when the account has none or the device's are newer. A card the
  device never studied never overwrites the account's progress on it. Seed cards
  whose schedule equals the seed's upload no progress record.

Decks created by hand are not copied. The open deck never changes, and every pending
mark the copy creates carries its deck's ID so a sync of another open deck cannot pick
it up. `scripts/guest-copy-ui-test.mjs` covers a device that was studying French, with
a Spanish deck, copied into accounts with no, French and Spanish decks in both modes (#109).

## Limits the server enforces

`firestore.rules` rejects a card whose first word or translation is over 200 characters,
an example over 1000, more than 12 tags, or a schedule with an interval over 36,500 days
or ease over 10. A rejected record stays pending forever, so the client keeps within the
same numbers (`src/limits.ts`; `scripts/limits-test.mjs` compares them with the rules text,
and the emulator suite checks both sides of each boundary):

- **Schedules.** `review()` starts from a schedule clamped to the caps and never exceeds
  them. Reviewing ahead of schedule never lengthens an interval, so a small deck that keeps
  offering not-yet-due cards cannot inflate them. A schedule saved past the caps by an older
  build is repaired when it is uploaded and by its next review.
- **Editor and CSV import.** The fields carry `maxlength`, the save re-checks pasted text, and
  a CSV row over a limit is reported by line instead of creating a card that can never sync.
- **Hard mode.** Missing a card twice saves Again, not Hard: Hard lengthens a learned card's
  interval.
- **Rejections.** When a card is rejected anyway (for example one saved before these limits),
  the status names the card and says what to fix; saving an edit queues it again. The rest of
  the queue keeps syncing past it. Settings → Account lists every refused record under
  **Needs fixing**, with a link to edit a card and **Keep on this device only**, which
  acknowledges just the refused revision so the account can report synced again; that change
  then never reaches other devices, and a later edit is queued as usual. The list is rebuilt
  by each pass that reaches the queue and cleared on a deck switch. While records are listed,
  the sign-out confirmation offers the list instead of Sync now, which cannot clear them.

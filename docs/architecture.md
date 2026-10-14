# Architecture and data guarantees

This describes the implementation as of 2026-10-11 (including the unreleased #58 implementation).
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
GitHub data transport; the previous published build still has its old writer.

## Firestore layout

| Path | Contents and access |
| --- | --- |
| `users/{uid}` | Owner-readable account metadata, deck assignment, schema version, migration status. |
| `users/{uid}/settings/current` | Owner-only direction, session size, tier, and settings clock. |
| `users/{uid}/progress/{cardId}` | Owner-only SRS state and its clock. |
| `users/{uid}/activity/{eventId}` | Owner-only saved-review timestamp and time zone, keyed by UUID; payload immutable, owner deletion allowed. |
| `decks/{deckId}` | Explicit deck membership. Clients cannot alter membership or assign themselves to a legacy deck. |
| `decks/{deckId}/cards/{cardId}` | Vocabulary, content clock, optional rank/tier, and deletion tombstone; deck members can edit. |

`firestore.rules` denies unauthenticated access and validates client shapes,
ownership, membership, and immutable account assignment. Rules do not govern
Admin SDK operations. The operator importer validates its own inputs and
project/credential pairing.

## Local commits and synchronization

IndexedDB is the durable offline store. Every mutation commits data, its
local revision, and the affected records' pending markers atomically.
Firestore uses an in-memory cache, leaving the durable queue in IndexedDB.
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

## Scheduling and recovery limits

The scheduler is SM-2-style: first Hard/Good = 1 day, second Good = 6 days,
first Easy = 4 days. Again and Gender requeue immediately, with a smaller ease
penalty for Gender. The account stores the latest SRS state per card, with
no interval multiplier, detailed review history, or FSRS.

Decks saves the account-wide tier, direction, and word-type preferences.
Review alone sets session size. Cards starts its browse tier filter at the saved
tier, but browsing does not write preferences. Settings retains account, install,
and SRS information. These control locations do not change storage or deck
assignment.

A review session starts from a captured queue within the selected cumulative
tier and word-type filter. It uses only due cards when any match. When none
are due, it selects future cards in ascending due-time order and applies the
same session-size cap (All includes the whole eligible queue). Selecting cards
does not reschedule them; grading a review-ahead card uses the normal SRS and
progress-save path. Cards arriving from sync do not join that running session;
start a new session to include them.

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
`npm run migrate -- restore` puts that dump back only onto an isolated
target, and only where the target is empty or already identical. It does not
restore Google Auth identities, IndexedDB, rules, or hosting. The frozen
legacy repository cannot back up reviews made later in Firebase. The procedure
and its limits are in [Firebase setup](firebase-setup.md#restore-a-firestore-dump).

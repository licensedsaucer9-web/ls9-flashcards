# Firebase migration plan

Status: proposed implementation plan; no application or infrastructure changes yet.
Written 2026-09-29 against source commit `9a6f47b`.

## Outcome and scope

Replace browser-held GitHub tokens and repository-backed sync with Firebase
Authentication and Cloud Firestore. A new user opens the app, chooses
**Continue with Google**, and can study immediately. Account provisioning and
initial data setup happen automatically; Joakim does not issue tokens, grant
repository access, or configure individual new users.

Preserve the current German deck, tiers, SM-2 scheduling, review controls,
card editing/deletion, CSV import/export, settings, offline study, and PWA
installation. Existing progress must survive the migration.

Out of scope: repository/product renaming, other subjects or languages, new
study features, algorithm changes, review history, public deck sharing,
invitations, subscriptions, native iOS implementation, and a UI rewrite.
Google is the only initial login provider. Apple login and native account
deletion requirements belong to a future iOS release, not this migration.

## Current implementation

- `src/github.ts` stores a PAT in localStorage and reads/writes a shared
  `data.json` plus `users/<profile>.json` in the private data repository.
- `src/user.ts` uses freely selectable profile names, not authenticated identity.
  Each profile has a separate `german-flashcards:<name>` IndexedDB database.
- `src/db.ts` persists changes before upload, tracks local/acknowledged
  revisions, and retains deletion tombstones. Keep these guarantees.
- `src/sync.ts` serializes pull/merge/push passes and retries GitHub SHA
  conflicts. `src/merge.ts` merges content, schedules, and settings separately.
- `src/main.ts` owns onboarding, profile selection, GitHub settings, and
  foreground retry. These are the main UI integration points.
- `.github/workflows/pages.yml` tests and publishes pushes to `master` to
  `german-flashcards-site`. Keep the current public URL and deployment path
  unless the authentication feasibility check below proves a move necessary.

## Target design

### Identity and onboarding

Use the modular Firebase web SDK, Google authentication, and persistent sessions.
Use Firebase UID as the ownership key everywhere; display names and email
addresses are labels, never authorization or automatic legacy-profile claims.

On a clean installation, show a short welcome screen and Continue with Google.
After successful login, initialize the account idempotently, load the existing
built-in deck, and open the study screen with existing defaults. There is no
profile-name form, repository form, manual sync requirement, or approval step.
A second device using the same login restores that account's state automatically.

Keep the existing local-only study path available without creating an anonymous
Firebase account. If a guest later signs in, offer to bring that device's local
progress into the selected account; do not silently upload another person's
local data. Cancellation or login failure must leave local work intact.

Replace unrestricted cloud profile discovery/switching with account sign-out
and sign-in. Existing local profiles remain available for migration, not as a
way to bypass another account's login. Settings show the current account,
sync status, Sync now, and Sign out. On sign-out with pending work, explain
that it remains on this device for that account and offer retry or sign-out;
never discard it or send it under the next login.

### Hosting and the iPhone login check

First prove Google login on the current GitHub Pages URL, including Safari and
an installed iPhone Home Screen PWA. Try user-initiated `signInWithPopup`,
which Firebase documents as an alternative to cross-origin redirect login.
Test popup cancellation/blocking, session restoration, and returning to the
installed app. Emulator tests cannot establish that real OAuth works on iOS.

Do not blindly fall back to `signInWithRedirect`: Safari's third-party storage
restrictions require a supported hosting/auth-domain arrangement. GitHub Pages
cannot provide a reverse proxy for Firebase's auth helper. If the popup path
cannot meet smooth onboarding, resolve this before implementing the migration:
use Firebase Hosting with a matching auth domain and plan a separate URL/PWA
transition. A new origin cannot read the old origin's IndexedDB; a bridge
release on the old URL must sync existing local work before users move.
Do not ask users to disable browser privacy protections.

See [Firebase redirect guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices).

### Data and access boundaries

Preserve the shared vocabulary behavior for the existing users of the private
data repository. Import that vocabulary into one private legacy deck whose
members are assigned by the migration tool. Their progress stays private per
account. New unrelated users receive their own deck automatically, initialized
from the bundled seed; editing it must not change the legacy group's vocabulary.
There is no new sharing or deck-management UI, and each account uses one deck.

Suggested Firestore layout:

| Path | Purpose and access |
| --- | --- |
| `users/{uid}` | Account metadata, assigned deck ID, schema version, migration status; readable only by its owner. |
| `users/{uid}/settings/current` | Existing direction, session size, tier, and settings clock. |
| `users/{uid}/progress/{cardId}` | Existing SRS state and its clock; owner only. |
| `decks/{deckId}` | Deck metadata and explicit member UIDs; accessible only to members. |
| `decks/{deckId}/cards/{cardId}` | Vocabulary plus deletion tombstone, separate from SRS state; members can edit. |

Use a deterministic personal deck ID derived from UID for automatic first-login
creation. Rules allow an account to create only its own personal deck with
itself as sole member. Membership changes and legacy deck assignments are
admin-only. Client changes to account metadata cannot reassign deck ownership
or forge migration completion. Creation must tolerate concurrent first logins
and retry after interruption without resetting existing records.

Keep stable card IDs and all current content/SRS fields. Represent deletions
durably so stale devices cannot resurrect cards. Do not put an entire growing
deck or all progress in one document: Firestore has a 1 MiB document limit.
Bundled seeds can initialize local data, but remote tombstones and existing
account data must be reconciled before treating defaults as uploadable changes.

Firestore rules default to deny. Test ownership, membership, schema/types,
immutable identifiers, and bounded strings/arrays. Unauthenticated clients
cannot access cloud data; users cannot list accounts or access another user's
progress, even when they share a deck. Firebase web configuration is public
configuration, not a secret or a substitute for rules. Never ship Admin SDK
credentials in the app. See [API key guidance](https://firebase.google.com/docs/projects/api-keys)
and [Firestore limits](https://firebase.google.com/docs/firestore/quotas).

### Local persistence and sync

Retain IndexedDB as the durable offline store for this migration. Use
UID-scoped databases distinct from the legacy name-scoped databases and guest
storage. Do not rename or delete old databases in place. Close connections on
`versionchange` and surface blocked upgrades instead of hanging.

Use Firestore with an in-memory cache initially, avoiding a second persistent
offline queue alongside the app's existing storage. Extend local revision
tracking with durable per-record dirty state where needed. A local edit and
its pending marker must commit in the same IndexedDB transaction.

Replace the GitHub transport with a Firestore adapter while retaining the
serialized foreground sync loop. For each dirty record, use an online
Firestore transaction to read current server state, merge, and conditionally
write. Transaction callbacks must be pure because Firebase retries them.
Transactions fail offline; the local queue remains pending until connectivity
returns. A stale offline snapshot must not overwrite newer server state simply
because it reconnects last. See [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions).

Preserve current content/SRS/settings clock semantics and seed tombstones.
Document and test equal-timestamp behavior; avoid endless writes when merge
results are unchanged. Device-clock skew and simultaneous reviews of the same
card remain existing limitations; do not add event sourcing or change SM-2.

Pull on launch, foreground, connectivity return, and Sync now; debounce uploads
after local changes. Start with bounded collection reads appropriate to this
small deck, measure request counts, and upload only changed records. Do not
rewrite the full deck after each review or add background polling. Break large
imports into resumable chunks within transaction and rule limits.

Acknowledge only the exact local revisions confirmed by the server. Partial
success, interrupted imports, auth expiry, permission errors, or quota failures
leave unconfirmed changes pending. Prefer **Saved on this device / Syncing /
Synced** wording: synchronization is not an independent historical backup.

Bind every operation to the captured UID, deck ID, and session generation.
On account change, stop scheduling and discard stale completions before they
can merge into or acknowledge a different account's database. Handle account
changes across tabs. Previously signed-in users can study cached cards offline;
first-time cloud sign-in requires connectivity. Explicitly signed-out accounts'
cached data must not appear in another account or the guest view.

## Implementation sequence

Each step should be a reviewable change with its own acceptance checks. Keep
unfinished Firebase paths disabled in production until the rollout step.

1. **Verify login and create configuration.** Set up one production Firebase
   project, Google provider, Firestore in a deliberately selected European
   region, and authorized domains. Start with the free plan if its limits fit.
   Use emulators for automated tests and an isolated test project for real OAuth.
   Complete the iPhone login/hosting check before dependent work. Record console
   setup, public build variables, and provider consent configuration in a setup
   guide; no real credentials in the repository.
2. **Add schema, rules, and transport tests.** Add `firebase.json`, rules,
   required indexes, emulator configuration, and adapters mapping current types
   to documents. Test automatic account/deck creation and private legacy deck
   membership. Do not deploy permissive development rules to production.
3. **Implement account isolation and onboarding.** Add auth initialization,
   UID-scoped local storage, welcome/account settings UI, and lifecycle guards.
   Preserve guest/local data. A fresh login and a returning login must not
   overwrite existing settings with defaults. Remove reliance on profile names
   for cloud identity.
4. **Implement Firestore sync.** Add per-record dirty tracking, transactional
   merges, retries, server acknowledgements, and neutral status text. Verify
   offline/reopen/reconnect and concurrent device behavior before migration.
5. **Implement and rehearse migration.** Build the admin importer and local
   copy path described below. Run against fixtures and the test project first;
   report record-level comparisons rather than just successful API calls.
6. **Pilot, cut over, and remove GitHub sync.** Migrate existing owners, verify
   a new user and a second device, then enable Firebase in the public build.
   Update README, TEST.md, and deployment instructions. After verification,
   remove the PAT/repository UI and active GitHub transport, clear saved PATs
   on upgraded devices, and revoke the old data-write token. Preserve GitHub
   Actions deployment credentials: they serve a different purpose.

## Existing-data migration and recovery

- Take a private, timestamped export of the shared deck and every profile file,
  recording the source commit. Include v1 snapshots via the existing legacy
  parser. Keep real exports and the UID mapping outside source/public artifacts.
- Existing owners sign in once. Joakim explicitly maps each legacy profile to
  its authenticated UID using a one-time admin command and reviewed mapping
  file. This administration is for existing data only, not future onboarding.
  Never allow anyone to claim `joakim` or another profile by typing its name.
- Import the shared deck once and each owner's progress/settings separately.
  The importer needs dry-run, validation, resumability, and idempotent merge
  behavior. A rerun must not reset newer Firebase work or duplicate cards.
- Copy outstanding local changes into the matching UID database only after
  checking the migration mapping and explicitly confirming that local profile.
  Preserve original databases and include clocks, custom cards, tombstones,
  settings, and unacknowledged reviews. Do this for every previously used device;
  a remote export alone cannot contain work that never reached GitHub.
- Verify card/progress counts and exact SRS/settings values, then read back from
  the server and restore on a clean second device. Mark migration complete only
  after verification; show actionable retry state for interrupted attempts.
- Avoid dual writing. During pilot, each migrated account uses Firebase only.
  Coordinate a short pause in legacy shared-deck editing for the final import;
  check for GitHub changes since the recorded source commit before freezing it.
  Old installed builds may survive a rollout, so revoke legacy write access
  after collecting pending work and confirming the new build on known devices.
- Retain the old repository as a recovery snapshot. Document a private Firebase
  export/restore command and rehearse it; a frozen GitHub snapshot is not a
  backup of subsequent Firebase changes. Select a low-effort backup cadence
  before declaring the migration finished, documenting any billing requirement.
- Roll back UI with a previous Firebase-compatible build, retaining schema and
  local data. Do not simply redeploy the old GitHub writer once users have new
  Firebase progress. Returning to GitHub would require a fresh export and merge
  of that progress; until then preserve local work and pause cloud writes.

## Validation and release criteria

Keep existing SRS/CSV, tier, merge, build, artifact, and installability checks.
Replace GitHub-specific browser sync tests with Firebase coverage; retain legacy
fixtures for migration. CI runs Auth/Firestore emulators and needs no live user
token. Use [Firebase's rules testing tools](https://firebase.google.com/docs/firestore/security/test-rules-emulator).

Required cases:

- A new Google user reaches study without operator intervention and can resume
  on a second device with the same settings and progress.
- Two accounts cannot read/write each other's progress or personal deck, guess
  membership, forge owner fields, or list other accounts. Legacy members share
  vocabulary edits but cannot read each other's schedules.
- Offline review, immediate app suspension, offline reopen, and eventual sync
  preserve changes. An expired login does not erase local progress.
- Concurrent edits to different cards survive; same-card conflicts follow the
  documented merge rules. Card edits do not reset SRS; reviews do not overwrite
  settings; tombstones survive seeding and stale-device reconnection.
- A write during sync, a transaction retry, partial import, quota/permission
  failure, and restart before acknowledgement never produce a false Synced state.
- Sign-out/account switch during reads, writes, and another tab's session change
  cannot expose data or acknowledge changes for the wrong user.
- Legacy v1/v2 imports, multiple local profiles, repeat migration, and unsynced
  local work preserve values and cannot claim another owner's data.
- Real Google login works on desktop, iPhone Safari, and the installed Home
  Screen app. Test cancellation, blocked popup handling, relaunch, airplane
  mode, logout/login, and restoration on another device.
- Public artifacts contain no PAT, service-account credentials, private exports,
  or legacy-profile mapping. Rules and production config are deployed before
  the Firebase-enabled client. Pull requests never deploy production resources.

Completion means existing owners have verified their progress, a fresh user can
join solely by receiving the URL, offline study still works, and routine use has
no dependency on the private GitHub data repository. No new study functionality
is part of the release.

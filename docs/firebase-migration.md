# Rehearse the legacy migration (#14)

Pages builds a Firebase client into `dist-firebase` and does not publish it.
These importer commands stay local operator tools, never a Cloud Function or a
production CI step. Use the OAuth test project first. The checklist in section
5 is still open. Passing synthetic emulator tests does not record that human
rehearsal as done, and it does not enable the published site. A private
Firestore backup command is in [firebase-setup.md](firebase-setup.md).

Rollback before any Firebase study is leaving the previous `master` build
published. After Firebase progress exists, publish a Firebase build only. This
repo no longer contains `src/github.ts`, so a new build cannot write the data
repo.

## 1. Prepare private inputs

Use Node 22 or newer and `npm ci`. Create `~/.config/german-flashcards/` with
mode 700. Put the downloaded Admin SDK service account JSON there, with mode
600. For the test rehearsal name it `service-account-auth-test.json`.
Credentials are loaded using the [Admin SDK service-account setup](https://firebase.google.com/docs/admin/setup#initialize_the_sdk).
The credential's project must match the mapping. The tool does not fall back
to ambient credentials for a live import.

Joakim writes `~/.config/german-flashcards/migration-map-auth-test.json` by hand
after confirming each authenticated UID. Use the UID for the **test project**,
which differs from the production UID. This example contains placeholders:

```json
{
  "version": 1,
  "projectId": "flashcards-ls9-auth-test",
  "deckId": "legacy-german",
  "profiles": {
    "joakim": "REPLACE_WITH_CONFIRMED_TEST_UID"
  },
  "v1Profile": "joakim"
}
```

`v1Profile` explicitly identifies the owner of a v1 snapshot's embedded
progress; it can be omitted for a v2 deck. When a v1 snapshot and that user's
v2 file both exist, their schedules and settings merge on their own clocks.
Each mapped profile must have source data. Unmapped files and guests are
reported as skipped. UIDs must be unique, and the shared deck ID must differ
from personal UIDs. A profile name entered in the app cannot assign an account
or claim remote progress.

Use a separate mapping and service account for production. Keep both files,
exports, and command output outside Git repositories. The mapping file is
also used for the explicitly confirmed copy on each device; it is not embedded
in a build or saved to localStorage.

## 2. Export an immutable GitHub snapshot

Update the private data clone before choosing the source commit. Export reads
`data.json` and `users/*.json` at that exact commit, including a v1 `data.json`
if present. It ignores uncommitted working files and leaves the data repo intact.

```bash
npm run migrate -- export \
  --repo /home/joakim/src/german-flashcards-data \
  --commit HEAD \
  --out "$HOME/.config/german-flashcards/exports/2026-09-30-rehearsal.json"
```

The private export records the full commit, export time, and SHA-256 checksum.
Record the printed commit for #15's final GitHub recheck. Existing export files
are never overwritten; choose a fresh dated filename for a later snapshot.
Exports are created with mode 600. Input and output paths inside Git repositories
(including symlinks into them) are refused.

## 3. Dry-run, import, read back, and resume

```bash
npm run migrate -- import \
  --export "$HOME/.config/german-flashcards/exports/2026-09-30-rehearsal.json" \
  --mapping "$HOME/.config/german-flashcards/migration-map-auth-test.json" \
  --credential service-account-auth-test.json
```

This defaults to a dry-run: it reads the selected project's existing records
and prints each source, before value, planned after value, path, and write/no-op
decision. No writes occur, including account provisioning. It also reports
source/server card and progress counts and skipped profiles. Validation fails
before opening the network client if the export or mapping is invalid.
The output contains private vocabulary and progress; save it only to a private
file outside the repo if a report is needed.

After inspecting the differences, repeat with `--apply`. The importer:

1. Preassigns the shared deck and its exact mapped membership, and creates each
   `users/{uid}` with `migrationStatus: pending`. A conflicting existing personal
   deck/account is refused, so run this before the legacy owner's first app login.
2. Imports vocabulary once into that deck and progress/settings separately per UID.
   Each transaction re-reads the server before merging. It uses the #13 content,
   SRS, settings, and tombstone rules; newer Firebase records survive a rerun.
3. Reads every imported record back, compares exact committed fields and clocks
   against the source/merge result, and verifies source IDs and collection counts.
   A server record that advanced during verification is retained and reported.
4. Marks accounts `complete` only after successful verification. Any interrupted
   write or failed readback leaves the affected import pending. Run the same
   command to resume; verified no-op repeats say `already imported` without writes.

No local resume file is needed: committed records and the recorded source
fingerprint are the checkpoints. Do not change the mapping while resuming.
An Admin `complete` marker verifies the snapshot import; human second-device
verification and collection of every device's local work are separate steps.

## 4. Recover each device's unsynced local profile

Use a Firebase-enabled preview **on the same browser origin and storage context
as the old app**. A localhost preview cannot read an iPhone's existing IndexedDB.
Check Safari and the installed Home Screen app separately when both were used.
Deploy the restrictive rules to the test project before using real OAuth there.

Sign in as the already mapped account. Shared legacy accounts do not run the
generic first-login guest copy. In Settings:

1. Open **Recover a legacy profile on this device**.
2. Choose the reviewed mapping JSON from private device storage. The project must
   match this build; only registered local profiles mapped to this signed-in UID
   are offered. Guests and unmapped profiles are skipped.
3. Check the confirmation that the named profile belongs to this account, then
   select **Copy local progress and vocabulary**. The server's preassigned deck
   must also match the mapping. This action never changes account ownership.
4. Check the normal sync status. An offline copy says **Saved on this device**;
   reopen/reconnect or use **Sync now**. **Synced** means the copied records have
   been acknowledged by Firestore.

The source database stays unchanged. Content, schedules, settings, custom cards,
and tombstones merge with the UID database. Newer account reviews/settings win
over older source values. Source clocks remain intact. The target revision is
at least the source revision plus one; copied records get Firestore dirty markers
in the same IndexedDB transaction. GitHub acknowledgements are not treated as
Firestore acknowledgements, including rows from before per-record tracking.
Repeating a copy preserves acknowledged markers and newer account data. Account
changes before the write refuse the copy.

## 5. Record the real rehearsal before #15

- [ ] Record the private export's commit and reviewed test-project UID mapping.
- [ ] Inspect the dry-run's record differences and apply to the isolated test project.
- [ ] Verify imported counts, exact SRS/settings values, and seed tombstones in readback.
- [ ] Copy pending local work on every previously used device/storage context.
- [ ] Open a clean second client as Joakim. Confirm the same card schedules,
      direction, session size, tier, custom words, and deletions through #13 sync.
- [ ] Make a newer review on that client and repeat the importer. Confirm it
      reports `already imported` and preserves the newer review.
- [ ] Record the human check's device, date, commit, and result privately and on
      the cutover issue without posting private data or UID mapping files.

The production rehearsal waits for the separately confirmed production mapping.
The public site keeps the previous build until this checklist is recorded on
issue #15. The Pages publish steps do not run; they copy `dist-firebase` only
after that record, and a flag-off `dist/` must not be published in its place.
Collect any remaining local work with the Settings copy, then revoke the
data-repo write token only after those devices are on the published Firebase
build. Leave `german-flashcards-data` as a frozen snapshot.

## Automated checks

`npm test` includes synthetic v1/v2 files, two profiles, unmapped names,
strict validation, record-level dry-run, exact readback, interrupted/resumed
imports, no-op repeats, newer server data, and immutable/private export checks.
It calls no production service.

`npm run test:rules` needs Java 21. It also imports synthetic records using the
Admin SDK into `demo-german-flashcards`, then restores them in clean Chromium
contexts using the full #13 sync path. It checks schedule isolation, seed
tombstones, the confirmed Settings copy, source preservation, dirty-marker
backfill, retries, and account/deck guards. It uses no service account file.
The live operator command is never invoked by CI.

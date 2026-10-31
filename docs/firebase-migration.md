# Legacy migration and device recovery runbook

The test snapshot import (#24) and real second-device rehearsal (#25) passed
on 2026-10-04. Production Firebase was published on 2026-10-07 with legacy
studied-data import and old-device recovery waived by the owner. The old Pages
URL was retired on 2026-10-17. The procedures below are retained for explicitly
authorized future recovery and isolated rehearsals, not pending release steps.
See current operations in the [single rollout plan](firebase-rollout-plan.md).
Use [the saved import record](archive/issue-24-status.md) and
[the final second-device result](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235)
when reviewing completed work; do not rerun `--apply` just to inspect evidence.

These are local operator commands, never a Cloud Function or production CI
step. Rehearse live operations only against `flashcards-ls9-auth-test`.
Production commands require authorization for the concrete operation. Pages
publishes `dist-firebase` after CI on master; pull requests do not publish.
Firestore backup
and the guarded dump restore, including what a dump does not recover, are in
[Firebase setup](firebase-setup.md). Restore refuses the production project
and the real-data rehearsal project.

Production Firebase progress now exists, so rollback uses a Firebase-compatible
client while retaining that data. Current source and the public app have no
GitHub writer. Historical pre-Firebase rollback procedures are not a live route.

## 1. Prepare private inputs

Use Node 22 or newer and `npm ci`. Create `~/.config/german-flashcards/` with
mode 700. Put the downloaded Admin SDK service account JSON there, with mode
600. For the test rehearsal name it `service-account-auth-test.json`.
Credentials are loaded using the [Admin SDK service-account setup](https://firebase.google.com/docs/admin/setup#initialize_the_sdk).
The credential's project must match the mapping. The tool does not fall back
to ambient credentials for a live import.

If your home directory is a Git repository, that default location is refused
even when its files are ignored. Choose a private directory outside all Git
repositories and set `GERMAN_FLASHCARDS_PRIVATE_DIR`; it controls the default
mapping location and credential root. Create that directory with mode 700.
A directory under `/var/tmp` can serve as a rehearsal workspace; keep long-term
production backups in durable private storage outside Git.

```bash
export GERMAN_FLASHCARDS_PRIVATE_DIR=/path/outside/git/german-flashcards
MIGRATION_DIR="${GERMAN_FLASHCARDS_PRIVATE_DIR:-$HOME/.config/german-flashcards}"
umask 077
mkdir -p "$MIGRATION_DIR"
chmod 700 "$MIGRATION_DIR"
```

The commands below use `MIGRATION_DIR`. If the default location is outside Git
on your machine, leave the override unset and define `MIGRATION_DIR` using the
second line. Place the reviewed mapping, credential, and exports under that
directory. Credentials must stay within that directory even with the override.

Joakim prepares `migration-map-auth-test.json` in that private directory
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

Fetch `origin main` in the private data clone before choosing the source commit;
resolve `origin/main` to its full SHA and pass that SHA, rather than a stale
local `HEAD`. Export reads
`data.json` and `users/*.json` at that exact commit, including a v1 `data.json`
if present. It ignores uncommitted working files and leaves the data repo intact.

```bash
git -C /home/joakim/src/german-flashcards-data fetch origin main
SOURCE_COMMIT=$(git -C /home/joakim/src/german-flashcards-data rev-parse origin/main)
npm run migrate -- export \
  --repo /home/joakim/src/german-flashcards-data \
  --commit "$SOURCE_COMMIT" \
  --out "$MIGRATION_DIR/exports/REPLACE_WITH_TIMESTAMP-rehearsal.json"
```

The private export records the full commit, export time, and SHA-256 checksum.
Record the printed commit for the final production GitHub recheck. Existing export files
are never overwritten; choose a fresh dated filename for a later snapshot.
Exports are created with mode 600. Input and output paths inside Git repositories
(including symlinks into them) are refused.

### Prepare the offline comparison baseline

The confirmed test-project UID is recorded in issue #10. Preparing its mapping
can use that recorded sign-in evidence; do not substitute the production UID.
Keep the confirmation source and private artifact locations in a private
rehearsal record. The actual source snapshot stays intact as a separate file.

```bash
npm run migrate -- baseline \
  --export "$MIGRATION_DIR/exports/REPLACE_WITH_TIMESTAMP-rehearsal.json" \
  --mapping "$MIGRATION_DIR/migration-map-auth-test.json" \
  --out "$MIGRATION_DIR/exports/REPLACE_WITH_TIMESTAMP-baseline.json"
```

This command works offline with no Admin credential. It checks the export
checksum and validates the mapping and source before writing a mode-600 file
outside Git. Existing output files are never overwritten. Standard output
contains only paths, checksums, the source commit, and aggregate counts.

The private baseline binds to the export checksum and migration fingerprint.
It includes validated v1/v2 files with exact card/progress IDs, SRS and content
clocks, settings, and tombstones, plus expected Firestore documents using the
importer's empty-server merge rules. Missing progress/settings clocks become
zero in those documents; the parser supplies tier 1 when absent. V1 settings
retain their legacy settings clock or snapshot clock. Winning tombstones use
the importer's deleted-document representation. Later live readback must use
the reviewed merge result for any newer server records, rather than overwriting
them with this baseline.

Record the source commit, aggregate counts, mapping confirmation status, and
baseline validation result for each new migration. Keep exact values, mapping
files, and actual artifact locations private. No Firebase write or preview
deployment is needed for this preparation. The #22 test baseline is already
recorded; production needs a fresh snapshot and its own confirmed mapping.

## 3. Dry-run, import, read back, and resume

```bash
npm run migrate -- import \
  --export "$MIGRATION_DIR/exports/REPLACE_WITH_TIMESTAMP-rehearsal.json" \
  --mapping "$MIGRATION_DIR/migration-map-auth-test.json" \
  --credential service-account-auth-test.json \
  > "$MIGRATION_DIR/exports/REPLACE_WITH_TIMESTAMP-dry-run.log"
```

This defaults to a dry-run: it reads the selected project's existing records
and prints each source, before value, planned after value, path, and write/no-op
decision. No writes occur, including account provisioning. It also reports
source/server card and progress counts and skipped profiles. Validation fails
before opening the network client if the export or mapping is invalid.
The output contains private vocabulary and progress; save it only to a private
file outside the repo if a report is needed.

After inspecting the private differences, repeat with `--apply` only as part
of the authorized import, saving output to a fresh private log. The importer:

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

## 4. Device recovery (retired)

Legacy device recovery was waived for the 2026-10-07 release. On 2026-10-17
the owner retired the old Pages URL and archived its repository. See the
[retirement record](archive/rename.md#old-site-retirement-2026-10-17).

The app no longer contains a device recovery path (#163). The Settings panel
**Recover a legacy profile on this device**, its mapped-profile copy, and the
unpublished old-scope recovery bridge build were removed. In a Firebase build,
normal startup does not read legacy per-user profile databases
(`german-flashcards:<profile>`). A profile that was never copied stays on the
device untouched, but the app can no longer reach it. No database or storage
key is deleted. Device-mode builds still run the one-time import of the
original single-user `german-flashcards` database into the active profile.

`npm run migrate -- preflight` still reports the historical #34 aggregate from
`unreachedInstallationClasses()`: 2 installation classes, 0 proven reads, and
2 blockers. It is a class count, not a census of active installations. #34 and
#36 were closed as not planned after the waiver; do not reopen that work based
on this count.

## 5. Record results and preserve the historical release evidence

The test rehearsal is complete: #22 prepared the immutable source/baseline,
#24 verified the real import, and #25 verified fresh Google restoration on
iPhone Home Screen and Mac Safari clients. Ten newer reviews and a newer
settings record survived a repeat import with zero writes and client reopening.
Mac browser/OS versions were not recorded.

For a newly authorized production import, use a separately confirmed mapping and credential,
a fresh final GitHub snapshot, and exact server readback. Device-local legacy
work can no longer be copied in the app (section 4). Record source/build, date, device/browser, comparison
method, aggregate result, and unresolved items. Keep exact values and operator
files private. A server `migrationStatus: complete` marker does not verify
device recovery or authorize publication.

The [rollout plan](firebase-rollout-plan.md) records the 2026-10-07 publication
and waiver, current operations, and remaining checks. Both publish steps now
use matching master-only/non-PR guards and publish tested `dist-firebase`, never
local-only `dist/`. The data repository is archived as a frozen legacy snapshot;
neither the current public client nor this documentation writes to it. Do not
infer legacy-token revocation or device recovery from publication alone.

## Automated checks

`npm test` includes synthetic v1/v2 files, two profiles, unmapped names,
strict validation, record-level dry-run, exact readback, interrupted/resumed
imports, no-op repeats, newer server data, and immutable/private export checks.
It calls no production service.

`npm run test:rules` needs Java 21. It also imports synthetic records using the
Admin SDK into `demo-german-flashcards`, then restores them in clean Chromium
contexts using the full #13 sync path. It checks schedule isolation, seed
tombstones, the rehearsal account guard, and the Admin export. It uses no
service account file. The live operator command is never invoked by CI.

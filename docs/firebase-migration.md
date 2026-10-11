# Historical legacy migration and device recovery runbook

**Release decision (2026-10-07):** The Firebase `1.0.0` launch was published
and accepted; later releases have since shipped. The former non-Firebase app is
retired and no longer used by anyone.
Production import of legacy studied data and old-device recovery were
explicitly waived; do not run the procedures below as current release work.
This runbook is retained for historical test evidence and for the guarded,
isolated restore tooling described in [Firebase setup](firebase-setup.md).
The test snapshot import (#24) and real second-device rehearsal (#25) passed
on 2026-10-04. Use [the saved import record](issue-24-status.md) and
[the final second-device result](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235)
when reviewing completed work; do not rerun `--apply` just to inspect evidence.

The commands below are local operator tools, never a Cloud Function or
production CI step. Do not use them for legacy production migration or device
recovery: those operations were waived, and the retired application is no
longer used by anyone. Any live test-project rehearsal must use
`flashcards-ls9-auth-test`. The current production Firebase app is published;
Firestore backup and guarded isolated dump restore, including what a dump does
not recover, are in
[Firebase setup](firebase-setup.md). Restore refuses the production project
and the real-data rehearsal project.

The historical legacy client used a GitHub data writer; the current `master`
and production application use Firebase. The legacy application is retired and
no longer used by anyone. Any future rollback must remain Firebase-compatible
and preserve production Firebase data; never restore the old GitHub writer over
it.

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

Only the isolated `flashcards-ls9-auth-test` rehearsal used mappings and
credentials. Production legacy import and old-device recovery were waived; do
not create production mappings or credentials for those retired procedures.
Keep any test-project mapping, credentials, exports, and command output outside
Git repositories.

## 2. Historical test-project snapshot export

Historical #22 test-project rehearsal procedure: the operator fetched
`origin main` in the private data clone, resolved its full SHA, and exported
`data.json` and `users/*.json` from that exact commit. The exporter ignored
uncommitted working files and left the data repo intact. This is not a current
production migration step.

```bash
git -C /home/joakim/src/german-flashcards-data fetch origin main
SOURCE_COMMIT=$(git -C /home/joakim/src/german-flashcards-data rev-parse origin/main)
npm run migrate -- export \
  --repo /home/joakim/src/german-flashcards-data \
  --commit "$SOURCE_COMMIT" \
  --out "$MIGRATION_DIR/exports/REPLACE_WITH_TIMESTAMP-rehearsal.json"
```

The private test export recorded the full commit, export time, and SHA-256
checksum. Existing export files are never overwritten; exports are created with
mode 600. Input and output paths inside Git repositories (including symlinks
into them) are refused.

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

This records the completed #22 test-project baseline. No production legacy
snapshot or mapping is required: that import was waived for `1.0.0`. Keep any
retained test-project evidence and private artifacts outside Git.

**Historical test-project import procedure only — not for production.** The
commands in the next section describe the completed isolated rehearsal.

## 3. Historical test-project import (completed; not production)

This command sequence documents the completed isolated rehearsal only. Legacy
production import was waived; do not run it as a release or account-provisioning
step.

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

For the completed test rehearsal, the reviewed dry-run was followed by an
`--apply` and exact readback. Do not apply this procedure to production. The
importer behavior recorded in that rehearsal was:

1. The importer preassigned the shared deck and its exact mapped membership,
   then created each `users/{uid}` with `migrationStatus: pending`. It refused
   conflicting existing personal decks/accounts; the test rehearsal used its
   prepared test-project accounts.
2. It imported vocabulary once into that deck and progress/settings separately
   per UID. Each transaction re-read the server before merging, using the #13
   content, SRS, settings, and tombstone rules; newer Firebase records survived
   a rerun.
3. It read every imported record back, compared exact committed fields and clocks
   against the source/merge result, and verified source IDs and collection counts.
   A server record that advanced during verification was retained and reported.
4. It marked accounts `complete` only after successful verification. An
   interrupted write or failed readback left the affected import pending. The
   recorded resume behavior reused committed records and the source fingerprint;
   verified no-op repeats reported `already imported` without writes.

No local resume file was needed: committed records and the recorded source
fingerprint were the checkpoints. The mapping remained fixed while resuming.
An Admin `complete` marker verified the snapshot import; human second-device
verification and collection of every device's local work were separate steps.

This describes the completed test-project rehearsal, not an instruction to run
or resume a production import.

## 4. Historical procedure: recover an old device profile (waived)

This procedure was not part of the released `1.0.0` flow. The former
non-Firebase application is no longer used by anyone, and old-device-only
progress was not imported. Do not execute this section as a remaining rollout
action.

Historical implementation notes: the recovery design depended on the old app's
origin/storage context, an account mapping, and an unpublished bridge. Its
pre-release inventory showed two installation classes but did not establish
actual active-device recovery. Issues #34 and #36 were later waived/closed as
not planned for `1.0.0`. This design and its bridge are retired; do not build,
publish, or follow the recovery steps, and do not treat the old inventory as a
current blocker.

## Historical rehearsal results and current release status

The test rehearsal is complete: #22 prepared the immutable source/baseline,
#24 verified the real import, and #25 verified fresh Google restoration on
iPhone Home Screen and Mac Safari clients. Ten newer reviews and a newer
settings record survived a repeat import with zero writes and client reopening.
Mac browser/OS versions were not recorded.

Legacy production import and old-device recovery were waived for `1.0.0`;
there is no production cutover procedure to perform. The Firebase site is
published and in use. The legacy data repository is a frozen archived snapshot,
and no one uses the former non-Firebase application. Do not infer that a
specific obsolete token has been revoked; check the private credential
inventory if credential cleanup is undertaken. Keep exports and record-level
evidence outside Git. The [rollout plan](firebase-rollout-plan.md) records the
remaining #40 action: copy the private backup directory off this machine.

## Automated checks

The following repository checks remain useful for regression validation; they
are not unfinished migration or release gates:

- `npm test` covers synthetic v1/v2 files, strict validation, dry-run output,
  exact readback, interrupted/resumed imports, no-op repeats, newer server data,
  and immutable/private export checks. It calls no production service.
- `npm run rehearsal:build` validates the isolated test-project configuration
  and artifact without publishing it.
- `npm run test:rules` requires Java 21 and exercises synthetic records in the
  emulator/demo project; it uses no service-account file and does not invoke a
  live operator command.

Production publication is complete. The retired recovery bridge is not a
current build, test, or release requirement.

## Historical importer and token-key behavior

The retired GitHub writer used the localStorage keys
`german-flashcards.github` and `german-flashcards.github.shas`. The current
Firebase client removes those keys on launch. Do not infer from that client-side
cleanup that an old GitHub credential was revoked at the provider.

**End of historical migration/recovery record.**

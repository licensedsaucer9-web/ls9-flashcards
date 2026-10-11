# Historical live test snapshot import (#24)

This document records the test-project import as it stood on 2026-10-04; it is
not the current production release state. Firebase `1.2.0` is now published and
in use; the `1.0.0` launch was the first production release. The former
non-Firebase application is retired and no longer used by anyone; production
legacy-data import and old-device recovery were explicitly waived. The real
import into `flashcards-ls9-auth-test` completed on 2026-10-04, with exact server
readback and an unchanged repeat that made zero writes. All #24 acceptance
checks passed. The separate
[second-device verification (#25)](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235)
also passed later that day. See the [rollout plan](firebase-rollout-plan.md)
for current status. This document retains the saved #24 import evidence;
reviewing it does not require another import.

## Reviewed inputs and revisions

- Source: the immutable #22 remote `main` snapshot at
  `9c08d4aa05eab1838d4995167bba1ed9944f576b`.
- Export checksum (the export's serialized-body SHA-256):
  `723aeda509c8f1b0fad2382be0323fdf5a7fbbe92f6b2698d0393e2f659ba66a`.
- Baseline checksum:
  `9866fe8ad2b4d199ea8975ad15da6398ac7c104efe4ca59ecc956fde458691ec`.
- Mapping: the confirmed test identity from
  [Joakim's sign-in evidence in #10](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/10#issuecomment-5894726933),
  as recorded in #22. It assigns one mapped profile to `legacy-german`.
  The mapping and its fingerprint stay private.
- Importer/tool revision: `046c505640f76e716d58ab8e9954a1db3f0950d3`
  (merged #27). The existing importer is used without changes.
- Published full-app rehearsal revision:
  `10d48abed977eb9ee651771c23997aa740d78ee5`, recorded in #23.

The export and baseline checksums passed, and regenerating the baseline from
the same export and mapping matched every expected document, normalized source
file, count, and migration fingerprint.

## Dry-run and assignment

A fresh read-only preflight and collection inspection found the mapped account,
legacy deck, personal deck, cards, progress, and settings absent. There was no
ownership or membership conflict.

The existing `npm run migrate -- import` command ran without `--apply`, with the
confirmed export, test mapping, and test-project credential. Its private report
contained exactly the expected 1,029 data-document writes plus the two initial
account/deck assignment plans. Every planned data value matched the baseline;
membership matched the mapping; there were no skipped profiles, server-ahead
records, extra server records, or unexplained changes. Full server captures
before and after the dry-run were identical: actual dry-run writes were zero.
The importer's dry-run `writes` count describes planned data writes.

The same input paths were then used with `--apply`. A separate live read during
the import confirmed the shared membership and `legacy-german` assignment with
`migrationStatus: pending`.

## Exact server readback

The importer verified every transaction result before marking the account
complete. A separate read-only collection capture and offline audit also
compared all 1,029 data documents against both the private baseline and the
reviewed/committed merge result. Every field matched exactly, including card
content, content clocks, deletion fields, every SRS field/clock, and settings
and their clock. All expected card, progress, and settings IDs and counts
matched, with no extra documents.

| Record kind | Before dry-run | Expected | Verified after import |
| --- | ---: | ---: | ---: |
| Card documents | 0 | 514 | 514 |
| Progress documents | 0 | 514 | 514 |
| Settings documents | 0 | 1 | 1 |
| Tombstones | 0 | 0 | 0 |

There is one mapped profile and zero skipped profiles. The 301 missing legacy
progress clocks normalize to zero, exactly as in the prepared baseline. No
newer server values or extra server records needed preservation or explanation.
The legacy deck has the exact confirmed membership, no personal deck was
created, and the account points to `legacy-german` with schema version 1,
the expected source commit/fingerprint, and `migrationStatus: complete`.

## Immediate unchanged repeat

Immediately after the separate readback audit, the same command and unchanged
inputs were run again with `--apply`. It reported `already imported` and zero
data writes; every account/deck and data-document decision was also a no-op.
All 1,029 data documents passed exact readback again. Independent captures
before and after the repeat matched every value, complete collection ID set,
and Firestore document update time, including the shared deck and completed
account. This verifies zero assignment or completion-marker writes as well as
zero data writes. The counts in the table remained unchanged.

The importer's `writes` counter covers the 1,029 data documents. The initial
apply additionally created the deck and pending account and then completed
that account after readback; the repeat changed none of those metadata records.

## Evidence and scope

Private mode-600 artifacts under the mode-700 operator directory selected by
`GERMAN_FLASHCARDS_PRIVATE_DIR` retain the input/revision record, preflight,
source/before/after reports, server captures, pending-account observation,
readback/repeat verification, completion manifest, and audit script. The private
`issue-24-review.md` describes offline evidence verification; it requires no new
Firebase import. Exact values, IDs, UID
mapping, credentials, and actual operator-directory paths are excluded from
Git and GitHub.

At the time of this historical test-project operation, `npm test` and
`npm run rehearsal:build` passed. It did not publish the build or sign into the
full app. Production Firebase publication happened later; see the current
[rollout plan](firebase-rollout-plan.md). Other worktrees and their untracked
files were preserved during that operation.

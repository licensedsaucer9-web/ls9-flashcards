# Release and operations plan

Updated 2026-10-17. The historical production preparation used master `63b1ee0`.
This remains the repository's operational plan. Firebase production publication
is complete; studied-data import and legacy device recovery were waived on
2026-10-07. The public artifact reports `1.3.0`, including multiple decks.
The operating record below separates verified host state from pending
installed-device/recovery evidence. The original Prod v1 scope and delivery
procedures are retained as history, including gates later waived by the owner;
they are not a new implementation queue or a requirement to repeat live imports.

## Completed work

| Work | Recorded result |
| --- | --- |
| Reliability (#1–#3) | Durable local revisions, foreground retry, settings clocks, and seed tombstones are implemented. |
| Firebase implementation (#10–#15, PR #21) | Google login, account isolation, Firestore rules and record sync, legacy importer/device copy, and staged production build are merged. Closing these issues did not establish a production cutover. |
| Snapshot and baseline (#22) | Immutable source commit `9c08d4aa05eab1838d4995167bba1ed9944f576b`; private export and exact comparison baseline prepared. |
| Isolated preview (#23) | Test project, restrictive rules, separate app storage, and full-app preview prepared. |
| Live import (#24) | 514 cards, 514 progress records, one settings record, zero tombstones; exact server readback and unchanged repeat with zero writes. |
| Real second-device rehearsal (#25) | Google restoration on fresh iPhone Home Screen and Mac Safari clients; matching settings/due counts; 10 newer reviews and one settings change survived repeat import and client reopening. |
| Guarded account UI (#28–#29) | Sign-out and authenticated welcome state merged and covered by synthetic browser checks. Published in the test preview during the rename; no new physical-device verification was performed. |
| Project rename (2026-10-04) | LS9 Flashcards is the accepted product name. App/package/icons, GitHub repository names, and the public URL are renamed. The former compatibility URL was retired on 2026-10-17; legacy device recovery was waived. See [the rename record](rename.md). |

Evidence: [snapshot/baseline](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/22#issuecomment-5972398972),
[test environment](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/23#issuecomment-5977823891),
[import record](issue-24-status.md), and
[final second-device result](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235).
The second-device check used app revision `10d48ab` and importer `4cf6092`
on 2026-10-04. Devices: iPhone 17, iOS 26.6, Home Screen app; Mac Safari,
with macOS/Safari versions not recorded.

## Release state and operating boundaries

On 2026-10-07 Joakim waived legacy studied-data import and old-device
recovery. #34, #36, and #37 are closed as not planned. A new production
account gets the built-in 514-word deck with empty progress. Master CI
publishes `dist-firebase` after its test gates. Firestore rules are deployed
separately from Pages. The test rehearsal result is recorded on
[#15](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/15#issuecomment-5980512458).

Use `flashcards-ls9-auth-test` for live rehearsals. Keep credentials, mappings,
exports, baselines, and record-level reports outside Git, under
`GERMAN_FLASHCARDS_PRIVATE_DIR`. Public records contain aggregate results and
revision/checksum evidence only. Preserve existing installations and their
storage. Retain the legacy write token until active devices have moved;
`PUBLIC_SITE_DEPLOY_KEY` remains the Pages deployment credential.

The procedures live in [Firebase setup](firebase-setup.md),
[the migration runbook](firebase-migration.md), and
[the isolated rehearsal runbook](firebase-rehearsal.md). This plan owns the
remaining sequence and completion gates.

On 2026-10-17 Joakim authorized retirement of the old
`german-flashcards-site` redirect because the two known users do not need it.
The published redirect/app was replaced by a 404-only deployment and that
repository is archived with its history retained. The current app remains at `ls9-flashcards-site`. Historical bridge
build/tests remain available locally; they are not an active hosted recovery
route. This records an owner decision rather than device inspection or proof
of legacy progress recovery. See the [retirement record](rename.md#old-site-retirement-2026-10-17).

## Current operations — 2026-10-17

- **Published client:** public `release.json` was verified at version `1.3.0`,
  source `0aaf08b78b33e1604c250e3cf751553b0e3c18bf`, production Firebase.
  This includes streaks, multiple decks, per-deck preferences/progress and swipe
  navigation. Names, deck selection, optional-feature switches and local deck
  deletion remain device-local; another device needs an extra deck's ID locally.
- **Rules:** the production `cloud.firestore` release was updated on
  2026-10-16 at 05:06 UTC. Readback matched the source rules SHA-256
  `863c8e03c918d81a67e88f166ca109bfe93c45c48f22b5ecf6dbfc9a3a1086f1`,
  including activity and extra-deck access. This was a rules-only deployment.
- **Backup/copy:** the 08:30 Europe/Oslo `firestore-backup` job succeeded on
  2026-10-17 and reported activity coverage. The 08:45 `firestore-drive-copy`
  rclone job also succeeded. Daily local retention is 14 dumps. This records
  a configured off-machine copy and successful job, not a new remote-file audit
  or restore qualification.
- **Runner update:** the daily backup's source checkout was synchronized to
  current master later on 2026-10-17, including version-2 extra-deck exports.
  No live backup was triggered during that update. Record a subsequent
  successful version-2 dump and isolated restore covering extra-deck settings,
  progress and tombstones before declaring that coverage qualified.
- **Remaining acceptance:** current installed-device updates, two-device
  offline activity reconciliation and the version-2 restore check need their
  own recorded evidence. Earlier production login/isolation/offline-study and
  an isolated production-dump restore remain historical results; publication
  and successful timers do not supply these newer checks.

The private host receipts remain outside Git under
`~/.local/state/flashcards-rules-review-20261016/` and
`~/.local/state/repo-audit-20261017/`. Keep credentials and record-level exports
private; the summaries above contain only revisions, checksums and job outcomes.

## Historical Prod v1 scope and completion

Joakim confirmed on 2026-10-04: **ship the current single-deck app reliably**.
The milestone is [Prod v1](https://github.com/licensedsaucer9-web/ls9-flashcards/milestone/2); the tracking issue is
[#33](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/33). Target release
identity: `v1.0.0`. The following paragraphs retain the original scope and gates.
The 2026-10-07 owner decision above waived studied-data import/device recovery;
current state and remaining evidence are in the operating record, not inferred
from this historical checklist.

Included: the existing German seed/tier system and SM-2-style scheduling,
editing/CSV import, device-only study, Google login/account controls,
offline-first Firestore sync, safe legacy/device migration and verified recovery.
Each account retains one assigned deck. Mapped legacy accounts intentionally
share vocabulary while schedules/settings stay private; new accounts receive
personal decks.

Excluded: multiple decks/subjects, new sharing roles, interval controls, review
history/FSRS, a visual redesign and optional session wording changes. Those are
later product work, not prerequisites for this reliability release.

Prod v1 is complete only when the final production import and all active device
recoveries have exact saved evidence, the verified Firebase artifact is publicly
served, existing-user and fresh-user physical-device acceptance passes, the old
writer is retired, backup cadence and isolated real-dump restoration work, and
the tested final source/artifact is recorded and released as `v1.0.0`.
Closed implementation tickets, Admin completion markers and CI success alone
do not establish those operational results.

## Historical delivery order

| Issue | Deliverable | Depends on |
| --- | --- | --- |
| [#34](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/34) | prove same-context recovery for every active legacy installation | Can start now |
| [#35](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/35) | add guarded Firestore dump restore and rehearse recovery | Can start now |
| [#36](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/36) | prepare production identity, rules and final cutover preflight | #34 |
| [#37](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/37) | import the final production snapshot and recover every active device | #34, #35, #36 |
| [#38](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/38) | publish a verified Firebase release candidate at the public URL | #37 |
| [#39](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/39) | verify production login, account isolation and offline study on real devices | #38 |
| [#40](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/40) | establish backups, retire the legacy writer and release v1.0.0 | #35, #37, #39 |

Start **#34 and #35 independently**. #35 is the first unconditional coding
issue. Production credentials/read-only preparation can be gathered alongside
them, but #36 is not ready until #34 has proven device recovery routes.
The critical sequence is **#34 → #36 → #37 → #38 → #39 → #40**, with **#35
blocking #37 and #40**. New release blockers get small linked issues in this
same milestone; feature expansion stays outside it.

### 1. Prove each installation's recovery route — #34

Privately inventory every active origin/browser/Home Screen storage context and
its pending legacy work. Show that the proposed recovery client can read that
actual source without changing it. An isolated preview or localhost is not
proof for an old installed iPhone context. If needed, prepare a minimal guarded
same-context bridge preserving original storage/install identity; otherwise use
the demonstrated existing recovery path. Rehearse pending-data preservation,
repeat copies and newer-target behavior. Prepare artifacts/runbook steps, not
production publication.

The routes are prepared in the [migration runbook](firebase-migration.md).
Same-origin Safari uses the existing recovery client. An old-scope Home Screen
installation needs the unpublished `dist-recovery-bridge` artifact. That
artifact is preparatory. No private device inventory was available, and no
actual legacy database has been read. The published aggregate is 2 installation
classes, 1 existing-client route, 1 bridge route, 2 unreachable, 0 proven
reads, and 2 blockers. Those classes are public URL placeholders, not a census
of active installations. An omitted install stays a blocker and is not included
in the count. This preparation does not finish #34. #36 stays blocked on #34
until the private inventory and saved same-context reads exist.

**Complete when:** every active context has a proven actionable route and saved
aggregate readiness evidence. Unreachable/unknown contexts remain blockers.

### 2. Implement and rehearse dump restoration — #35

Add a guarded restore path for the existing checksummed `kind: firestore`
backup format. Validate supported schema, records/paths, assignments and
project/credential pairing before network writes. Default to dry-run, require
explicit apply/target, reject unreviewed conflicts or newer target state, and
cover interruption/resume/idempotence with exact readback in an isolated
emulator/throwaway target. Do not overwrite the existing real rehearsal dataset.
Document that this restores Firestore data, not Google Auth identities, local
pending IndexedDB work, deployed rules or hosting. The command and those
limits are in the setup runbook (`npm run migrate -- restore`); it refuses
`flashcards-ls9-prod` and `flashcards-ls9-auth-test`. Production restore stays
unauthorized.

**Complete when:** a full verified recovery round trip and failure cases pass,
with an actionable runbook, limitations and measured restore time. An export
or dry-run alone is insufficient.

### 3. Prepare production preflight — #36

Arrange the separate private production credential and confirmed production
UID mapping via auth-only access. Inspect assignments/server state read-only
and resolve conflicts in a reviewed plan; do not open the owner's ordinary
production app before preassignment. Bind restrictive rules/build/host/base-path
configuration to revisions/checksums. Prepare the write pause, fresh remote
snapshot, immutable export, baseline, production dry-run, pre-change backup and
rollback artifact. Specify the final source/server rechecks and revised-input
procedure if they advance.

The local command is `npm run migrate -- preflight`, documented in the setup
runbook. It records the source revision, the rules and `firebase.json`
checksums, project `flashcards-ls9-prod`, both base paths, the authorized
hosts, the held Pages publish steps, and the prepared rules command with
`executed: false`. Stdout lists blockers and checksums. A private `--out`
file repeats the fingerprint, the recheck rule, and the backup and rollback
notes. The package stays blocked while device routes are unproven and while
the production credential, confirmed UID mapping, read-only inspection,
server fingerprint, and verified pre-change backup are absent. Reuse also
requires a fresh read-only match of document IDs, values, clocks,
assignments, and memberships, or a canonical checksum of that state.
Collection counts are an additional check. A difference invalidates the
reviewed dry run and requires refreshed evidence before an authorized apply.
This preparation leaves #36 open.

**Complete when:** a concrete inspectable readiness package has no unresolved
mapping/assignment/device-route blocker. This issue does not deploy rules,
apply a production import or publish.

### 4. Import and recover production data — #37

After explicit authorization of the prepared rules/import/recovery operations,
pause legacy review/edit/cloud writes. Re-fetch and verify the final source
commit/server state. Deploy tested restrictive rules before full-app access,
preassign/import the owner before ordinary login, and verify every committed
card/progress/settings/clock/tombstone/membership plus exact counts. An unchanged
repeat must preserve newer target data and avoid unnecessary writes.

Recover every inventoried active context through its proven route; a required
limited bridge publication is a distinct authorized recovery action while
general Pages publication stays disabled. Keep source databases/installations.
Require Firestore acknowledgement plus independent second-client comparison
of each context's device-only work. Keep legacy cloud writes paused and recheck
the source commit before general cutover. Save a verified post-recovery backup.

**Complete when:** exact production snapshot/merge/readback fingerprints and
all device recovery results are recorded. Any unrecovered context, advanced
source or failed comparison leaves this gate open.

### 5. Publish the tested candidate — #38

Prepare identifiable release-candidate/source/artifact metadata and run all
existing CI gates: unit/account UI, emulator rules/sync/migration, staged
Firebase artifact, installability/offline reload and rehearsal checks. Keep
both master publish steps disabled until #37 is recorded and publication of
that concrete artifact is explicitly authorized. Then restore both master-only,
non-PR conditions together and publish only `dist-firebase`. Pages CI must
not deploy rules.

The published version is `1.0.0`, with a bundled/offline
Settings identity, `release.json`, and a checksummed `release-candidate.json`.
`npm run release:build` requires clean committed source and paired publication gates;
CI retains the tested `dist-firebase` artifact after all existing gates. The
read-only `release:verify -- --served --site-commit FULL_SHA` command can compare
a later authorized publication with the exact candidate and record both
source and public-site revisions. See the [candidate runbook](firebase-setup.md#prepare-and-verify-a-release-candidate).
Publication of this candidate is authorized. Both master publish steps use
`github.event_name != 'pull_request' && github.ref == 'refs/heads/master'`.
Retained auth/recovery paths stay excluded from the root cleanup. Served
evidence is still required before #38 closes. Real-device login and offline
acceptance remain #39. Closing a preparation PR must not close
this operational gate.

Record source/public-site commits and served build/backend/project/base-path,
manifest/install and service-worker update evidence. Do not delete a recovery
route still needed by a storage context. Before Firebase study exists retain
the legacy artifact; afterwards rollback retains new data and uses a compatible
Firebase client.

**Complete when:** the tested Firebase candidate is served correctly and every
active installation has received or moved safely to it. Public usability
acceptance remains #39.

### 6. Record actual production acceptance — #39

Use desktop, iPhone Safari and the installed Home Screen contexts with recorded
device/browser/OS versions, URL, date and candidate/build. Confirm migrated
settings/due counts/private progress and actual login/cancel/restored-session/
sign-out controls. Use a fresh Google account at the public root to prove
personal provisioning, restoration on another device and private schedule/
settings isolation. The old test preview cannot prove that new-user flow.

Exercise offline grade → suspend/close → reopen offline → reconnect → second
client, with accurate **Saved on this device / Synced**, foreground retry and
**Sync now**. Check current tier/session/study behavior, disposable editing/CSV/
deletion, device-only study/confirmed copy and mobile install/form controls.
Record private detailed comparisons and public aggregate outcomes. Fix any
release blockers and repeat the affected checks on the candidate that ships.

**Complete when:** Joakim records existing-user/fresh-user/device/offline
production passes with no unresolved release blocker. #25 or UI test success
does not replace this current-build evidence.

### 7. Establish operations and finalize v1.0.0 — #40

Revoke the legacy data-write token only after every active context uses Firebase
and all pending work is acknowledged/read back. Preserve the data repo as a
frozen recovery snapshot and retain `PUBLIC_SITE_DEPLOY_KEY`. Establish a
working daily backup cadence, or a separately accepted alternative, with
durable private storage independent of the primary machine, retention and
observable last-success/failure evidence.

Restore a real private production dump into an isolated recovery target,
without modifying production or the existing rehearsal dataset. Compare
exact private data, assignments/memberships/clocks/tombstones and aggregate
checksums/counts; record observed time and agreed recovery targets. Retire
temporary previews/old-URL writers only when no active context depends on them.
A retained compatibility path must be documented, Firebase-compatible and
have no legacy data writer.

Update README/runbooks to the actual deployed result and known clock/sync
limits. Finalize `1.0.0` metadata, verify the exact final artifact with CI and
a public-device smoke check, then tag/release `v1.0.0` with upgrade/rollback
notes. These are owner-authorized operations, not effects of this planning PR.

Version `1.0.0` is the published Firebase client. Joakim's production login,
isolation, and offline readback are recorded on #39. The legacy data repo is
the frozen pre-Firebase snapshot. `firestore-backup.timer` writes a private
daily dump on this machine, keeps 14 copies, and records aggregate
success or failure. Daily off-machine copying is now configured, with a successful
2026-10-17 job; see the current operating record for the remaining version-2
dump/restore check. Isolated restore drills use
the emulator and the guarded restore, never production or the auth-test project.

**Complete when:** production data/device/publication/QA, token retirement,
backup cadence and isolated real-dump recovery evidence are all linked in #33;
only then close the milestone.


## After the rollout

The app now supports multiple decks on different subjects alongside the bundled
German deck. Decks can create empty decks, switch, rename, and confirm deletion
of extra local decks; preferences and cloud progress are scoped per deck.
The original deck is protected. Names, selection, feature switches and local
deletion stay device-local, and extra-deck discovery on another client needs
its ID in that client's local list. Broader sharing and automatic cross-device
deck-list management remain future work. See [architecture](architecture.md).

**LS9 Flashcards** is now the product name. The user chose to complete the
rename before the remaining Firebase rollout. IndexedDB names/storage prefixes,
Firebase project IDs, card IDs, and the private operator-directory variable
retain their original values for compatibility. The old public URL was retired
on 2026-10-17 and now has only a 404 deployment. Legacy studied-data import and recovery
of old storage contexts were waived on 2026-10-07; retention is a separate
owner decision, not an outstanding recovery gate. See [the rename record](rename.md).

Retained optional ideas from the earlier proposal are an interval multiplier,
clearer session-exit wording, and eventual review-history/FSRS evaluation.
They have no scheduled implementation or rollout dependency.

If the multiplier is chosen later, preserve first Hard/Good = 1 day and first
Easy = 4 days unless changed explicitly. The proposal was a global factor
0.5–7, default 1, applied only to future Hard/Good/Easy intervals with a
one-day floor; never reschedule existing due dates or scale Again/Gender.
It would need settings/document/rules compatibility, interval previews, and
cross-device checks. Review history and FSRS require a separate data design
and evaluation using real review events; they are not current features or
release requirements.


## Forgiving streaks — #58

The `1.3.0` source implements the 10-review target, carrying partial repair,
passive fire/moon/skull counter, and immutable per-account activity. The public
site now reports `1.3.0`; the master workflow publishes after CI. Publication
alone does not prove the operational steps below. Retain or record their
evidence rather than treating a merged feature PR as device/recovery acceptance.
The 2026-10-16 rules deployment and 2026-10-17 scheduled backup/copy results are
recorded above. Items below describe verification categories; they do not mean
those completed operations must be repeated:

1. Review the passing unit/browser/emulator checks, including activity ownership,
   concurrent writes, idempotent retry, offline replay and backup/restore.
2. Deploy the reviewed additive `activity` security rules through the existing
   operator procedure. Record the revision and rules checksum. Old clients remain
   compatible with the additive rules. Pages must not deploy rules. Without the
   new rules, the new client's activity pull is denied and its sync cannot finish.
3. Point the private daily backup runner at the reviewed backup code that exports
   `users/{uid}/activity`; retain the existing private directory and retention.
   Record a successful aggregate backup and isolated restore including activity.
4. Merge/publish the tested Firebase candidate, verify served files and revision,
   and check installed-app update plus two-device offline activity reconciliation.
   Keep served-artifact publication evidence distinct from installed-device and
   two-device activity acceptance.

The activity store upgrades IndexedDB from version 1 to 2 on writes. A rollback
must retain activity and support version 2; publishing the old version-1 writer
would strand that installation until it upgrades again. Existing production
schedules and preferences are preserved. No pre-feature streak is reconstructed.

Review fixes for #59 tighten activity time zones to `UTC` or slash-separated
Area/Location forms (including `Etc` zones); rules cannot validate the full IANA
registry. Activity updates remain forbidden, while owners may delete events for
cleanup. Pulls skip invalid events with aggregate warnings, and restore reports
count skipped activity rows while retaining all other validated data. These
reviewed rules are included in the separately verified 2026-10-16 production
deployment; future changes still need their own operator deployment and receipt.

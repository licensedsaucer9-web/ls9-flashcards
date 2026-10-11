# Prod v1 release plan

Updated 2026-10-11: Firebase `1.2.0` is published and in use. The initial
`1.0.0` launch came from master `d7f0943`; production login,
account isolation, and offline sync to a second client were verified. The former
non-Firebase GitHub-sync application is retired and no longer used by anyone.
Legacy studied-data import and old-device recovery were explicitly waived. The
`1.0.0` publication and device-acceptance gates are complete; issues #49/#50
subsequently shipped word-type filtering and badges. Issue #40 remains open for
an off-machine copy of the private Firestore backups. See the issue for current
evidence; this document does not establish that the copy has happened.
This is the repository's status record, not authorization for additional
production migration or publication work.

## Completed work

| Work | Recorded result |
| --- | --- |
| Reliability (#1–#3) | Durable local revisions, foreground retry, settings clocks, and seed tombstones are implemented. |
| Firebase implementation (#10–#15, PR #21) | Google login, account isolation, Firestore rules and record sync, legacy importer/device-copy code, and production build support were implemented. Legacy migration code is retained for isolated tests and reference; it is not part of the released production flow. |
| Snapshot and baseline (#22) | Immutable source commit `9c08d4aa05eab1838d4995167bba1ed9944f576b`; private export and exact comparison baseline prepared. |
| Isolated preview (#23) | Test project, restrictive rules, separate app storage, and full-app preview prepared. |
| Live import (#24) | 514 cards, 514 progress records, one settings record, zero tombstones; exact server readback and unchanged repeat with zero writes. |
| Real second-device rehearsal (#25) | Google restoration on fresh iPhone Home Screen and Mac Safari clients; matching settings/due counts; 10 newer reviews and one settings change survived repeat import and client reopening. |
| Guarded account UI (#28–#29) | Sign-out and authenticated welcome state merged and covered by synthetic browser checks. Initially published in the test preview during the rename; production account controls were later covered by the completed #39 acceptance. |
| Project rename (2026-10-04) | LS9 Flashcards is the accepted product name. App/package/icons, GitHub repository names, and public URL were renamed. The former non-Firebase app is retired and no longer used by anyone; legacy studied-data import and old-device recovery were waived. See [the historical rename record](rename.md). |

Evidence: [snapshot/baseline](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/22#issuecomment-5972398972),
[test environment](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/23#issuecomment-5977823891),
[import record](issue-24-status.md), and
[final second-device result](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235).
The second-device check used app revision `10d48ab` and importer `4cf6092`
on 2026-10-04. Devices: iPhone 17, iOS 26.6, Home Screen app; Mac Safari,
with macOS/Safari versions not recorded.

## Release status and operating boundaries

On 2026-10-07 the owner waived legacy studied-data import and old-device
recovery. Issues #34, #36, and #37 were closed as not planned; #38 (publication)
and #39 (production device acceptance) are complete. A new production account
gets the built-in 514-word deck with empty progress. Master CI publishes the
Firebase client from `dist-firebase`; Pages CI does not deploy Firestore rules.

The former non-Firebase app is no longer used by anyone. Its GitHub data
repository is an archived frozen snapshot, not an active data source or writer.
Do not resume legacy migration/recovery or old-writer operation. Keep any
credentials, exports, and record-level reports private under
`GERMAN_FLASHCARDS_PRIVATE_DIR`. `PUBLIC_SITE_DEPLOY_KEY` remains the separate
Pages deployment credential. The remaining #40 action is copying the private
backup directory off this machine; check #40 for current completion evidence.

Use `flashcards-ls9-auth-test` only for live test rehearsals. The runbooks
below retain historical procedures; they do not override the release decision.

## Prod v1 scope and status

Joakim confirmed on 2026-10-04: **ship the current single-deck app reliably**.
The milestone is [Prod v1](https://github.com/licensedsaucer9-web/ls9-flashcards/milestone/2); the tracking issue is
[#33](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/33).
Prod v1 release identity was `v1.0.0`; the current release is `1.2.0`.
Release gates #38 and #39 are complete; legacy import/recovery gates #34,
#36, and #37 were waived and closed as not planned. The off-machine backup
copy remains open in #40.
The delivery list later in this document is historical context; follow current
issue state and the release status above, not its original proposed sequence.
Subsequent product releases added word-type badges (`1.1.0`) and filtering
(`1.2.0`); they did not reopen the waived migration gates.

The current app includes the German seed/tier system, word-type badges and
filtering, SM-2-style scheduling, editing/CSV import, device-only study, Google
login/account controls, and offline-first Firestore sync. Each production
account has one assigned deck and private schedule/settings. The former
non-Firebase app is retired and no longer used by anyone; legacy studied-data
import and old-device recovery were not part of the release.

Excluded: multiple decks/subjects, new sharing roles, interval controls, review
history/FSRS, a visual redesign and optional session wording changes. Those are
later product work, not prerequisites for this reliability release.

Prod v1 publication and production device acceptance are complete: Firebase
`1.0.0` shipped, and login/account isolation/offline sync were verified on
devices. The current published Firebase release is `1.2.0`; the legacy writer
is retired. The open operational closeout is the off-machine copy of the private
backup directory tracked by #40; the daily backup timer stores dumps on this
machine.

## Delivery issue status

| Issue | Current status |
| --- | --- |
| [#34](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/34) — old-device recovery | Waived; closed as not planned. The retired app is no longer used by anyone. |
| [#35](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/35) — guarded Firestore restore | Complete; isolated restore tooling and rehearsal are available. |
| [#36](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/36) — production preflight | Waived; closed as not planned for the agreed release. |
| [#37](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/37) — legacy production import/recovery | Waived; closed as not planned. New accounts start with empty study progress. |
| [#38](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/38) — publish Firebase release | Complete; the initial Firebase `1.0.0` launch is served and later versions are published. |
| [#39](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/39) — production device acceptance | Complete; login, account isolation, and offline second-client sync were verified. |
| [#40](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/40) — operations closeout | Open for copying private Firestore backups off this machine; see issue for current evidence. |

There is no remaining production cutover or legacy-device recovery sequence.
The original #34–#39 plans are summarized as historical context below; do not
execute them as current work. Use isolated restore tooling only for an explicitly
requested recovery drill.

## Historical pre-release gate design (#34–#39)

The detailed procedures originally written for #34–#39 described a proposed
legacy-device inventory/recovery, production import and preflight, candidate
publication, and device-acceptance sequence. They are superseded by the release
decisions and issue outcomes above; do not execute them as current work. In
particular, no legacy studied-data import or old-device recovery is expected,
and Firebase `1.0.0` was published and accepted; later versions are in use.
Preserve the issue and PR records for historical evidence. The guarded restore
tooling completed under #35 remains available for an explicitly requested
isolated recovery drill; it is not a production cutover prerequisite.

## Remaining operations closeout — #40

Firebase `1.2.0` is published and in use; initial production device
acceptance is recorded on #39. The former non-Firebase application is no longer
used by anyone; its GitHub data repository is an archived frozen snapshot, and
no legacy data writer is active. Legacy studied-data import and old-device
recovery were waived.

The daily `firestore-backup.timer` writes private dumps on this machine, keeps
14 copies, and records aggregate success/failure. **The outstanding #40 action
is to copy those private backups to storage independent of this machine and
record evidence on #40.** Keep backup contents, credentials, and record-level
reports outside Git and public issue comments. Do not assume the old browser
token has been revoked; review the private credential inventory and revoke it
through GitHub settings if it still exists. `PUBLIC_SITE_DEPLOY_KEY` remains
the separate Pages credential.

Restore tooling and isolated emulator verification are complete under #35.
No production import, legacy device recovery, republishing, or second v1.0.0
tag/release is required. The Prod v1 milestone may be closed when the remaining
off-machine backup evidence is recorded in #33/#40. Handle applicable
credential cleanup as separate credential hygiene.


## After the rollout

The product direction is multiple decks on different subjects, beyond the
bundled German vocabulary. Current accounts use one assigned deck and there
is no deck picker. Define deck selection, ownership/sharing, seed handling,
per-deck settings/progress, and migration before implementing that expansion.

**LS9 Flashcards** is the product name. The 2026-10-04 rename preserved
IndexedDB names/storage prefixes, Firebase project IDs, card IDs, and the private
operator-directory variable for compatibility. Firebase `1.2.0` is the current
production application; the former non-Firebase app is retired and no longer
used by anyone. Old-device recovery is not a remaining rollout gate. See [the
rename record](rename.md).

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

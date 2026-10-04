# Firebase rollout plan

Updated 2026-10-04 against `master` at `efa4d1d`. This is the repository's
only active plan. Implementation and the real-data test rehearsal are complete;
production migration, device recovery, publication, and backup recovery remain.

## Completed work

| Work | Recorded result |
| --- | --- |
| Reliability (#1–#3) | Durable local revisions, foreground retry, settings clocks, and seed tombstones are implemented. |
| Firebase implementation (#10–#15, PR #21) | Google login, account isolation, Firestore rules and record sync, legacy importer/device copy, and staged production build are merged. Closing these issues did not establish a production cutover. |
| Snapshot and baseline (#22) | Immutable source commit `9c08d4aa05eab1838d4995167bba1ed9944f576b`; private export and exact comparison baseline prepared. |
| Isolated preview (#23) | Test project, restrictive rules, separate app storage, and full-app preview prepared. |
| Live import (#24) | 514 cards, 514 progress records, one settings record, zero tombstones; exact server readback and unchanged repeat with zero writes. |
| Real second-device rehearsal (#25) | Google restoration on fresh iPhone Home Screen and Mac Safari clients; matching settings/due counts; 10 newer reviews and one settings change survived repeat import and client reopening. |
| Guarded account UI (#28–#29) | Sign-out and authenticated welcome state merged and covered by synthetic browser checks. These fixes were not published or physically verified by those PRs. |
| Project rename (2026-10-04) | LS9 Flashcards is the accepted product name. App/package/icons, GitHub repository names, and the public URL are renamed; the old Pages URL remains a compatibility site until device recovery is complete. See [the rename record](rename.md). |

Evidence: [snapshot/baseline](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/22#issuecomment-5972398972),
[test environment](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/23#issuecomment-5977823891),
[import record](issue-24-status.md), and
[final second-device result](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235).
The second-device check used app revision `10d48ab` and importer `4cf6092`
on 2026-10-04. Devices: iPhone 17, iOS 26.6, Home Screen app; Mac Safari,
with macOS/Safari versions not recorded.

## Release state and operating boundaries

The public root still serves the previous GitHub-sync build. CI checks the
Firebase production client in `dist-firebase`, but both publication steps in
`.github/workflows/pages.yml` remain disabled. The test rehearsal result is
also recorded on [#15](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/15#issuecomment-5980512458);
it does not authorize production imports, production rules deployment, or
publication.

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

## 1. Prepare production and recover every active device

1. Inventory every browser/install still used, distinguishing iPhone Safari
   from the installed Home Screen app. Identify device-only reviews, edits,
   custom cards, settings, and deletions.
2. Prove a recovery build can access each actual legacy IndexedDB context.
   The isolated test preview uses separate storage; localhost cannot read an
   iPhone's data. If a preview cannot access an installed app's storage,
   prepare a same-context recovery/bridge release before moving that device.
3. Arrange the production Admin credential and separately confirm the
   production UID mapping. Inspect existing account/deck state and resolve
   assignment conflicts without discarding data. Deploy restrictive production
   rules when that milestone is authorized, before full-app production access.
4. Coordinate a short pause in legacy edits/reviews and keep legacy cloud writes
   paused once final migration starts. Fetch a fresh remote data commit, export
   it immutably, prepare its baseline, inspect the production dry-run, then
   import and verify exact server readback before the owner's first full-app
   production login. The test snapshot is not the final production snapshot.
5. Recover each confirmed local profile into its mapped production account
   using the same origin and storage context. Retain its source database.
   Require Firestore acknowledgement and a clean second-client comparison of
   the merged result, including device-only changes.
6. Recheck the legacy source commit before cutover. If it advanced, reconcile
   and verify the new snapshot before proceeding.

**Complete when:** production snapshot identity, exact readback, and every
active device's recovery result are recorded privately, with an aggregate
rollout summary. Any unrecovered device remains an unfinished item.

## 2. Publish and verify live use

After stage 1 is recorded and publication is authorized:

1. Restore both master-only publication conditions and publish the tested
   `dist-firebase` artifact. Record its source and public-site commits. Keep
   pull requests from publishing or deploying rules.
2. Confirm the production schedule on desktop, iPhone Safari, and the installed
   Home Screen app. Check real Google login, cancellation, sign-out/sign-in,
   and the account controls; merged UI checks alone do not prove physical
   device behavior.
3. Grade offline, suspend/close, reopen offline, reconnect, and verify the grade
   on a second client. Require accurate **Saved on this device / Synced**
   status. Use the [manual acceptance guide](../TEST.md).
4. Use a fresh Google account on the public URL. Verify automatic provisioning,
   second-device restoration, and separation from the legacy account's deck
   and schedule. The guarded test preview cannot establish this new-user gate.

**Complete when:** existing-account restoration, fresh-user onboarding,
account isolation, and offline/reconnect checks have recorded production
results, and every active installation runs the Firebase build.

## 3. Retire the old writer and establish recovery

1. Revoke the legacy data-write token after all active devices have moved and
   their pending work is acknowledged. Keep the data repository as a frozen
   recovery snapshot and retain the Pages deployment key.
2. Run a private production Firestore export; validate its checksum and
   account/deck/document counts. Select and document a backup cadence and
   durable private storage.
3. Confirm or implement a restore procedure for that Firestore dump and
   rehearse it in an isolated project. The current CLI exports backups but
   has no Firestore-dump restore command; the legacy importer accepts a
   different format. An export alone is not recovery-tested.
4. Remove temporary OAuth/rehearsal previews when they are no longer needed.
   Retire the old-URL compatibility site only after every active old
   installation/storage context has been recovered and verified.
   Update README, setup, and test documentation to describe the deployed
   result and record final rollout completion.

**Complete when:** token retirement, backup cadence, and isolated restoration
have recorded results. After Firebase study exists, rollback retains that data
and publishes a Firebase-compatible client.

## After the rollout

The product direction is multiple decks on different subjects, beyond the
bundled German vocabulary. Current accounts use one assigned deck and there
is no deck picker. Define deck selection, ownership/sharing, seed handling,
per-deck settings/progress, and migration before implementing that expansion.

**LS9 Flashcards** is now the product name. The user chose to complete the
rename before the remaining Firebase rollout. IndexedDB names/storage prefixes,
Firebase project IDs, card IDs, and the private operator-directory variable
retain their original values for compatibility. The old public URL stays
available for existing installations; recovering every old storage context
remains a rollout gate. See [the rename record](rename.md).

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

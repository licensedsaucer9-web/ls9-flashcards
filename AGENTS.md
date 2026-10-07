# Migration rehearsal and handoff

- Read `README.md` for release state and `docs/architecture.md` for implemented
  behavior. `docs/firebase-rollout-plan.md` is the only active plan; setup,
  migration, and rehearsal guides are runbooks, not separate roadmaps.
- The real-data test rehearsal (#22–#25) is complete as of 2026-10-04.
  Publication and the `1.0.0` device checks are recorded. The legacy data repo
  is archived. A daily private Firestore backup runs on this machine, and one
  isolated emulator restore of a production dump has been verified. An
  off-machine copy of those dumps is still outstanding. Closed implementation
  issues do not establish that copy.

- Run live rehearsal operations only against `flashcards-ls9-auth-test`.
  Joakim authorized the 2026-10-07 release: no studied-data import and no
  legacy device recovery. Master publishes `dist-firebase` through the paired
  master-only conditions in `.github/workflows/pages.yml`. Do not publish a
  flag-off build in its place, and do not deploy Firestore rules from that
  workflow.
- Keep credentials, UID mappings, exports, baselines, and record-level reports
  outside Git, under `GERMAN_FLASHCARDS_PRIVATE_DIR`. Never print credentials or
  commit private operator files. Do not dump UID mappings or record-level values
  into handoff logs. Public summaries contain aggregate counts and
  revision/checksum evidence only.
- Preserve other worktrees, including their untracked files. Never stash, reset,
  clean, or modify another checkout to finish a handoff. If the PR's base branch
  is checked out elsewhere, merge the reviewed PR remotely and report that this
  worktree was not updated; do not update the other checkout.
- Reviewing an operational import means inspecting its saved evidence. Do not
  rerun `--apply`, provision accounts, sign into the full app, or publish a
  preview as part of review. Snapshot import completion does not establish the
  separate second-device acceptance result.

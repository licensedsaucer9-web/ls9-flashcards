# Migration rehearsal and handoff

- Read `README.md` for release state and `docs/architecture.md` for implemented
  behavior. `docs/firebase-rollout-plan.md` is the only active plan; setup,
  migration, and rehearsal guides are runbooks, not separate roadmaps.
- For UI design work, read `docs/design-workflow.md`. Penpot is our workspace
  for editable sketches and discussion before implementation. The app, code,
  tests and architecture docs remain authoritative; Penpot can contain proposals
  and example states, and does not automatically sync with the code.
- The real-data test rehearsal (#22–#25) is complete as of 2026-10-04.
  Publication and the `1.0.0` device checks are recorded. The legacy data repo
  is archived. A daily private Firestore backup runs on this machine, and one
  isolated emulator restore of a production dump has been verified. The daily
  backup and off-machine rclone copy jobs both succeeded on 2026-10-17. The
  runner was updated to current master afterward; a version-2 extra-deck
  dump/restore still needs its own evidence. Job success does not prove every
  remote file or installed-device acceptance. See the operating record in
  `docs/firebase-rollout-plan.md`.

- Current source supports multiple decks and per-deck preferences/progress.
  Names, selection, optional-feature switches and local deck deletion are
  device-local. Production rules were verified on 2026-10-16 with SHA-256
  `863c8e03c918d81a67e88f166ca109bfe93c45c48f22b5ecf6dbfc9a3a1086f1`.
  The former `german-flashcards-site` URL is retired; its archived repository
  serves only a 404 page. Use `ls9-flashcards-site` for the current app.

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

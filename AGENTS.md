# Migration rehearsal and handoff

- Run live rehearsal operations only against `flashcards-ls9-auth-test`.
  Production imports, rules deployment, and publishing remain held until their
  separate cutover milestones are authorized. Preserve both disabled production
  publish steps in `.github/workflows/pages.yml`.
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

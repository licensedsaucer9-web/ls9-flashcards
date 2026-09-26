# German Flashcards — current review

Reviewed against `master` on 2026-09-26. The detailed
[2026-09-22 review](docs/archive/REVIEW-2026-09-22.md) is retained as a
historical record; its descriptions of the deployment, backup implementation,
and missing repository files are no longer current.

## Working state

- The Vite/TypeScript PWA is published from the separate public
  [`german-flashcards-site`](https://github.com/licensedsaucer9-web/german-flashcards-site)
  repository. This source repository and
  [`german-flashcards-data`](https://github.com/licensedsaucer9-web/german-flashcards-data)
  remain private. The public URL is in the [README](README.md#public-site).
- A push to `master` runs `npm test`, builds with the public base path, checks
  the deploy artifact and offline reload, then publishes the built files. Pull
  requests run the checks without publishing.
- Local changes have durable IndexedDB revision tracking and foreground GitHub
  retry. Deleted built-in cards have tombstones that prevent reseeding. Settings
  have a separate freshness timestamp. These changes supersede the early sync
  findings and the [reliability plan](plan.md).
- The app's Home Screen migration was confirmed on iPhone: earlier review
  progress, offline opening, and a new GitHub backup all worked. The
  [migration issue](https://github.com/licensedsaucer9-web/german-flashcards/issues/5)
  is closed.

## Current limitations worth tracking

- `src/csv.ts` does not strip a UTF-8 BOM before comparing the first header;
  a BOM-prefixed CSV header can be imported as a card.
- `src/db.ts` opens a new IndexedDB connection for each operation. It does not
  close old connections on `versionchange`, which matters before any schema
  upgrade.
- `src/main.ts` saves GitHub connection fields before validating them. An
  invalid token can therefore remain stored in that browser until replaced or
  disconnected. The token is stored in browser `localStorage`; scope it to the
  private data repository.
- Snapshot merging uses card timestamps and keeps local changes on equal
  timestamps. Device clock skew remains a conflict limitation. The app stores
  current SRS state, not an append-only review history.

The [click-path guide](TEST.md) describes manual behavior checks. The private
[data recovery guide](https://github.com/licensedsaucer9-web/german-flashcards-data#verify-an-existing-backup-without-changing-it)
describes read-only backup verification. Future interval-factor and FSRS ideas
remain proposals in [proposed_plan.md](proposed_plan.md), not app features.

# iPhone data reliability plan

This plan covers three existing data-loss and data-resurrection risks in the German Flashcards Home Screen web app. It does not implement them. The app remains a local-first PWA: IndexedDB holds the working deck, and the private `german-flashcards-data` repository remains the remote backup and cross-device sync target. The data repository needs no manual edit for this plan.

## Current behavior and risk

| Area | Current path | Failure |
| --- | --- | --- |
| Unsynced grade | `src/main.ts` writes a grade, then `src/sync.ts` sets an in-memory `dirty` flag | If the app is suspended, relaunched, or the PUT fails, the flag disappears. Startup may merge local data without uploading it. Another device stays stale. |
| iPhone background save | `visibilitychange` / `pagehide` call `flushPush()` with `keepalive: true` | The current private snapshot is about 141 KB and the encoded GitHub PUT body about 188 KB. The [Fetch keepalive budget is 64 KiB](https://fetch.spec.whatwg.org/), so the last-second upload cannot be the backup guarantee. |
| Deleted seed card | `ensureSeed()` checks present cards but not `deletedIds` | A deleted built-in card is inserted again on the next launch; a fresh `updated_at` can also beat its tombstone in a later merge. |

The Home Screen app must treat a locally committed review as safe on that device and distinguish it from a GitHub-confirmed backup. It must not claim that a remote save succeeded just because a request was started. iPhone background execution is an opportunity, not a required step for correctness. WebKit also documents [circumstances where origin storage may be evicted](https://webkit.org/blog/14403/updates-to-storage-policy/), so a reliable remote backup still matters.

## Work order

### 1. [#1 Persist unsynced changes across iPhone app restarts](https://github.com/licensedsaucer9-web/german-flashcards/issues/1)

Build the durable foundation first. Keep a local change revision and last acknowledged revision in IndexedDB. Every user mutation must commit the data and pending revision atomically, including grading, editing, deleting, importing, and changing settings. A debounce timer may start a sync but cannot be the record of work owed to GitHub.

Use one serialized pull/merge/push operation. On startup or foreground retry, fetch remote data and merge it with local data. If local work is still unacknowledged, upload the merged snapshot. Only the GitHub response may acknowledge the revision included in that upload; a newer local edit stays pending. On a stale SHA, re-fetch and merge before retrying. Do not let remote apply overwrite a local edit made while sync was running. Keep the version-1 snapshot readable so existing `data.json` remains valid.

**Gate:** An offline grade survives relaunch and uploads automatically when network returns; a grade during an in-flight sync is not lost; a failed PUT leaves the pending state intact; a second device sees the grade after successful retry. Test these using real IndexedDB persistence and a stubbed GitHub API as well as the pure merge tests.

### 2. [#2 Replace oversized background PUT with reliable foreground retry](https://github.com/licensedsaucer9-web/german-flashcards/issues/2)

Once #1 makes pending work durable, remove the full-snapshot `keepalive` PUT from `visibilitychange` and `pagehide`. Use normal requests while the app is active: after a short debounce, on the next launch, on return to foreground, and from Sync now. If iOS suspends the app, the pending revision remains for the next opportunity. Show separate states for saved locally, waiting to back up, syncing, backed up, and failure. Avoid repeating a full GitHub commit when nothing local has changed.

**Gate:** With a snapshot larger than 64 KiB, grade and immediately switch apps. No oversized keepalive request is attempted. On reopening with connectivity, the grade uploads and the status says backed up only after acknowledgment. Cover hide/resume/reload, offline retry, and manual retry in a Home Screen or mobile-browser click path.

### 3. [#3 Keep deleted built-in cards deleted during reseeding and sync](https://github.com/licensedsaucer9-web/german-flashcards/issues/3)

Make `ensureSeed()` consult deletion tombstones before inserting missing seeds. Give each seed entry a stable ID and version timestamp or equivalent precedence rule; merely launching the app must not make seed content newer than a user deletion or edit, and inserting a new entry must not shift an old card's identity. Newly added seed entries should still appear for existing users, and edited cards must retain their SRS progress. This ticket is independent of #2 and can be developed after #1 or in parallel once the sync invariants are agreed.

**Gate:** Delete a built-in card, relaunch, reconnect, and open another device: it remains deleted. A fresh install receives the remaining seeds. A later seed addition does not reset edits or review progress.

## Validation and rollout

1. Before any code rollout, take a copy of the current private `data.json` and verify it parses as the existing version-1 snapshot. Do not reset users' IndexedDB or SRS fields.
2. For each ticket, run `npm test` and `npm run build`; add focused browser tests for IndexedDB, visibility transitions, and two-device conflict/retry behavior. Include a snapshot larger than the keepalive limit.
3. Verify the actual iPhone Home Screen flow: grade offline, switch apps immediately, reopen, reconnect, and check both the GitHub data file and a second device. Confirm the UI never reports a remote backup before GitHub acknowledges it.
4. Deploy the app only after the relevant gate passes. Monitor the first production sync and confirm that the private data repo contains the expected grade and no revived seed cards.

This plan intentionally does not move data into the application repository or replace GitHub with a new backend. Those are separate architecture decisions; the three fixes above make the current setup dependable first.

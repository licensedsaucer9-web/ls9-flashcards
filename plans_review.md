# Review of the two plans

`plan.md` (`d76db4f`) and `proposed_plan.md` (`29e175b`) are similar in craft and different in job. Both name the current code, give an order of work, and end in checks you can fail. `plan.md` is the one to implement now.

## What each document is

`proposed_plan.md` is the product roadmap. It covers a small exit/close pass, the settings-freshness bug (`snapshotFromDb()` stamps `updated_at` with the read time, so remote settings never win), an interval multiplier on the current SM-2 scheduler, and a later path through review history to FSRS. The factor rules are sound: store `srsIntervalFactor` once in settings, default a missing value to `1`, scale only future Hard/Good/Easy intervals, and leave existing due dates alone. First Good stays 1 day and first Easy stays 4 days until that baseline is changed on purpose.

`plan.md` is the data-reliability plan, and it matches open issues [#1](https://github.com/licensedsaucer9-web/german-flashcards/issues/1), [#2](https://github.com/licensedsaucer9-web/german-flashcards/issues/2), and [#3](https://github.com/licensedsaucer9-web/german-flashcards/issues/3). A grade is stored in IndexedDB while `dirty` lives only in memory, so a restart can merge locally and report Synced without uploading. `flushPush()` sends the whole snapshot with `keepalive: true`, and the live file is already past the 64 KiB keepalive limit. `ensureSeed()` inserts any missing built-in card and does not consult `deletedIds`, so a deleted seed card returns on the next launch.

## Quality and clarity

Quality is similar. Both are specific enough for an implementer who does not have the chat that produced them. `plan.md` is the clearer of the two: one failure class, a table, three tickets in order, and a gate on each. `proposed_plan.md` is clear inside each step, and harder to start from, because exit polish, sync, scheduling, and FSRS share one sequence. One line overstates the code: unknown settings are not kept today. `parseSnapshot` retains `direction` and `sessionSize` only. Close already returns home; that step is polish.

## Choice

Implement `plan.md`: #1, then #2, and #3 once the sync invariants from #1 are settled. A grade that never reaches the private data repo, and a deleted card that comes back, come before a spacing preference.

Leave `proposed_plan.md` in the repo as the follow-on. After #1–#3, the slice to build from it is: lock today's intervals in tests, give settings their own freshness timestamp, add `srsIntervalFactor` in `[0.5, 7]` with default `1`, and preview the real numbers (Good 1 day, Easy 4 days). Review history and FSRS stay parked until sync can carry a larger file.

Where they overlap, `plan.md` sets the order. #1 is the durable pending revision, including a grade made while a pull is in flight. #2 removes the oversized keepalive PUT. Settings freshness from the proposed plan is still required before the factor, and it belongs with or immediately after #1. Seed resurrection is only in `plan.md`. The private `german-flashcards-data` repo stays a data file under both plans.

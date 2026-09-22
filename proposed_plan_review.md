# Review of `proposed_plan.md`

Reviewed against the PWA on `master` (`29e175b` plus the prior app commits) and the live private snapshot in `german-flashcards-data`.

The plan is a good fit for this app. It describes the current SM-2 scheduler, Close/Back home, whole-snapshot GitHub sync, and the settings-merge bug accurately. It puts that bug in front of the new interval factor, and treats FSRS as a later evaluation rather than a scheduler swap. Steps **0–4** are the right next slice. Steps **5–6** should stay parked until sync can carry a larger file.

## What the plan gets right

The live app already matches the plan’s inventory:

- Review is a hash route (`#/review`). **Close** and **Back home** both call `go('/')`. Grades are written with `putCard` before the next card paints, then `schedulePush()` runs. The in-memory queue dies when `render()` leaves the route, and `unbindKeys` is cleared on every navigation.
- `src/srs.ts` is compact SM-2: first **Good** is 1 day, second **Good** is 6 days, first **Easy** is 4 days, **Again** / **Gender** requeue with interval `0`, ease floor `1.3`. Only `{ease, interval, reps, due}` is stored on each card.
- Sync is a whole `data.json` snapshot to private `german-flashcards-data`. Live file: **514 cards, ~141 KB**, settings `{direction: "en-de", sessionSize: 10}`, no review history.
- `snapshotFromDb()` stamps `updated_at: Date.now()` on every read, and `mergeSnapshots()` picks settings with `local.updated_at >= remote.updated_at`. Remote settings cannot win. Putting a new factor on top of that would make spacing changes bounce between phone and laptop.

Storing `srsIntervalFactor` once in settings, defaulting missing values to `1.0`, and applying it only to future successful reviews is the right model for this snapshot.

## Sequencing

Do this order:

1. Capture current interval outputs in tests (step 0), including first Easy = 4 days.
2. Fix settings freshness (step 2). This is the bug a second device actually feels.
3. Add the factor in `review()` / settings / parse path (steps 3–4).
4. Treat Close/Exit as a small UX pass (step 1). It is already present, not a missing feature.

Exit work is smaller than the plan’s wording. Close already returns home with grades saved and a fresh queue on the next Start. Worth doing: a clearer label, optional confirm only when cards remain, and a line in `TEST.md` (and `scripts/verify.mjs` if it should be automated). Skip `window.close()`.

Keep FSRS and review history off this slice.

## Gaps against the live system

### 1. `parseSnapshot` is a settings whitelist

It keeps only `direction` and `sessionSize`. Extra keys are dropped on every pull. Card objects pass through as-is. The plan’s “preserve unknown settings” is not true of today’s parser. Step 2/3 must extend `normalizeSettings()`, `parseSnapshot()`, `Snapshot.settings`, and `patchSettings()`. If an old service-worker build pulls a snapshot that already has `srsIntervalFactor` / `settings_updated_at` and then pushes, those fields disappear. Pass unknown settings through, or the PWA cache will clobber new fields.

### 2. Unload sync already cannot send the deck

`flushPush()` uses `fetch(..., { keepalive: true })`. Browsers cap that body at **64 KB**. The GitHub Contents payload is JSON plus **base64** of `data.json`, so the live 141 KB file is already over the cap. A grade made just before switching apps can stay local until the next mutation. An append-only history inside the same snapshot makes that worse. Measure keepalive payload size in step 5; better, stop using keepalive for this body (IndexedDB “pending push” flag) before growing the file.

### 3. Grades during an in-flight pull can miss GitHub

While `applySnapshot()` sets `applying`, `schedulePush()` returns without setting `dirty`. That is independent of the factor, but every new setting change and every grade sits on that path. Fix it in the same sync pass as settings freshness: always set `dirty`, only skip the immediate send.

### 4. Successful intervals need a floor of 1 day after scaling

`next = round(base × factor)` can become `0` (for example factor `0.5` on a 1-day base, depending on rounding). Interval `0` means due now, which is Again/Gender behavior. After scaling Hard/Good/Easy, use `Math.max(1, round(...))` and recompute `due` from that interval. The current scheduler already uses `Math.max(1, …)` for later SM-2 steps.

### 5. First Hard × 7 is a large jump

First Hard is 1 day today. Factor `7` makes it a week, same as first Good. That may be intended as a workload knob. The Settings preview should show Hard as well as Good/Easy so that is visible.

### 6. History needs an IndexedDB schema bump

`openDb()` uses `DB_VERSION = 1` and opens a new connection per operation. A review-event store is `DB_VERSION = 2`. Cache one connection and handle `onversionchange` before that migration, or Safari/Chrome can hang on the upgrade.

### 7. `deletedIds` is not a setting

Deletions already have per-id timestamps. `settings_updated_at` should move only when direction, session size, or the factor changes. Equal timestamps should keep the current local-wins rule and say so in a test.

## First implementation slice

Ship steps **0–4** as one product change:

- `settings_updated_at` on the settings row; `snapshotFromDb()` copies it rather than using read time.
- `srsIntervalFactor` in `[0.5, 7]`, default `1`, applied after the current SM-2 interval for Hard/Good/Easy only.
- Preview on Settings using the real numbers (`Good 1 → 7 days`, `Easy 4 → 28 days`).
- Tests for old snapshots, factor `1` / `7` / `0.5`, all five grades, bounds, and two-device settings merge.
- `npm test` and `npm run build` on that work. Pages CI still does not run `npm test`; add it there while touching the repo.

Leave the data repo alone; the next successful push will write the new settings keys into `data.json`.

Park FSRS until there is a real event log and a sync path that can carry it. For a 514-card A1/A2 deck, the interval factor plus an honest preview already does the workload job the plan describes.

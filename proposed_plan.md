# Proposed German flashcards improvement plan

This plan belongs to the `german-flashcards` PWA repository. The separate `german-flashcards-data` repository is only the private GitHub-backed data file and should not contain application plans or behavior changes.

## What the current app already does

The review screen already has a `Close` control that returns to the home screen, and the completion screen has `Back home`. Grades are written to IndexedDB before the next card is shown, and a sync push is scheduled after each grade. Therefore the first request is not a missing-button feature from scratch: it is a small UX and reliability pass around the existing control.

The current scheduler is a compact SM-2-style implementation in `src/srs.ts`:

- `Again` and `Gender` requeue immediately with interval `0`.
- First successful `Good` is 1 day; the next is 6 days.
- First `Easy` is currently 4 days, not 24 hours.
- Later intervals use the card's `ease`, with a lower bound of 1.3.
- Only the latest SRS snapshot is stored on each card; there is no review history.

The app stores the deck in IndexedDB locally and syncs a whole snapshot to the private data repository. That storage model should shape the scheduler rollout.

## Recommendation on spaced repetition

Use FSRS as the long-term direction, with **desired retention** as the primary algorithm setting. FSRS models difficulty, stability, and retrievability per card and is designed to choose intervals for a target probability of recall. A reasonable starting desired-retention value is 90%, with a conservative user-facing range around 80–95%.

Do not pretend that the current data can be optimized for FSRS yet: it contains only each card's latest state, not the review events needed to fit or evaluate personal parameters. First preserve a reliable review history, then evaluate FSRS against the current scheduler using actual workload and recall results.

The requested interval factor is still a reasonable short-term feature. It should be an explicit workload preference layered over the current base interval, not a replacement for FSRS's desired-retention setting or its parameters.

## Is the proposed data handling good?

**Mostly, with one important prerequisite.** Store the factor once in global settings, not on every card. A missing value should mean `1.0`, so existing exports and cards remain compatible:

```json
{
  "settings": {
    "direction": "en-de",
    "sessionSize": 10,
    "srsIntervalFactor": 1
  }
}
```

This is better than copying the factor into every card because it is a user/device preference and changing it should affect future reviews, not rewrite all existing due dates.

However, the current sync code has a settings bug: `snapshotFromDb()` sets the snapshot `updated_at` to `Date.now()` every time it reads local data. `mergeSnapshots()` then treats that fresh timestamp as proof that local settings are newer, so remote settings can never reliably win. Adding the factor before correcting this would make cross-device factor changes unsafe.

Fix settings conflict handling first. Preferred design:

- Keep card conflict timestamps and settings conflict metadata separate.
- Add a `settings_updated_at` timestamp that changes only when a setting changes.
- Merge settings using `settings_updated_at`, rather than the snapshot assembly time.
- Keep `snapshot.updated_at` as a transport/change timestamp, or rename/document it so it is not used as a settings version.
- Preserve the existing default for old snapshots that have no settings timestamp.

If a full metadata change is too large for the first pass, a simpler documented last-writer-wins setting timestamp is acceptable. Do not use the time at which a snapshot was read as a proxy for when its settings changed.

## Natural progression of implementation work

### 0. Establish the contract and fixtures

- Add focused fixtures for an old snapshot with no factor, a current snapshot with factor `1`, and a two-device settings merge.
- Document the current interval outputs for every grade and for new versus review cards.
- Decide whether the product wants to preserve the current first-Easy interval of 4 days or separately change it to 1 day. The factor should not silently change that baseline.
- Confirm supported browser behavior for leaving a review route; a PWA cannot reliably close its browser window.

**Done when:** the current behavior is captured by deterministic tests before changing it.

### 1. Finish the existing Exit/Close behavior

- Rename `Close` to `Exit session` if that is clearer to users; keep `Back home` on the completion screen.
- Return to home without losing grades already written locally.
- Reset the transient review queue and keyboard listener on exit.
- If there are unanswered cards, decide whether immediate exit is preferred or whether a small confirmation is needed. Do not use a confirmation that makes an empty/completed session harder to leave.
- Keep exit independent from the browser-window close API; route navigation is the reliable behavior.
- Add a click-path test for exiting mid-session, cancelling if confirmation is chosen, and starting a fresh session afterward.

**Acceptance:** a user can leave mid-session at any time, sees the updated local due count, and does not accidentally resume the old queue.

### 2. Fix settings synchronization before adding the factor

- Add independent settings freshness metadata as described above.
- Make `snapshotFromDb()` preserve stored settings freshness instead of generating a new freshness value on every read.
- Test settings changed on device A, pulled on device B, changed on both devices, and merged with equal timestamps.
- Keep card-level merge behavior unchanged unless a test demonstrates a related problem.
- Ensure old `data.json` snapshots still parse and receive default settings.

**Acceptance:** changing direction, session size, or the future factor on one device does not get overwritten simply because another device assembled a snapshot later.

### 3. Implement the interval factor in pure scheduling logic

Add `srsIntervalFactor` to `Settings`, `normalizeSettings()`, the snapshot type/parser, and the local/remote merge path. Use `1.0` when missing, invalid, non-finite, or outside the accepted range.

Initial behavior:

```text
base successful interval = current scheduler result
next interval = round(base successful interval × factor)
```

Recommended first range: `0.5` to `7.0`, with `1.0` as the default. Apply the factor only to successful review intervals (`Hard`, `Good`, `Easy`), after the current scheduler selects the base interval. Do not multiply `Again`, `Gender`, same-day learning, or relearning intervals. Apply the maximum interval cap after scaling if/when one exists.

The user's example is valid as a product rule: a 1-day base interval with factor `7` becomes about 1 week. In this app's current code, first `Good` is 1 day while first `Easy` is 4 days, so factor `7` currently produces 7 days for first Good and 28 days for first Easy. Resolve that baseline expectation explicitly rather than hiding it in the factor feature.

Tests must cover factor `1`, factor `7`, fractional factors, all five grades, new/review cards, rounding, invalid settings, bounds, and changing the factor without retroactively moving already-due cards.

### 4. Add the setting UI and interval preview

- Add a Settings control named `Review spacing` or `Interval multiplier`.
- Explain `1×` as the normal schedule and `7×` as roughly seven times the successful-review interval.
- Preview the actual current scheduler output, e.g. `Good: 1 day → 7 days` and `Easy: 4 days → 28 days`, rather than promising a generic 24-hour Easy interval.
- Persist changes through IndexedDB and sync them through the corrected settings metadata.
- Do not reschedule existing cards when the setting changes. The new factor applies at their next eligible review.
- Clearly distinguish interval multiplier from future FSRS desired retention.

**Acceptance:** changing the setting, reloading, and opening another configured device preserves the value and affects only future scheduling decisions.

### 5. Record review history

Before adopting FSRS, add an append-only review event model. Each event should include card id, timestamp, grade, prior SRS state, resulting SRS state, and scheduler version. Keep the current per-card snapshot for fast due-card queries and backward compatibility.

Decide how to sync history safely: a bounded event log in the snapshot is simple but grows the GitHub file; separate history files complicate the current Contents API flow. Measure the expected size before choosing. Never invent historical events when importing the existing data-only export.

### 6. Evaluate and, if appropriate, adopt FSRS

- Compare current SM-2-style scheduling and FSRS on real review history.
- Measure recall/forget rates, reviews per day, overdue behavior, and interval distribution.
- Start with FSRS defaults when there is insufficient personal history; optimize only when the history supports it.
- Use desired retention as the main FSRS control.
- Keep the interval factor as an explicitly documented optional workload modifier, or remove it if testing shows it undermines the desired-retention model.
- Make migration opt-in and version the SRS state; never silently rewrite the whole collection's due dates.

## Compatibility and rollout rules

- `srsIntervalFactor` missing from old local settings or `data.json` means `1.0`.
- Do not change the separate data repository as part of planning or app implementation unless the snapshot schema actually changes.
- Preserve unknown settings and card fields during import/export.
- Add migration and round-trip tests before changing the seed/export data.
- Run `npm test` and `npm run build` for every implementation step; use the existing click-path document for the PWA behavior.

## Research sources

- [Anki FAQ: What spaced repetition algorithm does Anki use?](https://faqs.ankiweb.net/what-spaced-repetition-algorithm) — describes SM-2 and FSRS, including desired retention and interval behavior.
- [FSRS tutorial](https://github.com/open-spaced-repetition/fsrs4anki/blob/main/docs/tutorial.md) — recommends roughly 80–95% desired retention, with 90% as a reasonable starting point, and warns that higher retention increases workload.
- [Free Spaced Repetition Scheduler](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler) — describes the difficulty/stability/retrievability model and available implementations.

## Definition of done

- Exit behavior is explicit, reliable, accessible, and covered by a click-path test.
- Settings sync has independent freshness semantics and no longer treats snapshot read time as settings recency.
- The interval factor is bounded, persisted, backward-compatible, tested, and demonstrated with the app's real current intervals.
- Existing due dates are not silently rewritten.
- FSRS adoption is based on review history and measured trade-offs rather than a blind scheduler swap.

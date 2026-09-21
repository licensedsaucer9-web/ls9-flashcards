# Code review — german-flashcards

**Scope:** `src/`, `scripts/`, `index.html`, `package.json`, `vite.config.ts`, `.github/workflows/pages.yml`, repo hygiene.
**State reviewed:** 31 tracked files, 5 commits, `master`. Last commit: *Add Gender grade and expand the seed deck.*
**Verified locally:**
- `npx tsc --noEmit` → clean
- `npm test` (`node --experimental-strip-types scripts/srs-csv-test.mjs`) → `srs-csv-test: ok`
- `git check-ignore token` → **not ignored** (see finding S1)

Maturity: **a genuinely working personal PWA.** The pure logic (SRS, CSV,
session sizing, merge) is tested, TypeScript is strict-ish, the PWA path is
covered by two Playwright scripts, and every interpolated value in `main.ts`
goes through `esc()`. The problems are one security incident waiting to happen
and a handful of sync/IndexedDB details.

---

## SECURITY — fix before anything else

### S1. A live GitHub token is sitting untracked and unignored in the repo root

There is a file named `token` in the project root (94 bytes) whose first line
matches the `ghp_` / `github_pat_` shape. `.gitignore` contains `node_modules`,
`dist`, `*.local`, `.DS_Store`, `playwright-report`, `test-results`,
`.lighthouseci`, `lh-report*` — but **not** `token`. `git check-ignore` confirms
it is not ignored.

One `git add -A`, one `git add .`, or a GUI "stage all" commits a live
credential to GitHub. The value is deliberately not reproduced here.

**Do now:**
1. Add `token`, `*.token`, `.env*`, `*.pat` to `.gitignore` (and consider
   ignoring the project root's dotfiles broadly).
2. Move the file out of the repo (e.g. to `~/.config/german-flashcards/token`).
3. **Rotate the PAT** on GitHub. Treat it as disclosed: it has existed in a
   working tree on a machine that runs other agents and tooling, and it may
   already be in a shell history, a backup, or an editor session file.
4. Confirm the history is clean: `git log --all -- token` and
   `git rev-list --all --objects | grep -w token`. If it ever was committed,
   rotate is mandatory even after removal.

### S2. The token is stored in `localStorage` in plaintext (accepted, but scope it)

`github.ts` persists the PAT in `localStorage` under
`german-flashcards.github`, and `main.ts` reads it into the Settings form. This
is a reasonable choice for a single-user local PWA and the UI copy is honest
about it ("Token stays in this browser"). Two notes:

- Any XSS is a full token compromise. Audited: all card / filter / config values
  pass through `esc()`, and the token itself is never interpolated into markup
  (the Settings field uses a static placeholder). Keep it that way — treat
  `main.ts` template strings as an XSS surface, since roughly a third of the app
  is innerHTML.
- `saveGithubConfig(defaultGithubConfig())` on "Disconnect" writes an empty
  token but leaves the storage key and the known-SHA key in place. Clear both.

---

## Bugs

### B1. Remote settings never apply — the merge always trusts the local snapshot

`mergeSnapshots()` picks settings by timestamp:

```ts
const settings = local.updated_at >= remote.updated_at ? local.settings : remote.settings
```

The only production caller builds `local` with `snapshotFromDb()`, which sets
`updated_at: Date.now()`. So `local.updated_at` is *now* and the remote is
always older — the remote branch is unreachable in the app. Change the review
direction or session size on the phone, sync, open the laptop: the laptop's
stale settings overwrite the phone's on the next pull and then push the
overwrite back.

The unit test passes because it constructs a remote snapshot with
`updated_at = now + 1000`, which the app never does.

*Fix:* decide settings separately from snapshot recency — e.g. keep settings
`updated_at` as its own field updated only when the setting actually changes —
or make settings a plain last-writer-wins with a device id, and state the
trade-off. At minimum, add a test that calls the real `snapshotFromDb()` path.

### B2. A mutation during an in-flight apply is never pushed

```ts
export function schedulePush(): void {
  if (applying || !isGithubConfigured()) return
  dirty = true
  ...
}
export async function pushToGithub(...) {
  if (!isGithubConfigured(cfg) || applying) return
```

`applySnapshot()` sets `applying` for the duration of the IndexedDB writes after
a pull. If the user grades a card in that window (a pull can take a second or
two), `schedulePush()` returns without setting `dirty`, and there is no later
retry. The grade is persisted locally but never reaches GitHub until some other
mutation happens. *Fix:* always set `dirty = true` and only skip the *immediate*
send; let the debounce timer fire after `applying` clears.

### B3. CSV import breaks on a UTF-8 BOM

`parseCsv()` does not strip a leading `\uFEFF`, and the header test is
`header[0] === 'de'`. An Excel-exported CSV (with BOM) fails the header check,
is not skipped, and the literal header row is imported as a card with
`de = "\uFEFFde"`, `en = "en"`. *Fix:* strip a leading BOM before parsing, and
skip a first row that matches the known header names.

### B4. `openDb()` opens a new IndexedDB connection on every operation

Every `getAllCards` / `putCard` / `deleteCard` calls `openDb()` and never closes
the connection. `renderHome`, `renderReview` and `renderDeck` each call several
of these per render. Browsers warn and eventually block `versionchange` once
enough connections are open, which makes a future schema migration hang.
*Fix:* memoise a single connection (cache the promise, handle
`onversionchange` by closing and re-opening).

### B5. `saveGithubConfig()` runs before validation

```ts
saveGithubConfig(cfg)            // persisted first
...
if (missing.length) { toast(...); return }
if (!/^(ghp_|github_pat_)/.test(cfg.token)) { toast(...); return }
```

A rejected token is already saved. Validate first, save second.

### B6. `pagehide` flush can silently drop a large snapshot

`flushPush()` calls `putRemote(..., { keepalive: true })`. `keepalive` request
bodies are capped at 64 KiB by the browser; a deck of a few hundred cards with
examples will exceed that, and the request is dropped without an error the user
can see. Since `dirty` lives only in memory, that change is lost until the next
mutation. *Fix:* only use `keepalive` when the serialised body is under the cap,
otherwise rely on the scheduled push and warn on unload, or store a
"pending push" marker in IndexedDB so the next boot re-sends.

### B7. `mergeSnapshots()` resolves ties in favour of the local device

`[...remote.cards, ...local.cards]` with `cardTouched(c) >= cardTouched(prev)`
means the local copy wins when `updated_at` is equal. Combined with per-device
wall clocks (`Date.now()`), a device with a fast clock wins every tie and can
look "newer" for grades made earlier. For two personal devices this is usually
harmless, but it is worth a comment so it is a decision rather than an accident.
A monotonic per-record revision would remove the ambiguity.

### B8. Minor: the session's "still due" and progress use a start-of-session snapshot

`renderReview()` captures `due`, `sessionTotal` and `leftover` once. A card
pulled in by a sync mid-session, or added on another device, is not reflected
until the session is restarted. Low impact; worth a note in `TEST.md`.

---

## Bad practices

- **No README.** `TEST.md` is excellent — a real click-path script with
  expected results — but it is not a landing page. Someone opening the repo
  (including future-you) gets no one-paragraph "what this is, how to run it, what
  it syncs". Add `README.md` and keep `TEST.md` as the acceptance script it is.
- **Tests are not wired into CI.** `.github/workflows/pages.yml` runs
  `npm ci && npm run build` and deploys. `npm test` (which needs no browser and
  runs in milliseconds) is not run, and neither `scripts/verify.mjs` nor
  `scripts/installable.mjs` has a `package.json` script. Add `test` to the
  workflow at minimum, and scripts for the two Playwright checks so they are
  discoverable.
- **Hand-rolled test harness.** `srs-csv-test.mjs` uses bare `assert()` and no
  runner, so there is no per-case reporting and no coverage signal. It covers the
  right things (SRS intervals, CSV dedupe, session sizing, merge) — a small
  runner or `node:test` would make failures readable and let CI report them.
- **Generated file without a header.** `scripts/build-seed-extra.py` (517 lines)
  generates `src/seed.ts` (545 lines), which is checked in and looks
  hand-editable. `seed.ts` has no "generated by" marker, so the two will drift
  and the next person will edit the generated file. Add a header comment and a
  `npm run seed:build` script.
- **`esc()` is manual and load-bearing.** Escaping is correct today, but every
  new template string is a chance to forget it. A single `html` tagged-template
  helper would make it hard to interpolate unescaped.
- **`package.json` pins future majors** (`typescript ~6.0.2`, `vite ^8.2.2`).
  Fine in this environment; note that CI uses `node-version: 22` while the dev
  machine runs Node 26 — align or state the supported range, since
  `--experimental-strip-types` behaviour has moved between Node majors.
- **Pages makes the app public.** The *data* repo is private (correct), but the
  app is deployed to GitHub Pages from a `master` push and the sync UI describes
  the private repo. Confirm that is intended and say so in the README; the token
  is per-browser, so the deployed app itself is harmless without it.
- **No LICENSE.**
- **`.gitignore` gaps** beyond S1: no `*.local` is present but `token`, `.env*`,
  editor dirs (`.vscode/`, `.idea/`) are missing.

---

## Suggested next steps (in order)

1. **Handle the token** (S1): gitignore it, move it out of the tree, rotate it,
   and verify history is clean. Nothing else on this list matters until this is
   done.
2. **Fix the settings merge** (B1) — it is the one bug a user will actually
   notice ("my phone settings keep reverting"), and the existing test gives
   false confidence because it exercises an unreachable branch.
3. **Fix the dirty-flag race** (B2) and the `keepalive` drop (B6) together: both
   are "a grade silently never reaches GitHub", which is the failure mode that
   erodes trust in the sync.
4. **Cache the IndexedDB connection** (B4) before any future schema migration.
5. **Strip the BOM and validate before saving** (B3, B5) — two small, clearly
   correct changes.
6. **Add a README** and wire `npm test` into the Pages workflow so the logic
   suite runs on every push.
7. **Mark `seed.ts` as generated** and add the script that regenerates it.
8. Then, if you want to take it further: a deck-stats screen (accuracy by card /
   tag) and a proper Anki-style interval preview would add the most user value
   for the least new surface area, since the SRS data is already local and
   synced.

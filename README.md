# LS9 Flashcards

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A local-first flashcard PWA (Vite + TypeScript), bundled with a German vocabulary deck and optional French and Spanish starters. It supports multiple decks, SM-2-style review, card editing, CSV import, and offline study. Decks lets you create empty decks, switch between them, and save study preferences per deck. Articles, word types, and tiers can be enabled for each subject.

**Release state, 2026-10-17:** The public site’s `release.json` reports `1.3.0` with the Firebase production backend; its source was verified at `0aaf08b78b33e1604c250e3cf751553b0e3c18bf`. This includes forgiving streaks, multi-deck creation/selection, per-deck preferences and cloud progress, and swipe tab navigation. Deck names, selection, optional-feature switches, and local deck deletion remain device-local; another device needs an extra deck's ID in its local list to select it. Version `1.2.0` added the word-type filter, and `1.1.0` added word-type badges; `1.0.0` shipped on 2026-10-07. A new account gets the built-in 514-word deck with no studied progress. Legacy studied data and old-device recovery are waived. Joakim verified the original production login, cancellation, per-account cards, and an offline grade that synced to a second client. The [rollout plan](docs/firebase-rollout-plan.md) records current operations and remaining evidence.

**Release evidence:** Additive production rules were verified on 2026-10-16.
The daily backup and off-machine copy jobs succeeded on 2026-10-17, and the
backup runner was updated to current master afterward. A successful version-2
dump/restore and installed-device/two-device feature acceptance remain separate
checks. See the [current operating record](docs/firebase-rollout-plan.md#current-operations--2026-10-17)
and [streak release checklist](docs/firebase-rollout-plan.md#forgiving-streaks--58).

**Historical Prod v1 scope (2026-10-04):** ship the single-deck app with reliable Google sync,
offline study, safe device migration and tested recovery. The
[tracking issue #33](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/33)
and [Prod v1 milestone](https://github.com/licensedsaucer9-web/ls9-flashcards/milestone/2)
link the original seven delivery gates. Multi-deck support shipped afterward;
interval controls, detailed review history, and FSRS remain outside the current app.

The project is named **LS9 Flashcards**. The [rename record](docs/rename.md)
lists the new repositories and URLs. Original storage/configuration identifiers
remain in use so existing progress is preserved.

On a Firebase build, Google sign-in gives each account its own schedule in Firestore; new accounts receive personal decks. Device-only study remains available. The app stores current SRS state and minimal streak activity, without detailed review history, an interval multiplier, or FSRS. See [the architecture](docs/architecture.md) for storage and sync guarantees.

The private [ls9-flashcards-data](https://github.com/licensedsaucer9-web/ls9-flashcards-data) repo is a frozen recovery snapshot of the legacy deck. This source has no GitHub data writer or token form. Keep `PUBLIC_SITE_DEPLOY_KEY` for Pages deployment.

## Available language decks

German–English has 514 cards. **Decks → Starter decks** explicitly adds and selects
French–English or Spanish–English, each with **567 cards** (356 nouns, 121 verbs,
90 adjectives), examples and independent frequency tiers. Repeated addition keeps
edits, deleted cards and progress. New accounts continue to start with German only.
The same-account starter ID is stable across devices; add that starter on each
device to select it, then let normal private per-deck sync restore cloud state.
Deck lists/names/selection remain local, and generic extra decks still need their
ID on another device. See [starter deck content, licensing, ranking and compatibility](docs/starter-decks.md),
including the **separate additive rules deployment required before production sync**.
French/Spanish deck content is CC BY-SA 4.0; application code remains MIT.

## Deck tiers

The 514 German built-in words are split into three tiers by how common they are, and you pick the
tier you want to study. Higher tiers include the lower ones.

| Tier | Words | Cumulative |
| --- | --- | --- |
| 1 | 100 | 100 |
| 2 | 150 | 250 |
| 3 | 264 | 514 |

The split is not hand-picked. Each word carries a `rank`: its position in a 50,000-word
German frequency list, and the tiers are the deck's own first 100, next 150, and the rest.
The rank is *not* used as a tier boundary directly, because the corpus list is dominated by
function words (`ich`, `sie`, `das`, `und`) that this deck deliberately leaves out — so the
deck's 100th word sits at corpus rank 455, not 100. Tier 1 therefore opens with
`haben`, `gut`, `sein`, `werden`, `können`, `sagen`, `machen`, `Mann`, `gehen`, `sehen`, and
ends at `groß` and `Hand`.

The list is [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)
(OpenSubtitles 2018, German). To rebuild it after editing the vocabulary:

```bash
curl -O https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/de/de_50k.txt
node scripts/rank-words.mjs de_50k.txt src/seed.ts > ranks.tsv
node scripts/apply-ranks.mjs ranks.tsv src/seed.ts
```

`scripts/tiers-test.mjs` then checks the boundaries against the real seed, including that
every tier 1 word is more common than every tier 2 word.

The tier and word-type choices sit on Review's home screen and are saved per deck, so decks and accounts can study different sizes. Decks keeps deck management, review direction and the per-deck Articles, Word types and Tiers switches.
Cards you add yourself have no rank and start in tier 3; the card editor has a tier box to move one.

You can review a tier even when it has zero cards due. **Review ahead** selects
the matching cards soonest due, up to your session-size limit. Your word-type
filter still applies and the due count stays at zero. When cards are due, sessions
remain due-only; All selects the entire eligible queue. Early reviews save and
update the schedule through the normal grading controls.

## Forgiving streaks

The quiet counter on Review and its session header shows your account-wide streak:
**🔥** means today's target is complete, **🌙** means today is still unfinished,
and **💀** shows how many reviews will repair earlier shortfalls. Tap the counter
for the rules. There are no streak notifications, reminders, emails or popups.

Every saved grade counts, including repeated cards, Again/Gender and review-ahead
cards. The first **10 reviews** cover today. Extra reviews repair missing work
from earlier days, with partial repair carried over. Two empty days need 20 extra
reviews: 30 today covers today and both missed days. A day with 7 reviews needs
only 3 extra. Extra reviews after repair is complete do not prepay future days.

Tracking begins with new reviews; a streak starts on the first day you reach 10.
Earlier days create no debt. Days follow the time zone of your first tracked
review and keep that zone when travelling. Offline activity and confirmed device
copies merge into the signed-in account; the counter may update after sync.

## Account

A Firebase build offers **Continue with Google** and **Study on this device**. New accounts get a personal German deck seeded from the bundled list and can create private extra decks. Mapped legacy accounts retain their assigned vocabulary deck. Each account has its own per-deck schedules; streak activity is shared across that account's decks. Signing in does not upload device-study data unless you confirm a copy; mapped legacy profiles use the separate recovery flow below. Two accounts cannot read each other’s progress. The public root serves the Firebase production build.

A profile name on an older install is local data only. It does not select a cloud account. The first launch of this build removes the saved GitHub token (`german-flashcards.github` and `german-flashcards.github.shas`) from this browser.

An older device with unsynced legacy work can copy a confirmed local profile after sign-in: **Settings → Recover a legacy profile on this device**. This requires the old app's origin and storage context; the isolated rehearsal uses separate storage. Keep the mapping private. See [the migration runbook](docs/firebase-migration.md).

## Develop

```bash
npm ci           # install the locked dependencies (Node 22 as used in CI)
npm run dev      # Vite dev server
npm run build    # type-check + production build
npm run preview  # serve the build on 127.0.0.1:4173
npm test         # unit tests; no emulator and no Chromium
npm run test:account-ui  # account/streak UI with synthetic auth and real IndexedDB in Chromium
npm run test:decks-ui    # Decks preferences, unsaved Cards filters, navigation and preservation
npm run test:rules  # Firestore rules, cloud sync, migration, and dump restore on the emulator (Java 21)
```

`npm test` covers SRS, CSV, tiers, Firestore document shapes, account helpers, record sync, the migration files, and Firestore dump restore. It does not call live Firebase or GitHub. Account UI and rules timezone checks need Chromium (`node node_modules/playwright-core/cli.js install chromium`, or `CHROME=/path/to/chromium`); `npm run test:rules` also needs Java 21.

`npm run dev` and `npm run build` without `VITE_SYNC_BACKEND=firebase` stay on this device: no Google sign-in and no cloud sync. For the isolated test-project preview:

```bash
npm run rehearsal:build
BASE=/ls9-flashcards-site/auth-spike/rehearsal/ npm run preview -- --outDir dist-rehearsal --port 4178 --strictPort
```

Open `http://127.0.0.1:4178/ls9-flashcards-site/auth-spike/rehearsal/`. This preview guards legacy import and uses separate storage. Real login requires an authorized hostname and a completed test assignment; guest study is available. See [the rehearsal guide](docs/firebase-rehearsal.md).

An ordinary `VITE_SYNC_BACKEND=firebase` build defaults to production. The released configuration seeds new accounts with empty progress; legacy studied-data import was waived. Use the isolated auth-test project for live rehearsals. Build/project configuration is in [Firebase setup](docs/firebase-setup.md).

## Public site

The app is published at <https://licensedsaucer9-web.github.io/ls9-flashcards-site/>.
Scan this code with your iPhone camera to open the app in Safari. A link opened from Messages can finish Google sign-in and then stay on the welcome screen; use Safari for that address. Each Google account gets its own copy of the deck.

![QR code for LS9 Flashcards](docs/app-qr.png)

This source repository and the [review-data repository](https://github.com/licensedsaucer9-web/ls9-flashcards-data)
stay private. The public `ls9-flashcards-site` repository contains only the
built site. Its `gh-pages` branch is the Pages source.

On a pull request and on a push to `master`, the private repository tests the
app, builds a Firebase client with `BASE=/ls9-flashcards-site/` and
`VITE_SYNC_BACKEND=firebase` into `dist-firebase`, and checks that the bundle
names `flashcards-ls9-prod`, contains no GitHub token or private key, and
still installs offline. CI also checks account UI, rules/cloud migration,
and the isolated rehearsal build. A push to `master` then publishes
`dist-firebase` with `rsync --delete`, removing obsolete root files while
retaining `auth-spike/` and `auth-spike-prod/`. Pull requests do not publish.
The private repository secret
`PUBLIC_SITE_DEPLOY_KEY` is a write-enabled SSH
deploy key for that public repository only. The workflow does not publish
from pull requests and does not deploy Firestore rules.

The current source and published artifact version is `1.3.0`. **Settings → Install** shows
the running version and source revision, including offline. From a clean source
checkout, `npm run release:build` prepares `dist-firebase` with production
configuration; `npm run release:verify` checks its exact file inventory. CI
retains this artifact after all checks, including `.nojekyll`. Master
publication uses that same `dist-firebase` build. See the
[candidate procedure](docs/firebase-setup.md#prepare-and-verify-a-release-candidate).

## Upgrade an older iPhone Home Screen installation

The current app is the Firebase client at the new public URL. The old
`german-flashcards-site` Pages URL was retired on 2026-10-17: its published app
and redirect were replaced by a 404-only deployment and its repository is
archived. It no longer supplies a supported redirect.
Use bookmarks and Home Screen icons created from the current URL. Studied
progress from the old client is not imported. See the [retirement record](docs/rename.md#old-site-retirement-2026-10-17).

1. Open the new public URL in Safari and confirm the Firebase build under Settings → Install. Choose **Continue with Google** or **Study on this device**. A new account starts with an unstudied personal deck; no legacy schedule is imported.
2. Add the new URL to the Home Screen. An old icon targets the retired scope and can retain separate installed-app storage or a cached offline client; opening it does not upgrade it to the new Firebase client. Keep any old installation/data you still want to preserve until you deliberately retire it.
3. Check the current installation's offline save and second-device acknowledgement using the backup check below.

Legacy device recovery and studied-data import were waived for the 2026-10-07 release. The migration runbook and unpublished same-context bridge are retained for explicit future recovery work; they are not mandatory upgrade steps. Rollback after production Firebase study must use a Firebase-compatible client and preserve its data.

## iPhone backup check

The app saves each change to IndexedDB first. **Saved on this device** means Firestore has not acknowledged the latest local changes. **Synced** means this account’s pending records were acknowledged. The status does not say Synced while a grade is still pending. The Home Screen app retries while open, at the next launch, and when it returns to the foreground. Switching apps does not attempt a background upload.

To check a new release on an iPhone:

1. Open the Home Screen app, sign in, and wait for **Synced**.
2. Turn on Airplane Mode, review one card, and immediately switch to another app. Reopen Flashcards. The changed review must still be there, and the line must still say **Saved on this device**.
3. Turn Airplane Mode off and return to Flashcards. Wait for **Synced**, then open a second signed-in device and confirm the review. Use **Sync now** in Settings to retry manually.
4. To check deletion without losing a real card, create a disposable card, wait for **Synced**, then delete it. After the second device syncs, the test card should remain absent.

A private Firestore export is described in [Firebase setup](docs/firebase-setup.md#private-firestore-backup). It does not need Blaze. A user timer runs it daily and keeps 14 dumps. The matching [restore command](docs/firebase-setup.md#restore-a-firestore-dump) writes that dump only to an isolated target and does not restore Auth, this device's IndexedDB, rules, or hosting. The legacy data repo can be [verified without changing it](https://github.com/licensedsaucer9-web/ls9-flashcards-data#verify-an-existing-backup-without-changing-it), but cannot back up later Firebase reviews.

## Other documentation

- [Rollout plan](docs/firebase-rollout-plan.md): completed milestones, remaining production gates, and later product direction.
- [Architecture](docs/architecture.md): account/deck boundaries, persistence, merge rules, and current limits.
- [Rename record](docs/rename.md): repository/URL mapping and compatibility for old installations.
- [Firebase setup](docs/firebase-setup.md): projects, build configuration, rules, private operator files, and backup command.
- [Migration runbook](docs/firebase-migration.md): immutable snapshot export, baseline, Admin import, and confirmed device recovery.
- [Rehearsal runbook](docs/firebase-rehearsal.md): isolated test preview, preflight, and preview checks.
- [Live import evidence](docs/issue-24-status.md): saved aggregate #24 readback and zero-write repeat results.
- [TEST.md](TEST.md): manual acceptance and automated check commands.

The [archived multi-deck proposal](docs/archive/multi-deck-proposal-20261010.md) and [mobile-store proposal](docs/archive/mobile-store-proposal-20261010.md) retain dated, unadopted designs. They are not active implementation plans. The rollout plan remains the operational plan; the archive preserves evidence without reopening completed or waived migration work.

## License

MIT — © 2026 licensedsaucer9-web. See [LICENSE](LICENSE). French/Spanish starter content is CC BY-SA 4.0; see [attribution](docs/starter-decks.md#content-and-ranking-provenance).

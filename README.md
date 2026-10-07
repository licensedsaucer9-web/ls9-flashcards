# LS9 Flashcards

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A local-first flashcard PWA (Vite + TypeScript), currently bundled with a German vocabulary deck. It supports frequency tiers, SM-2-style review, card editing, CSV import, and offline study. The longer-term goal is multiple decks on different subjects; the current app assigns one deck per account and has no deck picker.

**Release state, 2026-10-07:** Joakim authorized publication of the Firebase client. A new account gets the built-in 514-word deck with no studied progress. Legacy studied data and old-device recovery are waived (#34, #36, and #37 closed). Master CI publishes `dist-firebase` to the public site after the test gates. Login and offline acceptance on real devices remain #39. The [rollout plan](docs/firebase-rollout-plan.md) is the only active plan.

**Prod v1 scope:** ship the current single-deck app with reliable Google sync,
offline study, safe device migration and tested recovery. The
[tracking issue #33](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/33)
and [Prod v1 milestone](https://github.com/licensedsaucer9-web/ls9-flashcards/milestone/2)
link the seven delivery gates. Multi-deck support and scheduler changes remain
outside this release.

The project is named **LS9 Flashcards**. The [rename record](docs/rename.md)
lists the new repositories and URLs. Original storage/configuration identifiers
remain in use so existing progress is preserved.

On a Firebase build, Google sign-in gives each account its own schedule in Firestore; new accounts receive personal decks. Device-only study remains available. The app stores current SRS state, without review history, an interval multiplier, or FSRS. See [the architecture](docs/architecture.md) for storage and sync guarantees.

The private [ls9-flashcards-data](https://github.com/licensedsaucer9-web/ls9-flashcards-data) repo remains the legacy data source until final cutover, then stays as a frozen recovery snapshot. Current source has no GitHub data writer or token form; the published legacy client still does. Revoke the data-write token only after every active device has moved and its pending work is recovered. Keep `PUBLIC_SITE_DEPLOY_KEY` for Pages deployment.

## Deck tiers

The 514 built-in words are split into three tiers by how common they are, and you pick the
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

The tier is part of your account settings, so two accounts can study different sizes.
Cards you add yourself have no rank and start in tier 3; the card editor has a tier box to move one.

## Account

A Firebase build offers **Continue with Google** and **Study on this device**. New accounts get personal decks seeded from the bundled list; mapped legacy accounts share their assigned vocabulary deck. Each account has its own schedule. Signing in does not upload device-study data unless you confirm a copy; mapped legacy profiles use the separate recovery flow below. Two accounts cannot read each other’s progress. The public root does not serve this build yet.

A profile name on an older install is local data only. It does not select a cloud account. The first launch of this build removes the saved GitHub token (`german-flashcards.github` and `german-flashcards.github.shas`) from this browser.

An older device with unsynced legacy work can copy a confirmed local profile after sign-in: **Settings → Recover a legacy profile on this device**. This requires the old app's origin and storage context; the isolated rehearsal uses separate storage. Keep the mapping private. See [the migration runbook](docs/firebase-migration.md).

## Develop

```bash
npm ci           # install the locked dependencies (Node 22 as used in CI)
npm run dev      # Vite dev server
npm run build    # type-check + production build
npm run preview  # serve the build on 127.0.0.1:4173
npm test         # unit tests; no emulator and no Chromium
npm run test:account-ui  # account UI with synthetic auth and real IndexedDB in Chromium
npm run test:rules  # Firestore rules, cloud sync, migration, and dump restore on the emulator (Java 21)
```

`npm test` covers SRS, CSV, tiers, Firestore document shapes, account helpers, record sync, the migration files, and Firestore dump restore. It does not call live Firebase or GitHub. Browser checks need Chromium (`node node_modules/playwright-core/cli.js install chromium`, or `CHROME=/path/to/chromium`); `npm run test:rules` also needs Java 21.

`npm run dev` and `npm run build` without `VITE_SYNC_BACKEND=firebase` stay on this device: no Google sign-in and no cloud sync. For the isolated test-project preview:

```bash
npm run rehearsal:build
BASE=/ls9-flashcards-site/auth-spike/rehearsal/ npm run preview -- --outDir dist-rehearsal --port 4178 --strictPort
```

Open `http://127.0.0.1:4178/ls9-flashcards-site/auth-spike/rehearsal/`. This preview guards legacy import and uses separate storage. Real login requires an authorized hostname and a completed test assignment; guest study is available. See [the rehearsal guide](docs/firebase-rehearsal.md).

An ordinary `VITE_SYNC_BACKEND=firebase` build defaults to production. Do not sign an unmigrated owner into it before the Admin import has preassigned the legacy deck. Build/project configuration is in [Firebase setup](docs/firebase-setup.md).

## Public site

The app is published at <https://licensedsaucer9-web.github.io/ls9-flashcards-site/>.
Scan this code with your iPhone camera to open the app in Safari:

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

The prepared candidate version is `1.0.0-rc.1`. **Settings → Install** shows
the running version and source revision, including offline. From a clean source
checkout, `npm run release:build` prepares `dist-firebase` with production
configuration; `npm run release:verify` checks its exact file inventory. CI
retains this artifact after all checks, including `.nojekyll`. Master
publication uses that same `dist-firebase` build. See the
[candidate procedure](docs/firebase-setup.md#prepare-and-verify-a-release-candidate).

## Upgrade an older iPhone Home Screen installation

Do this after production import/device recovery and publication are recorded. The new public URL is the Firebase cutover destination; the old URL currently serves the compatibility client described in [the rename record](docs/rename.md). Check Safari and each installed Home Screen app separately; they can hold different local work. Keep each source installation until its pending progress is recovered and verified.

1. Open the public URL in Safari, confirm the Firebase build, choose **Continue with Google**, and compare the imported schedule with a trusted device.
2. Open the existing Home Screen installation and confirm it has received the Firebase build. If it still serves an older build or uses a different old URL, preserve it and follow the same-context recovery procedure before replacing its icon. The prepared bridge stays unpublished until that recovery operation; see the migration runbook.
3. For each storage context with outstanding legacy work, use the confirmed mapping and **Recover a legacy profile on this device**, then verify its Firestore acknowledgement and second-device readback.
4. Turn on Airplane Mode, review one card, and leave the app. Reopen it. The grade is still there and the status stays **Saved on this device** until you are online again. Then wait for **Synced**, and open a second device signed into the same account.

Replace an old icon only after those checks. Revoke the data-repo write token only after every active device is on the Firebase build and its pending work is acknowledged.

Before production Firebase study exists, keep or restore the previously published artifact if cutover fails. Current `master` is not that legacy writer. Once production Firebase progress exists, rollback uses a Firebase-compatible client and retains its data.

## iPhone backup check

The app saves each change to IndexedDB first. **Saved on this device** means Firestore has not acknowledged the latest local changes. **Synced** means this account’s pending records were acknowledged. The status does not say Synced while a grade is still pending. The Home Screen app retries while open, at the next launch, and when it returns to the foreground. Switching apps does not attempt a background upload.

To check a new release on an iPhone:

1. Open the Home Screen app, sign in, and wait for **Synced**.
2. Turn on Airplane Mode, review one card, and immediately switch to another app. Reopen Flashcards. The changed review must still be there, and the line must still say **Saved on this device**.
3. Turn Airplane Mode off and return to Flashcards. Wait for **Synced**, then open a second signed-in device and confirm the review. Use **Sync now** in Settings to retry manually.
4. To check deletion without losing a real card, create a disposable card, wait for **Synced**, then delete it. After the second device syncs, the test card should remain absent.

A private Admin SDK export of Firestore is described in [Firebase setup](docs/firebase-setup.md#private-firestore-backup). It does not need Blaze and is not automatic. The matching [restore command](docs/firebase-setup.md#restore-a-firestore-dump) writes that dump only to an isolated target and does not restore Auth, this device's IndexedDB, rules, or hosting. Backup cadence remains rollout work. The legacy data repo can be [verified without changing it](https://github.com/licensedsaucer9-web/ls9-flashcards-data#verify-an-existing-backup-without-changing-it), but cannot back up later Firebase reviews.

## Other documentation

- [Rollout plan](docs/firebase-rollout-plan.md): completed milestones, remaining production gates, and later product direction.
- [Architecture](docs/architecture.md): account/deck boundaries, persistence, merge rules, and current limits.
- [Rename record](docs/rename.md): repository/URL mapping and compatibility for old installations.
- [Firebase setup](docs/firebase-setup.md): projects, build configuration, rules, private operator files, and backup command.
- [Migration runbook](docs/firebase-migration.md): immutable snapshot export, baseline, Admin import, and confirmed device recovery.
- [Rehearsal runbook](docs/firebase-rehearsal.md): isolated test preview, preflight, and preview checks.
- [Live import evidence](docs/issue-24-status.md): saved aggregate #24 readback and zero-write repeat results.
- [TEST.md](TEST.md): manual acceptance and automated check commands.

Completed plans, superseded proposals, and old reviews have been removed from the working tree; Git history retains them. Remaining proposal ideas are summarized in the single rollout plan.

## License

MIT — © 2026 licensedsaucer9-web. See [LICENSE](LICENSE).

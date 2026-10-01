# german-flashcards

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

German flashcards as a local-first PWA (Vite + TypeScript). The public site signs in with Google. Each account’s schedule and deck live in Firestore project `flashcards-ls9-prod`. A visit can also study on this device without an account. The app does not store a review event history.

The private repo [german-flashcards-data](https://github.com/licensedsaucer9-web/german-flashcards-data) stays in place as a frozen recovery snapshot. The app no longer asks for a token or writes that repo. Revoke its write token only after the devices you still use are on this build. Keep `PUBLIC_SITE_DEPLOY_KEY` for the Pages deploy.

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

The public build offers **Continue with Google** and **Study on this device**. A Google account gets its own deck, seeded from the bundled word list, and its own schedule. Signing in does not upload cards already on the device unless you confirm that copy in Settings. Two accounts cannot read each other’s progress.

A profile name on an older install is local data only. It does not select a cloud account. The first launch of this build removes the saved GitHub token (`german-flashcards.github` and `german-flashcards.github.shas`) from this browser.

An older device that still has reviews which never reached Firestore can copy one confirmed local profile after sign-in: **Settings → Recover a legacy profile on this device**. The mapping file stays on your machine. See [the migration rehearsal](docs/firebase-migration.md).

## Develop

```bash
npm ci           # install the locked dependencies (Node 22 as used in CI)
npm run dev      # Vite dev server
npm run build    # type-check + production build
npm run preview  # serve the build on 127.0.0.1:4173
npm test         # unit tests; no emulator and no Chromium
npm run test:rules  # Firestore rules, cloud sync, and migration on the emulator (Java 21)
```

`npm test` covers SRS, CSV, tiers, Firestore document shapes, account helpers, record sync, and the migration files. It does not call Firebase or GitHub. `npm run test:rules` needs Java 21 and Chromium (`node node_modules/playwright-core/cli.js install chromium`, or `CHROME=/path/to/chromium`).

`npm run dev` and `npm run build` without `VITE_SYNC_BACKEND=firebase` stay on this device: no Google sign-in and no cloud sync. For a local preview of the **public deployment path**:

```bash
BASE=/german-flashcards-site/ VITE_SYNC_BACKEND=firebase npm run build
BASE=/german-flashcards-site/ npm run preview
```

## Public site

The app is published at <https://licensedsaucer9-web.github.io/german-flashcards-site/>.
Scan this code with your iPhone camera to open the app in Safari:

![QR code for the German Flashcards app](docs/app-qr.png)

This source repository and the [review-data repository](https://github.com/licensedsaucer9-web/german-flashcards-data)
stay private. The public `german-flashcards-site` repository contains only the
built site. Its `gh-pages` branch is the Pages source.

On a pull request, the private repository tests the app, builds it with
`BASE=/german-flashcards-site/` and `VITE_SYNC_BACKEND=firebase`, and checks
that the bundle names `flashcards-ls9-prod`, contains no GitHub token or
private key, and still installs offline. A push to `master` copies that tested
build to the public repository with `rsync --delete`. The private repository
secret `PUBLIC_SITE_DEPLOY_KEY` is a write-enabled SSH deploy key for that
public repository only. The workflow does not publish from pull requests and
does not deploy Firestore rules.

## Move an older iPhone Home Screen installation

The new site has a different URL. Treat it as a new installation. An older Home Screen icon can still hold local reviews and a saved token; this build clears that token and does not upload those reviews until you sign in and confirm the copy.

1. Open the new public URL in Safari, choose **Continue with Google**, and compare the imported schedule with the device you already trust.
2. Add the site to the Home Screen as its own icon. Keep the old icon until that comparison matches.
3. On each older device that still has reviews, sign in with the same Google account and use **Recover a legacy profile on this device** if those reviews are not already in the account.
4. Turn on Airplane Mode, review one card, and leave the app. Reopen it. The grade is still there and the status stays **Saved on this device** until you are online again. Then wait for **Synced**, and open a second device signed into the same account.

Remove the old icon after those checks. Revoke the data-repo write token only after every device you still use is on this build.

If the public cutover is wrong before anyone has studied on Firebase, republish the previous `master` build. After Firebase progress exists, publish a Firebase build only. This source no longer contains a GitHub writer, so a new build cannot push `german-flashcards-data`.

## iPhone backup check

The app saves each change to IndexedDB first. **Saved on this device** means Firestore has not acknowledged the latest local changes. **Synced** means this account’s pending records were acknowledged. The status does not say Synced while a grade is still pending. The Home Screen app retries while open, at the next launch, and when it returns to the foreground. Switching apps does not attempt a background upload.

To check a new release on an iPhone:

1. Open the Home Screen app, sign in, and wait for **Synced**.
2. Turn on Airplane Mode, review one card, and immediately switch to another app. Reopen Flashcards. The changed review must still be there, and the line must still say **Saved on this device**.
3. Turn Airplane Mode off and return to Flashcards. Wait for **Synced**, then open a second signed-in device and confirm the review. Use **Sync now** in Settings to retry manually.
4. To check deletion without losing a real card, create a disposable card, wait for **Synced**, then delete it. After the second device syncs, the test card should remain absent.

A private Admin SDK export of Firestore is described in [docs/firebase-setup.md](docs/firebase-setup.md). It does not need the Blaze plan and it does not run by itself. The frozen data repo remains a separate recovery snapshot: [verify an existing backup without changing it](https://github.com/licensedsaucer9-web/german-flashcards-data#verify-an-existing-backup-without-changing-it).

## Other documentation

- [Firebase setup](docs/firebase-setup.md) records the production project and the private Admin SDK export command.
- [Firebase migration plan](docs/firebase-migration-plan.md) is the original rollout plan. Where a closed issue disagrees with it, the issue result wins.
- [Firebase migration rehearsal](docs/firebase-migration.md) covers the local snapshot importer and recovery of each device's unsynced legacy profile.
- [TEST.md](TEST.md) is the manual click path for review, import, installability, and sign-in.
- [REVIEW.md](REVIEW.md) is an earlier review. Its GitHub-token notes describe the build this cutover replaced.
- [plan.md](plan.md) and [plans_review.md](plans_review.md) document completed reliability work; [proposed_plan.md](proposed_plan.md) and [proposed_plan_review.md](proposed_plan_review.md) preserve feature proposals. Their historical observations are labeled at the top of each file.

## License

MIT — © 2026 licensedsaucer9-web. See [LICENSE](LICENSE).

# german-flashcards

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

German flashcards as a local-first PWA (Vite + TypeScript). Current card progress and settings are backed up to a separate private repo, [german-flashcards-data](https://github.com/licensedsaucer9-web/german-flashcards-data). The app does not store a review event history.

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

The tier is a per-profile choice and is part of your settings, so two people sharing a
repository can study different sizes. Cards you add yourself have no rank and start in
tier 3; the card editor has a tier box to move one.

## Profiles

Several people can use the same app and the same repository. Each profile keeps its own
review schedule, tier and session settings, and nothing else.

- **On a device**, each profile gets its own IndexedDB database (`german-flashcards:<name>`),
  so switching profiles on one device cannot mix their progress up.
- **In the repository**, the word list is shared and lives in one file, while each profile's
  schedule lives in its own file under `users/`:

  ```
  data.json          shared vocabulary: every card, no review state
  users/joakim.json  Joakim's schedule, tier and session settings
  users/anna.json    Anna's
  ```

  A review only rewrites that profile's file, and a vocabulary edit only rewrites
  `data.json`, so two people studying at the same time never overwrite each other.
- Profiles that already have a file are discovered from the repository, so a new device can
  switch to an existing profile after **Sync now**.

Add and switch profiles in **Settings → Profile**. On the first launch after the upgrade,
the existing single-profile data is claimed by a `joakim` profile automatically, both on
the device and in the repository: the old `data.json` is rewritten as a v2 deck file and the
schedule it held is moved to `users/joakim.json`. There is no separate migration step, and
nothing is discarded.

## Develop

```bash
npm ci           # install the locked dependencies (Node 22 as used in CI)
npm run dev      # Vite dev server
npm run build    # type-check + production build
npm run preview  # serve the build on 127.0.0.1:4173
npm test         # unit and Chromium sync tests
```

`npm test` runs four suites: SRS and CSV, merge edge cases, tier and profile logic, and a
Chromium test of IndexedDB persistence and mocked GitHub sync across the split deck and
per-profile files; it never needs a live token. Install Chromium with
`node node_modules/playwright-core/cli.js install chromium` if needed, or set
`CHROME=/path/to/chromium`.

For a local preview of the **public deployment path**, use the same base for
both build and preview:

```bash
BASE=/german-flashcards-site/ npm run build
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
`BASE=/german-flashcards-site/`, and checks its manifest, service worker,
offline reload, and public files. A push to `master` also copies that tested
build to the public repository. The private repository secret
`PUBLIC_SITE_DEPLOY_KEY` is a write-enabled SSH deploy key for that public
repository only. The workflow does not publish from pull requests.

## Move an older iPhone Home Screen installation

The new site has a different URL. Treat it as a new installation; do not rely
on the old Home Screen app's local cards, login token, or service worker moving
to it automatically.

1. Open the old app online and wait for **Backed up**. In the private data
   repository, confirm that `data.json` has a recent update containing your
   review progress. If the old app says it is waiting to back up, keep using it
   until that is resolved.
2. Open the new public URL in Safari and add it to the Home Screen as a separate
   icon. Keep the old icon for now.
3. In the new app's Settings, connect the same private
   `german-flashcards-data` repository. Use a token with Contents read/write
   access to that repository only. Wait for **Backed up** and compare several
   cards and their review progress with the old app.
4. Check that the new app opens after switching to Airplane Mode. Return online
   and confirm a new review reaches the private repository. Remove the old icon
   only after both checks pass.

## iPhone backup check

The app saves each change to IndexedDB first. **Saved on this device · waiting to
back up** means GitHub has not acknowledged the latest local changes yet.
**Backed up** means a successful GitHub sync found no pending local changes,
or GitHub acknowledged the upload. The Home Screen app retries while open, at
the next launch, and when it returns to the foreground. Switching apps does
not attempt a background upload.

To check a new release on an iPhone:

1. Open the Home Screen app, connect the private data repository in Settings,
   and wait for **Backed up**.
2. Turn on Airplane Mode, review one card, and immediately switch to another app.
   Reopen Flashcards. The changed review must still be there and show that backup
   is pending.
3. Turn Airplane Mode off and return to Flashcards. Wait for **Backed up**, then
   inspect `users/<profile>.json` in the private repo or open a second device and
   confirm that the review arrived. Use **Sync now** in Settings to retry manually.
4. To check deletion sync without losing a real card, create a disposable card,
   wait for **Backed up**, then delete it. After reopening and syncing a second
   device, the test card should remain absent. Built-in-card deletion and
   reseeding are covered by the automated browser tests.

For a read-only backup verification or recovery drill, see the private
[data repository guide](https://github.com/licensedsaucer9-web/german-flashcards-data#verify-an-existing-backup-without-changing-it).

## Other documentation

- [Firebase migration plan](docs/firebase-migration-plan.md) describes the proposed move to Google sign-in and private cloud sync, including onboarding, existing-data migration, and rollout checks.
- [TEST.md](TEST.md) is the manual click path for review, import, installability, and sync.
- [REVIEW.md](REVIEW.md) records the current project state and known limitations.
- [plan.md](plan.md) and [plans_review.md](plans_review.md) document completed reliability work; [proposed_plan.md](proposed_plan.md) and [proposed_plan_review.md](proposed_plan_review.md) preserve feature proposals. Their historical observations are labeled at the top of each file.

## License

MIT — © 2026 licensedsaucer9-web. See [LICENSE](LICENSE).

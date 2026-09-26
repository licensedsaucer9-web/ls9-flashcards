# german-flashcards

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

German flashcards as a local-first PWA (Vite + TypeScript). Current card progress and settings are backed up to a separate private repo, [german-flashcards-data](https://github.com/licensedsaucer9-web/german-flashcards-data). The app does not store a review event history.

## Develop

```bash
npm ci           # install the locked dependencies (Node 22 as used in CI)
npm run dev      # Vite dev server
npm run build    # type-check + production build
npm run preview  # serve the build on 127.0.0.1:4173
npm test         # unit and Chromium sync tests
```

`npm test` includes Chromium tests of IndexedDB persistence and mocked GitHub
sync; it never needs a live token. Install Chromium with
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
   inspect `data.json` in the private repo or open a second device and confirm
   that the review arrived. Use **Sync now** in Settings to retry manually.
4. To check deletion sync without losing a real card, create a disposable card,
   wait for **Backed up**, then delete it. After reopening and syncing a second
   device, the test card should remain absent. Built-in-card deletion and
   reseeding are covered by the automated browser tests.

For a read-only backup verification or recovery drill, see the private
[data repository guide](https://github.com/licensedsaucer9-web/german-flashcards-data#verify-an-existing-backup-without-changing-it).

## Other documentation

- [TEST.md](TEST.md) is the manual click path for review, import, installability, and sync.
- [REVIEW.md](REVIEW.md) records the current project state and known limitations.
- [plan.md](plan.md) and [plans_review.md](plans_review.md) document completed reliability work; [proposed_plan.md](proposed_plan.md) and [proposed_plan_review.md](proposed_plan_review.md) preserve feature proposals. Their historical observations are labeled at the top of each file.

## License

MIT — © 2026 licensedsaucer9-web. See [LICENSE](LICENSE).

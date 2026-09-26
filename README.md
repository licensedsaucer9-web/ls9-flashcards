# german-flashcards

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

German flashcards as a local-first PWA (Vite + TypeScript). The SRS review history lives in a separate private repo, [german-flashcards-data](https://github.com/licensedsaucer9-web/german-flashcards-data).

## Develop

```bash
npm run dev      # Vite dev server
npm run build    # type-check + production build
npm run preview  # serve the build on 127.0.0.1:4173
npm test         # unit and Chromium sync tests
```

`npm test` also runs a Chromium test of IndexedDB persistence and GitHub sync. Set
`CHROME=/path/to/chromium` if Chromium is not installed at `/usr/bin/chromium`.

## Public site

The app is published at <https://licensedsaucer9-web.github.io/german-flashcards-site/>.
This source repository and the [review-data repository](https://github.com/licensedsaucer9-web/german-flashcards-data)
stay private. The public `german-flashcards-site` repository contains only the
built site. Its `gh-pages` branch is the Pages source.

On a pull request, the private repository tests the app, builds it with
`BASE=/german-flashcards-site/`, and checks its manifest, service worker,
offline reload, and public files. A push to `master` also copies that tested
build to the public repository. The private repository secret
`PUBLIC_SITE_DEPLOY_KEY` is a write-enabled SSH deploy key for that public
repository only. The workflow does not publish from pull requests.

## Move an existing iPhone Home Screen app

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
back up** means GitHub has not acknowledged it yet; **Backed up** appears only
after GitHub confirms the upload. The Home Screen app retries while open, at the
next launch, and when it returns to the foreground. Switching apps does not
attempt a background upload.

To check a new release on an iPhone:

1. Open the Home Screen app, connect the private data repository in Settings,
   and wait for **Backed up**.
2. Turn on Airplane Mode, review one card, and immediately switch to another app.
   Reopen Flashcards. The changed review must still be there and show that backup
   is pending.
3. Turn Airplane Mode off and return to Flashcards. Wait for **Backed up**, then
   inspect `data.json` in the private repo or open a second device and confirm
   that the review arrived. Use **Sync now** in Settings to retry manually.
4. Delete a built-in card, close and reopen the app twice, and sync the second
   device. The deleted card must remain absent on both devices.

## License

MIT — © 2026 licensedsaucer9-web. See [LICENSE](LICENSE).

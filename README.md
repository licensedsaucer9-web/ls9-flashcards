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

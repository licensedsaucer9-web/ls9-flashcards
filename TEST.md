# German Flashcards — click path

The public site signs in with Google and does not ask for a token. Device-copy of an older local profile is in
[the migration rehearsal](docs/firebase-migration.md).

App lives in this folder. IndexedDB is the offline cache. A fresh **Study on this device** visit seeds 514 A1/A2 cards, split into three tiers. Existing decks gain missing seed cards on launch without resetting SRS on cards you already have. Use a disposable browser profile for this click path so the tests do not change your personal deck.

`npm run dev` stays on this device. To click through the public build locally:

```bash
BASE=/german-flashcards-site/ VITE_SYNC_BACKEND=firebase npm run build
BASE=/german-flashcards-site/ npm run preview
```

Open `http://127.0.0.1:4173/german-flashcards-site/`. The first screen offers **Continue with Google** and **Study on this device**.

## Run

```bash
npm ci
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173/).

For the installable PWA (service worker):

```bash
npm run build
npm run preview
```

Open the preview URL (usually http://localhost:4173/).
If checking the public site's subpath locally, set
`BASE=/german-flashcards-site/` for **both** the build and preview commands and
open `http://localhost:4173/german-flashcards-site/`.

## 1. Tiers

1. Home shows a **Deck tier** row: **Tier 1 / Tier 2 / Tier 3**, each with its word count and due count. Tier 1 is selected on a fresh profile.
2. The header reads **Due now · Tier 1 · 100 words**. The due count is at most 100, not 514.
3. Tap **Tier 2**. The count rises to 250 words and the due count cannot go down — tier 2 includes tier 1.
4. Tap **Tier 3** for all 514. The footnote under the chips explains the tier.
5. **Deck** has the same tier row, so you can browse a narrow set and widen it. Every row shows a `T1` / `T2` / `T3` badge.
6. Tier 1 opens with `haben`, `gut`, `sein`, `werden`, `können` and closes at `groß` / `Hand`. Spot-check a few words against the list in the README.

## 2. Review loop (due queue only)

1. Home shows a large **due** count (at most the selected tier's size, 100 on tier 1), a **This session** cap (10 / 20 / 30 / All, plus custom), and **Start N of M**.
2. The Deck and Settings tabs are in the bottom bar; home is not a full deck list.
3. Pick a session size (suggested chip is marked). Tap **Start**. Review only that many due cards; leftover due stay on home.
4. You see a big German card (`der` blue, `die` red, `das` green; verbs have no article color).
5. Tap the card to flip (or press Space / Enter).
6. Grade buttons appear at the bottom: **Again / Hard / Good / Easy**. Nouns also get **Gender** (key **5**): you knew the word but missed der/die/das. It comes back in the session, with a smaller ease penalty than Again.
7. Grade with the buttons or keys **1–4** (and **5** for Gender on nouns).
8. The next due card appears. Close returns to home. The header also names the tier, so you can tell a 100-word session from a 514-word one.

## 3. Grades persist after reload

1. Note the due count on home (e.g. 100 on tier 1 in a fresh profile).
2. Start review, flip, tap **Good** on one card.
3. Close, or go home. Due count should be one lower.
4. Reload the page (F5). The lower due count persists.
5. Start review: the card you graded Good is gone from the queue.
6. Optional: grade a card **Again**, reload — that card is still due (interval reset).

## 4. Account

1. On a public build, a fresh profile shows **Continue with Google** and **Study on this device**. There is no owner, repository, or token field.
2. **Study on this device** seeds the local deck. Home says **On this device**. Those cards stay local until you later sign in and confirm a copy.
3. **Settings** for a signed-out visit shows **Continue with Google**. A signed-in visit shows the account label, **Sync now**, and **Sign out**.
4. A second Google account gets its own seeded deck. It cannot open the first account’s schedule. The emulator rules test covers that isolation; a real second account is a manual check on the public URL.
5. Signing out leaves the account’s local database on this device and returns to device study. It does not upload that database as the next account.

## 5. Editor + CSV import

1. Bottom bar → **Deck**.
2. **Add card**. Fill German `Hundewetter`, English `awful weather`, article `das`, save.
3. Deck list shows `das Hundewetter`. It is **due**, and its badge reads `T3` — a card you add has no corpus rank, so it starts in the widest tier.
4. Edit a built-in card such as `Kühlschrank`. The note reports its corpus rank and tier. Change the **Tier** box to 1, save, and the badge becomes `T1`: the box overrides the researched placement.
4. **CSV import**. Paste or use `public/sample.csv`:

   ```
   de,en,article,example_de
   Bahnhof,train station,der,Der Bahnhof ist nah.
   Toilette,toilet,die,Wo ist die Toilette?
   Bett,bed,das,Das Bett ist bequem.
   laufen,to run,none,Ich laufe schnell.
   ```

5. Tap **Import**. Toast reports imported count. New rows appear in Deck and are due on home.
6. Import the same CSV again: those rows are skipped (duplicate `de`+`en`).

## 6. Reverse direction + PWA

1. **Settings** → **EN → DE**. Home → Start review: front is English, back is German.
2. Switch back to **DE → EN** the same way.
3. On `npm run preview` (or a hosted HTTPS build), Chrome/Edge: install icon or menu → **Install page as app**.
4. On `npm run preview`, `node scripts/installable.mjs` checks the manifest,
   controlling service worker, offline reload, and Chromium installability
   errors. Chrome/Edge can show an install option on desktop.

## 7. Cloud sync (cross-device)

The public URL is <https://licensedsaucer9-web.github.io/german-flashcards-site/>. Sign in with Google. The app does not ask for a token.

1. Sign in on device A and wait until Settings says **Synced**.
2. Grade one card and keep the app open. The line may say **Saved on this device** while the write is still pending, then **Synced** after Firestore acknowledges it.
3. Open device B in a fresh profile, sign in with the same Google account, and wait for sync or tap **Sync now**. The grade matches. Switching apps does not perform a background upload.
4. Turn Airplane Mode on, grade another card, kill the PWA, and reopen it offline. The grade is still there and the line does not say **Synced**. Go online and confirm the grade arrives.
5. Sign in as a different Google account. Its deck is the bundled seed, and Joakim’s schedule is not visible.
6. `german-flashcards-data` stays a frozen snapshot. Do not paste its token into the app. Revoke that token only after the devices you still use are on this build.

The [README](README.md#move-an-older-iphone-home-screen-installation) explains moving an older Home Screen icon. A private Firestore export is in [docs/firebase-setup.md](docs/firebase-setup.md).

## 8. Mobile layout

1. DevTools device mode (Pixel / iPhone) or a phone on the LAN.
2. Grade buttons sit in the thumb zone at the bottom; targets are at least ~64px tall.
3. Nothing requires hover: flip, grade, tabs, and list rows all work with tap.
4. Home, Deck, and Settings stay inside a narrow column; review is full-height with the card in the middle.

# German Flashcards — click path

App lives in this folder. IndexedDB is the offline cache. Connect a **private GitHub repo** in Settings so the deck and SRS follow you across browsers (PC, iPhone Safari, etc.). A fresh profile with no remote file seeds ~500 A1/A2 cards. Existing decks gain the new seed cards on launch without resetting SRS on cards you already have.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173/).

For the installable PWA (service worker + Lighthouse):

```bash
npm run build
npm run preview
```

Open the preview URL (usually http://localhost:4173/).

## 1. Review loop (due queue only)

1. Home shows a large **due** count (50 on first launch), a **This session** cap (10 / 20 / 30 / All, plus custom), and **Start N of 50**.
2. The Deck and Settings tabs are in the bottom bar; home is not a full deck list.
3. Pick a session size (suggested chip is marked). Tap **Start**. Review only that many due cards; leftover due stay on home.
4. You see a big German card (`der` blue, `die` red, `das` green; verbs have no article color).
5. Tap the card to flip (or press Space / Enter).
6. Grade buttons appear at the bottom: **Again / Hard / Good / Easy**. Nouns also get **Gender** (key **5**): you knew the word but missed der/die/das. It comes back in the session, with a smaller ease penalty than Again.
7. Grade with the buttons or keys **1–4** (and **5** for Gender on nouns).
8. The next due card appears. Close returns to home.

## 2. Grades persist after reload

1. Note the due count on home (e.g. 50).
2. Start review, flip, tap **Good** on one card.
3. Close, or go home. Due count should be 49.
4. Reload the page (F5). Due count stays 49.
5. Start review: the card you graded Good is gone from the queue.
6. Optional: grade a card **Again**, reload — that card is still due (interval reset).

## 3. Editor + CSV import

1. Bottom bar → **Deck**.
2. **Add card**. Fill German `Hundewetter`, English `awful weather`, article `das`, save.
3. Deck list shows `das Hundewetter`. It is **due**.
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

## 4. Reverse direction + PWA

1. **Settings** → **EN → DE**. Home → Start review: front is English, back is German.
2. Switch back to **DE → EN** the same way.
3. On `npm run preview` (or a hosted HTTPS build), Chrome/Edge: install icon or menu → **Install page as app**.
4. Lighthouse 13 dropped the PWA category. On `npm run preview`, Chromium reports **no installability errors** (manifest + 192/512 icons + `standalone` + controlling service worker). Chrome/Edge show an install affordance on desktop.

## 5. GitHub sync (cross-device)

1. Create a **private** GitHub repo with a README (so `main` exists), e.g. `german-flashcards-data`.
2. GitHub → Settings → Developer settings → Fine-grained personal access tokens: Contents **read/write** on that repo.
3. In the app: **Settings → GitHub sync**. Owner, repo, path `data.json`, branch `main`, paste the token → **Connect and sync**.
4. Reload another browser (or iPhone Safari on the HTTPS-hosted PWA), enter the same owner/repo/token, **Sync now**. Due counts and grades match.
5. Grade a card on device A, wait ~1s or switch apps, open device B, wait a moment or tap **Sync now**. Progress matches.
6. Disconnect removes the token from that browser only; the GitHub file stays.

The PWA on iPhone still needs HTTPS (GitHub Pages for the *app*, or `npm run preview` via a tunnel). Keep the *data* repo private.

## 6. Mobile layout

1. DevTools device mode (Pixel / iPhone) or a phone on the LAN.
2. Grade buttons sit in the thumb zone at the bottom; targets are at least ~64px tall.
3. Nothing requires hover: flip, grade, tabs, and list rows all work with tap.
4. Home, Deck, and Settings stay inside a narrow column; review is full-height with the card in the middle.

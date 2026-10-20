# LS9 Flashcards — manual acceptance guide

Use a disposable browser profile for study/editor checks. Existing personal
decks and legacy storage must remain intact. The public root still serves the
renamed legacy GitHub-sync client; the Firebase client is staged and the real-data
test rehearsal is complete. Production acceptance remains in the
[rollout plan](docs/firebase-rollout-plan.md).

A fresh device-study deck has 514 built-in cards in three tiers. Existing
decks gain missing seeds without resetting existing SRS; deleted seeds stay
deleted.

## Run and choose a build

For local study:

```bash
npm ci
npm run dev
```

Open the printed URL (usually `http://localhost:5173/`). This build has no
Google login or cloud sync. For a service-worker/offline check:

```bash
npm run build
npm run preview
```

Open `http://127.0.0.1:4173/`. If checking a subpath, set the same `BASE`
for build and preview.

For the isolated Firebase test app:

```bash
npm run rehearsal:build
BASE=/ls9-flashcards-site/auth-spike/rehearsal/ npm run preview -- --outDir dist-rehearsal --port 4178 --strictPort
```

Open `http://127.0.0.1:4178/ls9-flashcards-site/auth-spike/rehearsal/`.
Confirm **Test rehearsal**, the test project, and revision. Choose **Study on
this device** for local checks. Real Google login needs that hostname authorized
in the test project. The rehearsal admits only an already verified legacy
assignment and uses separate storage; it cannot demonstrate fresh-user
provisioning or recover the old root app's device-only data.

The [published rehearsal](docs/firebase-rehearsal.md) supports physical-device
testing. Check its visible revision: merged source changes do not automatically
publish that preview. An ordinary `VITE_SYNC_BACKEND=firebase` build defaults
to production; do not sign an unmigrated owner into it before the Admin import.

For candidate preparation from clean committed source, use `npm run release:build`
and `npm run release:verify`. In Settings → Install, record the displayed version
and source revision, then reload offline and confirm they remain the same. The
installability test also verifies the offline Settings and cached `release.json`
identity against the artifact. See [the candidate runbook](docs/firebase-setup.md#prepare-and-verify-a-release-candidate)
for checksum/CI evidence and later read-only served verification. Production
publication and physical installation updates remain #38's operational gate.

## 1. Tiers

1. Review shows saved **Deck tier** chips with word and due counts. Tier 1 is selected
   on a fresh profile and includes 100 words.
2. Tier 2 alone includes its own 150 words. Tier 2 + Tier 3 includes 414
   words and excludes Tier 1. Pills show counts for their own bucket.
3. Tier 3 alone includes 264 words and excludes tiers 1 and 2. Reload, switch
   decks, and sync a second client to verify the exact selection persists.
   Turning off the last tier returns to all three. Old cumulative settings
   retain their scope on upgrade.
4. Cards has an unsaved browse tier filter, and rows show `T1` / `T2` / `T3` badges.
   Changing this filter must leave the saved Review tier and next review unchanged.
5. Spot-check tier 1's frequency order against the README: it opens with
   `haben`, `gut`, `sein`, `werden`, `können` and ends at `groß` / `Hand`.

6. Decks also saves review direction: **DE → EN** shows German first;
   **EN → DE** shows English first. Change it and start a new review to verify.
7. Review shows tier, word-type, and session-size chips in that order.
   Decks retains review direction and optional-feature switches.
   Settings retains account controls, Theme, Install/version, and the SRS note.

## 2. Review loop and exit

1. Review shows the selected tier's due count and compact size chips
   (10 / 20 / 30 / All / Custom), and **Start N of M**.
2. Custom opens a number selector in steps of five. Cancel, Escape, and tapping
   outside leave the saved size unchanged; Done updates the pill and start button.
   Reload and switch decks to check persistence and deck isolation.
   Choose a cap and start. Only that many due cards enter the initial session;
   leftover cards remain due on home.
3. Tap the card or press Space/Enter to flip. Articles use blue `der`,
   red `die`, green `das`; verbs have no article color.
4. Grade **Again / Hard / Good / Easy** with buttons or keys 1–4. Nouns also
   offer **Gender** (key 5), which requeues with a smaller ease penalty than Again.
5. Grade one card, then **Close** mid-session. Return to home with that grade
   saved. Start again and confirm a fresh queue; completion offers **Back home**.
6. When the selected tier and word type are caught up, the due count stays at
   zero and **Review N cards ahead** remains enabled. It reviews matching cards
   soonest due first, obeys Custom/All, and saves grades normally. Empty tiers or
   word-type selections with no matching cards remain disabled.
7. A running session uses its initial queue. Cards arriving through sync
   enter a later session.

## 3. Persistence and deletion

1. Grade a fresh card **Good**. Close to home; its due count decreases by one.
2. Reload. The grade and lower due count persist, and that card is absent from
   the due queue. **Again** leaves a card due after reload.
3. Delete a disposable built-in card. Reload; reseeding must not restore it.
   On a signed-in test account, sync and check that deletion on another client.
4. Card editing must preserve the existing schedule.

## 4. Accounts and guarded sessions

These checks need a Firebase build. General new-account provisioning is covered
by automated checks and the later production acceptance, not by the guarded
rehearsal preview.

1. A fresh Firebase visit offers **Continue with Google** and **Study on this
   device**, with no repository/token form. Device study stays local.
2. On the test preview, a missing/pending/unassigned account reports that it
   needs its verified import and does not create a personal deck.
3. In current source, that guarded Google session shows **Signed in to Google**
   and **Sign out of Google** and hides **Continue with Google**. Test both a
   fresh login and a restored session; repeat clicks must not reopen login.
4. **Study on this device** still opens the local deck. Settings retains the
   guarded session's sign-out action. Sign out; sign-in becomes available again.
   Check popup cancellation and a later retry leave the app usable.
5. A verified legacy account enters its imported deck. Settings shows the
   account, **Sync now**, and **Sign out**.
6. With pending account changes, sign-out offers sync, sign-out, or staying
   signed in. Signing out retains that account's local data; signing in as
   another account must not expose or upload it.
7. If guest-copy is offered on a normal personal-account build, cancel it and
   confirm the local source is retained. Copy only after confirming the account.

## 5. Editor and CSV

1. Deck → **Add card**: enter `Hundewetter`, `awful weather`, article `das`.
   It is due and starts in tier 3; widen the Deck filter to see it.
2. Edit a built-in card. The note gives rank/tier; override its tier to 1 and
   confirm the badge changes without resetting SRS.
3. Import a CSV such as:

   ```csv
   de,en,article,example_de
   Bahnhof,train station,der,Der Bahnhof ist nah.
   Toilette,toilet,die,Wo ist die Toilette?
   Bett,bed,das,Das Bett ist bequem.
   laufen,to run,none,Ich laufe schnell.
   ```

4. Check the imported/skipped count. Existing `de`+`en` pairs are skipped;
   the sample may already be in the seed. Use unique disposable pairs if you
   need to demonstrate new rows.
5. Import again; duplicates are skipped. New unranked cards are in tier 3.

## 6. Direction, installation, and offline study

1. Settings → **EN → DE**. Start review; the front is English. Switch back to
   **DE → EN** and check the German front.
2. On a build served by preview or HTTPS, check the manifest and service worker.
   Chrome/Edge may offer installation. On iPhone Safari, use Share →
   **Add to Home Screen**.
3. Turn Airplane Mode on after a successful load. Reopen and review a card,
   immediately switch apps/close, then reopen offline. The grade persists.
4. For a signed-in account, status stays **Saved on this device** until
   Firestore acknowledges it after reconnection.

## 7. Cross-device Firebase sync

Use the mapped test account for rehearsal, or production after its authorized
cutover. Never use the old public root as evidence of the staged client's sync.

1. Sign in on client A and wait for **Synced**.
2. Grade a card; pending status becomes **Synced** only after acknowledgement.
3. Sign into the same account on a clean client B. Compare settings, due count,
   and the changed schedule. Use **Sync now** if both clients remained visible:
   there is no realtime listener or background polling.
4. Review offline, close/reopen offline, reconnect, and confirm the grade on B.
5. Create, sync, and delete a disposable card; it stays absent after B syncs.
6. On a normal production build, verify a fresh account gets its own seeded deck
   and cannot see the legacy account's schedule or vocabulary edits.
7. For old device-only progress, use the confirmed same-context copy procedure
   in [the migration runbook](docs/firebase-migration.md).

## Automated checks and evidence

`npm test` covers pure logic and synthetic migration inputs without a browser
or live service. `npm run test:account-ui` checks the account UI with synthetic
Google sessions and real IndexedDB in Chromium. `npm run test:rules` uses the
Firestore emulator for rules, cloud sync, and migration (Java 21 and Chromium).

With a preview running, `APP_URL=URL node scripts/installable.mjs` checks
manifest/worker, mobile guest controls, installability, and offline reload.
`PREVIEW_REVISION=FULL_SHA npm run rehearsal:check` checks the published
isolated preview without signing into Google. Browser checks require Chromium;
see [development setup](README.md#develop).

The real #25 rehearsal passed on 2026-10-04; its
[record](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235)
distinguishes server comparisons from human checks. New manual results should
record build, date, device/browser, method, and outcome. Keep record-level
values and operator files private. Production acceptance is still outstanding.


## Forgiving streaks (#58)

The daily target is 10 saved grades, including repeated cards and every grade.
The counter is passive, near the Home/review header. Check moon at 9, fire at 10,
moon after midnight, and skull only after a past day has a shortfall. Its optional
explanation opens only when tapped; there must be no reminder, permission prompt,
notification, email, popup or live screen-reader announcement.

Two empty days need 20 extra reviews after today's 10; 7 reviews on a past day
need only 3 extras. Partial repairs carry between sessions and days. Extra reviews
after repair is complete do not bank future days. Check progress after closing
mid-session and reopening offline, including the newly available review-ahead path.

`npm test` covers the calculation, serialization, pending markers, calendar/DST
boundaries, merge and backup/restore. `npm run test:account-ui` uses synthetic auth
and real IndexedDB for all counter states, repair, rollover, atomic saves, retry,
account isolation and device copies. `npm run test:rules` checks immutable activity
ownership, malformed writes, concurrent clients and offline retry in the emulator.
The recovery build also verifies that opening a version-1 source does not upgrade
or mutate it. Production two-device/installed-app acceptance belongs to release.

## Themes

Run `npm run test:themes-ui` for disposable Chromium checks. In Settings, select
Light and Dark with touch or keyboard. Confirm readable screens, article badges,
grade buttons and dialogs on mobile and desktop, then reload to check persistence.
The theme applies to every deck/account on this device and does not sync.

# Plan: native iOS and Android apps

Status: planning only, for #178. Nothing here is implemented or decided. The
code, tests and `docs/architecture.md` stay authoritative;
`docs/firebase-rollout-plan.md` remains the active operating plan. This file
supersedes the archived
[mobile store proposal](../archive/mobile-store-proposal-20261010.md) and
should be archived or removed once the apps ship or the idea is dropped.

**Top priority: minimal disruption to the web app, its users and ongoing work.**
Every mobile piece is additive: a separate build, separate native projects and,
later, small `src/platform/` adapters. The PWA build (`dist-firebase`), its
service worker, the Pages workflow and its master-only publish conditions stay
unchanged. Rules deployment stays separate from publication.

## Baseline (v1.5.0, 2026-11-01)

The archived proposal was written against `1.2.0`. What changed since:

| Area | v1.5.0 state | Effect on the mobile plan |
|---|---|---|
| Decks | Multiple decks with per-deck preferences and progress; names, selection, optional-feature switches and local deck deletion are device-local. | The archive listed multiple decks as a non-goal; it is now just part of the shared app. |
| Sync | Incremental pulls from a server-time cursor with an overlap window, a daily full pull, recent-activity window, tombstones; foreground pulls throttled to `FOREGROUND_PULL_INTERVAL_MS` (10 min); no retry on `resource-exhausted` (#171). | Must stay byte-for-byte shared so the read budget does not grow with more installs. |
| Feedback | Settings → Send feedback writes create-only `/feedback` documents (#169). | Works unchanged in a bundled WebView with Firebase JS. |
| Speech | Speech output (`src/speech.ts`) and opt-in speech input (`src/speech-input.ts`, see [speech-input.md](speech-input.md)), both device-local switches. | Need native plugins; see section 3. |
| Themes | Twelve themes stored per browser in `localStorage`. | Shared as-is. |
| Updates | Settings → Check for update compares `release.json` and drops the service worker cache (`src/app-update.ts`). | Replaced by store updates in the mobile build. |
| Auth | Google via `signInWithPopup` (`src/cloud-on.ts`). | Does not work in an embedded WebView; needs a native bridge. |
| Account deletion | Settings → Delete account, entirely client-side (no Blaze): typed `DELETE`, Google re-authentication, budgeted batch deletes of the account's Firestore data, then the Auth user, then the device copy; resumable (#180, [architecture](../architecture.md#account-deletion)). | Meets the in-app requirement of both stores once the native auth bridge can re-authenticate; Apple also needs token revocation and Play a web deletion route (section 5). |

## 1. Recommended approach

**Capacitor with bundled web assets, for both platforms, from one shared
codebase.** It reuses the DOM UI, CSS, themes, scheduler, merge rules,
IndexedDB layer and `cloud-sync.ts` unchanged, and adds native projects plus a
few plugins (auth, speech, lifecycle). The app ships its own web assets; it
does not load the published site (`server.url` is for development only).

| Option | Platforms | Effort (feasibility pass) | Reuse | Verdict |
|---|---|---|---|---|
| **Capacitor (bundled)** | iOS + Android | ~1.5–3 weeks | Almost all TypeScript, UI, CSS, sync | **Recommended** |
| TWA (Trusted Web Activity) | Android only | 1–3 days | Loads the live PWA | Fast, but Digital Asset Links needs a custom domain (not a `github.io` subpath), no iOS, and still needs native sign-in and speech workarounds. Possible stopgap only. |
| React Native | iOS + Android | 5–8 weeks | Pure logic (SRS, merge, docs) | UI is plain DOM/TypeScript, so every screen is rewritten. Revisit only if the Capacitor spike fails on UX. |
| Flutter | iOS + Android | 8–14+ weeks | None (Dart) | Ports scheduler, merge and sync; high regression risk. |
| Kotlin Multiplatform | iOS + Android | 8–14+ weeks | None (Kotlin) | Same as Flutter, plus a SwiftUI or Compose Multiplatform UI. |
| Fully native (SwiftUI + Compose) | each separately | 8–14+ weeks | None | Two implementations of sync and merge; highest regression risk. |

Code work should wait until the current sync and feedback churn settles. Store
accounts and the Android 14-day tester clock can start now (section 7).

## 2. Phases

Each phase ends with a written go/no-go note. Later phases do not start on a
failed gate.

1. **Spike (≈3–5 days, on a branch, not merged into the web build).**
   Capacitor shell around a `dist-mobile` build on a real iPhone (and the iOS
   simulator on the Mac) and a real Android phone. Acceptance gate:
   - Google sign-in through a native credential bridge reaches the same
     Firebase UID as the PWA.
   - Offline cold launch opens guest study and a previously downloaded account.
   - Grades survive force-quit and an app upgrade.
   - Incremental pull, overlap and tombstones behave as on the web
     (`cloud-sync-emulator-test` scenarios replayed by hand against
     `flashcards-ls9-auth-test`).
   - Native TTS and speech recognition plugins work for German, French and
     Spanish.
   - Navigation, Android back button, safe areas and keyboard are usable.
2. **Android closed test.** Mobile build, `src/platform/` adapters, native
   Google sign-in, account deletion, privacy policy, Data safety. Signed AAB
   with Play App Signing on the closed testing track; 12 testers opted in for
   14 continuous days.
3. **iOS TestFlight.** Same build plus Sign in with Apple. Internal testers
   first, then external testers (first external build goes through TestFlight
   review).
4. **Stores.** Play production access application, then production rollout;
   App Store submission and review. Owner-controlled releases only.

## 3. Shared vs rebuilt

| Piece | Mobile treatment |
|---|---|
| SRS, tiers, word types (`srs.ts`, `tiers.ts`, `word-types.ts`) | Shared unchanged. |
| Merge and record sync (`merge.ts`, `record-sync.ts`, `firestore-docs.ts`) | Shared unchanged. |
| IndexedDB (`db*.ts`) | Shared. Capacitor's app-scoped WebView storage is not evicted the way Safari's 7-day rule evicts website data, but still call `navigator.storage.persist()` and keep the cloud as the backstop. Keep the WebView origin and database names stable across app upgrades. Native SQLite only if the spike shows data loss. |
| Sync (`sync.ts`, `cloud-sync.ts`, `cloud-push.ts`) | Shared unchanged, including the pull cursor, throttles and quota handling (section 4). Native resume/network events call the existing foreground trigger; no new pull paths. |
| Feedback (`cloud-feedback.ts`) | Shared unchanged. |
| Auth (`cloud-on.ts` sign-in) | **Rebuilt behind an adapter.** Native Google and Apple sign-in return an ID token; the existing Firebase JS Auth signs in with `signInWithCredential`. The web keeps `signInWithPopup`. |
| Speech output (`speech.ts`) | **Native plugin on Android** (WebView TTS is unreliable). iOS WKWebView `speechSynthesis` works, but use the same plugin on both for one code path. |
| Speech input (`speech-input.ts`) | **Native plugin on both.** Android WebView has no Web Speech recognition; iOS WKWebView recognition is limited. Same switch semantics: off by default, device-local, mic button not rendered when off or unavailable. |
| Themes (`theme.ts`) | Shared. Also set the native status bar color from `--bg`. |
| Service worker and update flow (`app-update.ts`, `vite-plugin-pwa`) | **Not in the mobile build.** No SW registration, no install hints, no Check for update; the store delivers updates. The PWA keeps all of it. |
| Account deletion | Shared: `src/account-deletion.ts` and the Settings flow. The native build swaps only re-authentication (`reauthenticateWithPopup`/`Redirect`) for the native sign-in bridge (section 5). |

Proposed layout (later, not in this plan's PR): `capacitor.config.ts`,
`ios/`, `android/`, a `build:mobile` script producing `dist-mobile` with the
Firebase backend, and `src/platform/` with a web implementation that is the
current code and a native implementation chosen at build time. The existing
`build`, `dist-firebase` and Pages workflow are not edited to add mobile; mobile
CI gets its own workflow.

## 4. Sync, auth and the read budget

**Read budget.** The mobile app must not add reads per active user beyond what
a PWA install costs. Sharing `cloud-sync.ts` unchanged keeps:

- The incremental pull: server-time cursor per deck, `PULL_OVERLAP_MS` overlap
  until settled, daily full pull, 30-day recent-activity window, tombstones in
  settings.
- The 10-minute foreground throttle, `FOREGROUND_PULL_INTERVAL_MS`, and the
  5-minute light-pass interval. Native `resume` and network-change events map
  to the existing `foreground` pass and must be deduplicated with the WebView's
  own `visibilitychange` and `online` events so they don't double the pulls.
- The quota behavior: `resource-exhausted` is not retried, and the existing
  messages ("Daily cloud limit reached, studying offline until it resets")
  appear unchanged.

**Google sign-in.** Google blocks OAuth in embedded user agents, so
`signInWithPopup` and `signInWithRedirect` cannot run inside the WebView. Plan
a native credential bridge (a maintained Capacitor Firebase Authentication
plugin, or a small audited one) that runs the platform Google sign-in and
returns an ID token. The JS SDK then calls
`signInWithCredential(auth, GoogleAuthProvider.credential(idToken))`, so the
same Firebase JS Auth instance owns the session Firestore uses and the UID
matches the PWA.

**Firebase app registration.** Register an Android app and an iOS app in the
Firebase project (and separately in `flashcards-ls9-auth-test` for testing).
Android needs SHA-1 and SHA-256 fingerprints for the debug key, the upload key
**and the Play App Signing key** (store-installed builds are signed by Google;
missing that fingerprint breaks sign-in only in Play builds). iOS needs the
bundle ID and the reversed client ID URL scheme.

**Sign in with Apple.** App Review guideline 4.8 requires an equivalent
privacy-preserving login option when the app offers Google sign-in, so ship
Sign in with Apple on iOS (nonce handling, Firebase Apple provider). Make Apple
accounts usable on Android and the PWA too, so an Apple-only account is not
stranded. Never merge accounts by email; provider linking keeps the Firebase
UID.

**Rules.** Ownership is `request.auth.uid`, so new providers need no rules
change. The owner-only delete rules for account deletion (#180) are already
in `firestore.rules`; their deploy is separate, as for every rules change.

## 5. Store costs and steps

**Google Play**

- US$25 one-time registration, plus developer identity verification.
- New personal accounts must run a **closed test with at least 12 testers
  opted in for 14 continuous days** before applying for production access.
  Internal testing does not count.
- Privacy policy URL, Data safety form (account email/name, user-created cards,
  review progress, feedback text), content rating, target API level per the
  current Play requirement.
- In-app account deletion plus a web page for deletion requests that works
  without the app installed.
- Signed AAB, Play App Signing with a separate upload key.

**Apple App Store**

- US$99 per year Apple Developer Program.
- Builds need Xcode on a Mac: Joakim's MacBook M2 Pro (macOS 26 Tahoe) covers
  this; CI on a hosted macOS runner is optional later.
- TestFlight internal, then external testers (external needs Beta App Review).
- App Review: substantial offline functionality (not a repackaged website),
  Sign in with Apple (4.8), privacy nutrition labels, privacy policy, reviewer
  access notes.
- **In-app account deletion** (5.1.1(v)), including Apple token revocation.

**Account deletion (both stores).** Both stores require that an app which lets
people create an account also lets them delete it, from inside the app:

- *Apple* (App Review Guideline 5.1.1(v)): account deletion must be initiated
  in the app, delete the account and its associated data (not just deactivate
  it), and be easy to find. Apps offering Sign in with Apple must also revoke the
  user's Apple tokens through the Sign in with Apple REST API when the account
  is deleted.
- *Google Play* (User Data policy, account deletion requirement): the app must
  offer deletion in the app **and** a web link, entered in the Data safety form,
  where a user can request deletion without reinstalling the app. Deleted data
  must be listed in Data safety; any data kept (and why, and for how long) must
  be disclosed.

The web app already does the in-app part without Blaze (#180; see
[architecture](../architecture.md#account-deletion)): Settings → Delete account
deletes the account's Firestore data in batches of at most 500, then the
Firebase Auth user, then the local database, and resumes after interruptions or
the daily quota. For the stores the remaining work is:

- Re-authentication through the native sign-in bridge instead of the web popup.
- Sign in with Apple token revocation. Without Cloud Functions the client can
  call Firebase's `revokeAccessToken` with a fresh Apple authorization code
  during the re-authentication step, before `user.delete()`.
- Play's web deletion route: the hosted web app's Settings → Delete account
  works from any browser, so that URL (plus a short help page) can be the
  Data safety link.
- Disclosures: feedback stays (it is anonymous unless the user ticked Include my
  account), a shared deck's vocabulary stays for its other members, and the
  private daily backups keep deleted data until they age out (14 dumps).
- Stale clients: another signed-in device can still write until its ID token
  expires (up to an hour); the confirmation tells users to sign out elsewhere
  first. A server-side sync block would need a trusted backend.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Mobile work disturbs the web app or active PRs | Separate build, native folders and workflow; `src/platform/` adapters default to today's web code; no edits to `dist-firebase` or `pages.yml`. Start code only after sync/feedback churn settles. |
| More installs raise Firestore reads | Share `cloud-sync.ts` unchanged; dedupe native and WebView foreground triggers; compare reads per session on the spike. |
| Play-signed builds fail Google sign-in | Register the Play App Signing SHA-1/256 before the closed test; test a store-installed build. |
| App Review rejection (4.2 minimum functionality, 4.8 login) | Offline study, speech, editing and sync on device; Sign in with Apple; clear review notes. |
| Speech differs between web and native | Native plugins behind the existing switches; keep the web path unchanged; per-language device checks. |
| Local data loss on upgrade or origin change | Stable origin and DB names; `storage.persist()`; cloud backstop; upgrade test in each phase. |
| Apple sign-in creates a second account | Explicit linking only; cross-client UID check. |
| Account deletion is incomplete or resurrected by stale clients or backups | Client deletion confirms an empty pass before deleting Auth; users are told to sign out elsewhere first; erasure-aware restore tooling; a server-side sync block would need a trusted backend. |
| The 14-day tester clock slips | Recruit 12 testers and enroll the Play account early. |
| Offline cold start still waits on provisioning | Check in the spike; cache the last validated account/deck binding if needed. |

## 7. What can run in parallel

Can start now without touching code:

- Play Console and Apple Developer enrollment, identity verification, choosing
  the seller name and bundle/package IDs.
- Recruiting the 12 Android testers (their 14-day clock starts once a closed
  test build exists).
- Privacy policy text and a deletion-request web page.
- Firebase iOS/Android app registration in `flashcards-ls9-auth-test`.
- Store listing copy and screenshot plan.

After the sync and feedback churn settles:

- Spike (phase 1), then mobile build and adapters.
- Native re-authentication for account deletion and Apple token revocation
  can run alongside the native auth bridge.
- Android closed test and iOS TestFlight run concurrently once the shared build
  passes the spike gate; only the Apple-specific sign-in is iOS-only work.

Unaffected throughout: web releases, theme and feature work, backups and the
Pages workflow.

## 8. Open questions for Joakim

1. **Custom domain?** Needed only for a TWA or for Digital Asset Links / app
   links; not needed for Capacitor. A domain would also host the privacy policy
   and deletion page more cleanly than a `github.io` subpath.
2. **Which store first?** Recommended: start the Android closed test first
   because of the 14-day clock, with iOS TestFlight right after.
3. **Who are the 12 Android testers?** They must stay opted in for 14
   continuous days.
4. **Apple's US$99/yr:** approve it, and individual or organization account
   (affects the public seller name)?
5. Account deletion is client-side (#180). Is that enough for review, or is a
   trusted backend (Blaze) wanted later for a server-side sync block?
6. Minimum OS versions and whether tablets/iPad are in scope.

## Sources

- Google Play, testing requirements for new personal developer accounts:
  <https://support.google.com/googleplay/android-developer/answer/14151465>
- Apple App Review Guidelines 4.8, Login Services:
  <https://developer.apple.com/app-store/review/guidelines/#login-services>
- Apple App Review Guidelines 5.1.1(v), account deletion:
  <https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage>
  and <https://developer.apple.com/support/offering-account-deletion-in-your-app/>
- Google Play, account deletion requirements:
  <https://support.google.com/googleplay/android-developer/answer/13327111>
- Archived proposal with further sources (Capacitor config, Firebase auth,
  deletion requirements, signing):
  [mobile-store-proposal-20261010.md](../archive/mobile-store-proposal-20261010.md)

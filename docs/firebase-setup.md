# Firebase setup for issue #10

Status: **Spark confirmed; desktop Brave and installed iPhone Home Screen
sign-in passed; cancellation retest and two browser checks pending**.
This guide prepares the temporary Google sign-in spike. It does not enable
Firebase in the published flashcard app, migrate data, or create Firestore
user/deck documents.

The unlinked OAuth test preview is live at
<https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike/>.
It uses only the OAuth test project. Joakim signed in on desktop Brave and
confirmed the same UID after refreshing; the UID is recorded in issue #10 as
a **test-project** identifier. In headless Chromium, a button click opened
the Firebase auth popup and closing it returned
`auth/popup-closed-by-user`; the preview remained usable. On the installed
iPhone Home Screen preview, the Google popup returned to the app with the
same test UID, which survived reopening and Airplane Mode. Dismissing a later
popup left that signed-in UID unchanged, though Firebase reported
`auth/cancelled-popup-request`. On the installed iPhone PWA, Firebase opens
Google with a synthetic link and keeps no window handle, so dismissing that
window often never rejects `signInWithPopup` and the screen stays on Opening
Google sign-in. Preview revision 2 recovers when the page returns, or when
Continue with Google is tapped again. A retest on revision 2 is pending.
Headless Chromium on the live test preview reported `auth/popup-blocked`
for a forced-blocked popup, left the signed-out UID unchanged, and enabled
the sign-in button again. Desktop Chrome, iPhone Safari, and the installed
preview's blocked-popup check remain pending.

The separate production UID preview is live at
<https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike-prod/>.
It uses only `flashcards-ls9-prod` and displays the project ID beside the UID
so the two projects cannot be confused. Its popup opened in headless Chromium;
closing it left the page usable. Joakim signed in on desktop Brave and
confirmed the same production UID after refreshing. That UID is recorded on
issue #10 for later migration mapping. Neither preview accesses Firestore.

## Project record

Project IDs and the web config below are public identifiers; keep the Admin
SDK service account JSON private.

| Setting | Production | OAuth test |
| --- | --- | --- |
| Firebase project ID | `flashcards-ls9-prod` | `flashcards-ls9-auth-test` |
| Billing plan | Spark. Cloud Billing reports billing disabled and no linked account (2026-09-29) | Spark. Cloud Billing reports billing disabled and no linked account (2026-09-29) |
| Firestore location | `europe-west1`, Standard, empty, free tier | `europe-west1`, Standard, empty, free tier |
| Google sign-in | Enabled, confirmed by Joakim in console | Enabled, confirmed by Joakim in console |
| Authorized domains | `licensedsaucer9-web.github.io` confirmed by Joakim | `licensedsaucer9-web.github.io` confirmed by Joakim; local hostname pending |
| Web app ID | `1:447756082894:web:6b39de4d88f7638a817a9f` | `1:523307197531:web:171d03e6369727b4208b7e` |
| Auth domain | `flashcards-ls9-prod.firebaseapp.com` | `flashcards-ls9-auth-test.firebaseapp.com` |

Use the **OAuth test project** for the issue's browser and phone experiment.
The production preview only captures the authenticated UID needed for later
migration mapping. Do not create a personal deck, `users/{uid}`, or
`decks/{uid}`. The spike imports only `firebase/app` and `firebase/auth`.

## One-time console setup

The Firebase CLI is installed in this repo as a development dependency. After
`npm ci`, run `npm exec -- firebase --version` from the repo root to check it;
no global CLI installation is needed. This command does not log in or create a
project.

Both projects, their empty Firestore databases, and their web apps were
created through the Firebase CLI on 2026-09-29. The CLI reported
`freeTier: true` for both databases. The setup used by this spike:

1. Both projects are on the **Spark** plan. The Cloud Billing API reports
   `billingEnabled: false` and no linked billing account for each project
   (checked 2026-09-29). Do not link a billing account for this issue.
   Each `(default)` Firestore database is in `europe-west1` and has no
   collections. Analytics is not required.
2. Google sign-in has been enabled in both projects. The test spike uses the
   test project; the separate production preview was used only to record the
   production UID for later mapping.
3. `licensedsaucer9-web.github.io` has been added to both projects' authorized
   domains. If testing from a local Vite server, also add that local hostname
   to the test project (`127.0.0.1` if accepted, otherwise `localhost`). Only
   use a local origin over HTTP; the Pages origin uses HTTPS.

The OAuth test web config is already in an ignored `.env.local` in the issue
#10 checkout on Joakim's machine. On another checkout, copy
`spikes/firebase-auth/config.example` to `.env.local` and fill its four
variables from the **test** project's web app config. These are public web
config values. Do not paste an Admin SDK JSON or any token into that file.
Do not point the spike at production.

If Google requires OAuth consent configuration, follow the Firebase Console's
provider setup for the test project. Record any test-user restrictions here;
the phone's Google account must be allowed to use the test project. Do not add
extra Google scopes. See [Firebase Google sign-in docs](https://firebase.google.com/docs/auth/web/google-signin).

The production Admin SDK JSON, **when a later migration task requires one**,
belongs at `~/.config/german-flashcards/` on the operator's machine. Do not
generate it for this spike, commit it, upload it to Pages, or copy it into the
test project. Keep Firebase CLI credentials out of the repo as well.

## Build the isolated spike

The Vite configuration reads the four public variables from the repository
root `.env.local`. With that file in place, run:

```bash
npm ci
npm run auth-spike:dev
```

Open the local URL printed by Vite on desktop. For a static preview at the
**current GitHub Pages origin**, run:

```bash
BASE=/german-flashcards-site/auth-spike/ npm run auth-spike:build
```

The output is `dist-auth-spike/`. Publish that output only as an unlinked
`auth-spike/` directory in the public site's `gh-pages` branch, without
replacing the existing site's root files. The normal `npm run build` uses the
root app entry, and `.github/workflows/pages.yml` publishes only `dist/` from
`master`; this spike is never included in that build. Before sharing the
preview, check that its manifest `start_url` and scope resolve to
`/german-flashcards-site/auth-spike/`. Once testing is finished, remove the
temporary directory from the public site. The normal publish job uses
`rsync --delete`, so a later `master` publish will also remove the preview
directory; republish it if the phone test is still pending.

The main app's navigation service worker originally captured the preview
paths and returned the flashcard app. Its fallback now excludes
`auth-spike/` and `auth-spike-prod/`, allowing each preview to load and
register its own service worker. This exclusion must be deployed with any
main-app rebuild while the previews remain live. On an iPhone that installed
the old main worker, revisit the main app in Safari to trigger its update,
then open the exact preview URL and confirm the heading says **Firebase
Google sign-in check** before adding it to the Home Screen. Do not clear
Safari website data, which could remove local flashcard progress.

Because the spike is an independently installed preview PWA, record this
distinction in the phone result. If it behaves differently from the installed
main app, the issue's gate is still unproven; do not infer the main PWA works.

## Test record to post on issue #10

Use the **OAuth test project**. On each platform, note browser/iOS version,
result, Firebase error code where applicable, and the UID (keep account email
out of the issue). Do not post ID tokens or configuration files.
The test project's UID proves that OAuth completed, but it cannot be used to
map an account in the separate production Firebase project. The production
sign-in and refresh checks have passed on desktop Brave, and its UID is
recorded separately on issue #10 for migration mapping.

| Check | Desktop Chrome | iPhone Safari | iPhone Home Screen preview |
| --- | --- | --- | --- |
| User-initiated popup succeeds | Pending | Pending | Passed; returned to installed preview with test UID |
| Closing/cancelling popup leaves app usable | Pending | Pending | UID unchanged, but the screen often stayed on Opening Google sign-in. Revision 2 retest pending |
| Blocked popup is reported without changing existing session | Headless Chromium: `auth/popup-blocked`, signed-out UID unchanged. Desktop Chrome pending | Pending | Pending |
| Leave and reopen; same UID restored | Pending | Pending | Passed |
| Airplane mode; prior session/local UI remains readable | Pending | Pending | Passed; offline indicator, same UID, sign-in error without losing session |

For the Home Screen check, open the preview URL in Safari, add it to the Home
Screen, launch from its icon, tap Continue with Google, and check whether the
popup returns to that installed app. Leave/reopen the app and compare its UID.
Test with the device offline as well; first-time sign-in requires connectivity.

If the popup is unreliable, report the failure and stop issue #10. The next
decision is a Firebase Hosting move with a bridge release at the old origin;
do not start onboarding or cutover issues #12 or #15. Firebase documents the
cross-origin redirect limitations in [its redirect guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices).

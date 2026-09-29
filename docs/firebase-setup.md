# Firebase setup for issue #10

Status: **projects created; provider, database, and phone test pending**. This guide prepares the
temporary Google sign-in spike. It does not enable Firebase in the published
flashcard app, migrate data, or create Firestore user/deck documents.

## Project record

Fill this in after creating the projects. Project IDs and the web config below
are public identifiers; keep the Admin SDK service account JSON private.

| Setting | Production | OAuth test |
| --- | --- | --- |
| Firebase project ID | `flashcards-ls9-prod` | `flashcards-ls9-auth-test` |
| Billing plan | Spark expected; verify in console | Spark expected; verify in console |
| Firestore location | `europe-west1` planned; database not created | `europe-west1` planned; database not created |
| Google sign-in | Enabled after setup | Enabled after setup |
| Authorized domains | `licensedsaucer9-web.github.io` | `licensedsaucer9-web.github.io`, plus local hostnames used for testing |
| Web app ID | Pending | Pending |
| Auth domain | Pending | Pending |

The production project is reserved for the eventual migration. Use the **OAuth
test project only** for this issue's spike and phone test. Do not create a
personal deck, `users/{uid}`, or `decks/{uid}`. The spike imports only
`firebase/app` and `firebase/auth`.

## One-time console setup

The Firebase CLI is installed in this repo as a development dependency. After
`npm ci`, run `npm exec -- firebase --version` from the repo root to check it;
no global CLI installation is needed. This command does not log in or create a
project.

Both projects were created through the Firebase CLI on 2026-09-29. Console
access is not available in the coding environment, so the project owner must
complete the remaining console steps:

1. At [Firebase Console](https://console.firebase.google.com/), open each
   project listed above and verify that the billing plan is **Spark**. Do not
   link a billing account for this issue. Analytics is not required.
2. In each project, open **Build → Authentication → Get started → Sign-in
   method** and enable **Google**. Configure the required project support
   email in the provider form.
3. In each project, open **Build → Firestore Database → Create database**.
   Choose `europe-west1` before creation; the location cannot be changed for
   that database later. Use production/locked rules, not open test rules. No
   documents need to be created. Firestore may ask for an edition; choose the
   standard/default edition unless the console or project requirements differ.
4. In **Authentication → Settings → Authorized domains**, add
   `licensedsaucer9-web.github.io` to both projects. In the test project also
   add the local hostname used for browser testing (`127.0.0.1` if accepted,
   otherwise `localhost`). Only use a local origin over HTTP; the Pages origin
   uses HTTPS. Record the final list above.
5. In the **OAuth test project**, open **Project settings → General → Your
   apps → Add app → Web**. Register a web app and copy its `apiKey`,
   `authDomain`, `projectId`, and `appId` into a local `.env.local` file as
   described below. These are public web config values. Do not paste an Admin
   SDK JSON or any token into this file.
6. Register a production web app too, for the later migration, and record its
   web app ID and auth domain above. Do not point the spike at production.

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
root `.env.local`. Copy `spikes/firebase-auth/config.example` to `.env.local`,
replace all four values with the **test** project's web configuration, then:

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

Because the spike is an independently installed preview PWA, record this
distinction in the phone result. If it behaves differently from the installed
main app, the issue's gate is still unproven; do not infer the main PWA works.

## Test record to post on issue #10

Use the **OAuth test project**. On each platform, note browser/iOS version,
result, Firebase error code where applicable, and the UID (keep account email
out of the issue). Do not post ID tokens or configuration files.

| Check | Desktop Chrome | iPhone Safari | iPhone Home Screen preview |
| --- | --- | --- | --- |
| User-initiated popup succeeds | Pending | Pending | Pending |
| Closing/cancelling popup leaves app usable | Pending | Pending | Pending |
| Blocked popup is reported without changing existing session | Pending | Pending | Pending |
| Leave and reopen; same UID restored | Pending | Pending | Pending |
| Airplane mode; prior session/local UI remains readable | Pending | Pending | Pending |

For the Home Screen check, open the preview URL in Safari, add it to the Home
Screen, launch from its icon, tap Continue with Google, and check whether the
popup returns to that installed app. Leave/reopen the app and compare its UID.
Test with the device offline as well; first-time sign-in requires connectivity.

If the popup is unreliable, report the failure and stop issue #10. The next
decision is a Firebase Hosting move with a bridge release at the old origin;
do not start onboarding or cutover issues #12 or #15. Firebase documents the
cross-origin redirect limitations in [its redirect guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices).

# Firebase setup and operations

The Firebase client is implemented but production publication remains held.
The real-data test rehearsal completed on 2026-10-04. Use the
[rollout plan](firebase-rollout-plan.md) for remaining work and release gates,
[the migration runbook](firebase-migration.md) for imports/device recovery,
and [the rehearsal runbook](firebase-rehearsal.md) for the isolated test app.

## Project record

Web configuration is public. Admin SDK service-account JSON is private.

| Setting | Production | Test |
| --- | --- | --- |
| Project ID | `flashcards-ls9-prod` | `flashcards-ls9-auth-test` |
| Firestore location | `europe-west1`, Standard | `europe-west1`, Standard |
| Google sign-in | Enabled | Enabled |
| Authorized Pages domain | `licensedsaucer9-web.github.io` | `licensedsaucer9-web.github.io` |
| Web app ID | `1:447756082894:web:6b39de4d88f7638a817a9f` | `1:523307197531:web:171d03e6369727b4208b7e` |
| Auth domain | `flashcards-ls9-prod.firebaseapp.com` | `flashcards-ls9-auth-test.firebaseapp.com` |

Both projects were created on 2026-09-29. Spark/free-tier status and disabled
billing were confirmed then; that dated check is not a fresh billing audit.
The test database now contains the verified legacy import and newer rehearsal
reviews. Production import and rules deployment remain separate rollout work;
do not assume production is empty without inspecting it.

Test and production UIDs were confirmed separately in
[issue #10](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/10).
Keep their profile mappings private. A test-project UID cannot map a production
account.

## Build configuration

`npm ci` installs the local Firebase CLI; a global installation is unnecessary.
CI uses Node 22 and Java 21 for the Firestore emulator. `.firebaserc` defaults
to `demo-german-flashcards`; live operator commands must name their project.

Without `VITE_SYNC_BACKEND=firebase`, the app studies locally. With that flag,
the default public web configuration comes from `src/firebase-web.ts` and
selects production. An explicit override requires all four variables:

```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_APP_ID
```

Partial configuration does not fall through to production. For a real test
session use `npm run rehearsal:build`, which supplies the checked-in test
configuration, enables the import guard, clears emulator overrides, and selects
separate storage. Do not use a production-configured preview for an unmigrated
owner's first full-app login: it could provision a conflicting personal deck.

For local OAuth, authorize the actual local hostname in the test project's
Authentication settings. The Pages hostname is already recorded; local
hostname authorization was not established by the original spike. Google
provider/consent configuration belongs in Firebase Console; use only the
basic sign-in scopes. See [Google sign-in setup](https://firebase.google.com/docs/auth/web/google-signin).

## Rules and private operator files

`firestore.rules` is the source of the restrictive client rules. CI tests
rules but does not deploy them. Test deployment and read-only preflight commands
are in [the rehearsal runbook](firebase-rehearsal.md). Production deployment
belongs to its authorized rollout milestone.

Set `GERMAN_FLASHCARDS_PRIVATE_DIR` to a durable directory outside every Git
repository, with mode 700. Keep credentials, mappings, snapshots, baselines,
and reports there with mode 600. The default is
`~/.config/german-flashcards`, but this machine's tracked home makes that
location unsuitable. The tool refuses ignored files and symlinks inside Git
too. Credential filenames resolve only within the operator directory, and
their project must match the requested project.

Obtain the project's Admin SDK JSON only when its operation requires it.
See [Admin SDK setup](https://firebase.google.com/docs/admin/setup#initialize_the_sdk).
Do not commit it, put it in a build environment, or upload it to Pages.

## Private Firestore backup

The local CLI writes a one-off Admin SDK JSON dump; this does not require Blaze
and is not scheduled by CI or the application. Run it against production only
as part of the authorized backup milestone, with that project's credential.
For a test export, substitute the test project and credential together.

After setting the private directory and placing `service-account-prod.json`
there:

```bash
umask 077
MIGRATION_DIR="${GERMAN_FLASHCARDS_PRIVATE_DIR:?Set a private directory outside Git}"
mkdir -p "$MIGRATION_DIR/exports"
BACKUP_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
npm run migrate -- backup \
  --project flashcards-ls9-prod \
  --credential service-account-prod.json \
  --out "$MIGRATION_DIR/exports/firestore-$BACKUP_STAMP.json" \
  > "$MIGRATION_DIR/exports/firestore-$BACKUP_STAMP.log"
```

The output contains account metadata, each user's settings/progress, deck
membership/cards, and a SHA-256 of the serialized body. Keep its log private
too. Files are mode 600 and existing outputs are never overwritten. Check
the checksum and aggregate document counts privately.

This `kind: firestore` dump differs from the GitHub snapshot accepted by
`migrate import`. There is no CLI restore command for it yet. The emulator
suite exercises the export writer, not production backup restoration.
A restore procedure, isolated recovery rehearsal, cadence, and durable storage
are required before calling backup/recovery complete.

## OAuth spike reference

The isolated auth-only spike remains in `spikes/firebase-auth`. It imports
Authentication only and does not read/write flashcards or Firestore.

- Test identity preview: <https://licensedsaucer9-web.github.io/ls9-flashcards-site/auth-spike/>
- Production identity preview: <https://licensedsaucer9-web.github.io/ls9-flashcards-site/auth-spike-prod/>

The original test spike passed sign-in/cancel on desktop Chrome, iPhone Safari,
and the installed iPhone preview. The installed preview also restored its
session after reopening/offline use. On iOS, dismissing Google could report
`auth/network-request-failed` while leaving the prior session intact. A
headless blocked-popup check passed; Safari's popup setting did not intercept
the installed preview's synthetic-link flow. These are dated spike results,
not proof of every current full-app release.

If the auth-only tool is needed again, copy
`spikes/firebase-auth/config.example` to the ignored root `.env.local`,
fill all four test web values, then run `npm run auth-spike:dev` or:

```bash
BASE=/ls9-flashcards-site/auth-spike/ npm run auth-spike:build
```

Output is `dist-auth-spike`. Operator publication of this unlinked preview
must preserve the root site and its `rehearsal/` child. Preview workers exclude
nested preview paths. Keep old study storage intact; clearing Safari website
data can erase reviews.

GitHub Pages cannot proxy Firebase's sign-in helper. If login requires a hosting
change, use [Firebase's redirect guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices)
and address old-origin storage recovery before moving the app.

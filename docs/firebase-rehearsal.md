# Test-project environment (#23)

Use only `flashcards-ls9-auth-test`. The production publish steps stay held.
The full-app rehearsal URL is:

<https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike/rehearsal/>

The auth-only identity preview is its parent:
<https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike/>.
Neither preview is linked from the public root app.

## Private credential and account inspection

Use the private operator directory selected in #22; set
`GERMAN_FLASHCARDS_PRIVATE_DIR` to it in the operator shell. Home is tracked
by Git on this machine, so the default `~/.config` location is refused.
Keep `service-account-auth-test.json` there with mode 600 and its parent
directory with mode 700. The credential is for the test project's existing
Firebase Admin SDK service account, never production. Firebase/Google Cloud
supports obtaining its JSON key through the console or IAM API; see
[Admin setup](https://firebase.google.com/docs/admin/setup) and
[service-account key creation](https://cloud.google.com/iam/docs/keys-create-delete).
Allow a newly created key to propagate before checking it; do not create
another key to retry a transient authentication failure.

The same Admin store and credential confinement as the importer are used by:

```bash
npm run rehearsal:preflight -- \
  --out "$GERMAN_FLASHCARDS_PRIVATE_DIR/REPLACE_WITH_TIMESTAMP-preflight.json"
```

This is read-only. It requires the confirmed `migration-map-auth-test.json`,
refuses a non-test project, and checks account schema/deck assignment and exact
legacy deck membership. It refuses a conflicting personal deck or a missing
deck for an existing assignment. Standard output gives aggregate state; the
mode-600 report retains exact metadata privately. Existing reports are never
overwritten. Resolve a conflict explicitly while preserving existing records.

Before #24, Joakim's account and legacy deck should be absent. After the
import they must match the confirmed legacy assignment. The client will
accept only that account after the importer marks it complete; a pending or
missing account cannot trigger personal-deck creation in this preview.

## Deploy restrictive test rules

Run from the source revision you are recording:

```bash
npm exec -- firebase deploy --only firestore:rules \
  --project flashcards-ls9-auth-test --non-interactive
```

Record the source revision, rules checksum, release identifier, and date
privately. This is an operator command; CI and pull requests do not deploy
rules. Production rules are outside this issue.

## Build and publish the isolated full app

```bash
npm run rehearsal:build
```

The command supplies all four public web configuration values from
`spikes/firebase-rehearsal/web-config.json`, selects the Firebase backend,
enables the rehearsal guard and separate storage, clears emulator overrides,
and records the Git source revision in the visible test label. Build from the
committed source revision that will be published. Output is `dist-rehearsal`.
Its automatic artifact check requires the test project, rejects production
configuration and private files, and checks the nested manifest/start URL.
The default production artifact check retains its production-project requirement.

Publish that output only to `auth-spike/rehearsal/` in the public site's
`gh-pages` checkout. Keep root files byte-for-byte unchanged. The root worker
already excludes `auth-spike/`; the auth-only parent worker must also exclude
`rehearsal/`. If restoring the auth-only preview, build it with all four test
web values and `BASE=/german-flashcards-site/auth-spike/`, copy it to
`auth-spike/` while preserving the `rehearsal/` child, then copy the full app
into that child. Stage only the preview directory. Record the public-site
commit after deployment.

The full app uses `german-flashcards-rehearsal` local databases and preferences.
It preserves the legacy app's profile list, progress/settings, and PAT keys
on the shared origin. It does not copy device-only legacy data; that belongs
to the production/device-recovery milestone. Google authentication uses the
separate test project's Firebase persistence. Until #24 completes the import,
use **Study on this device**. A Google login before then reports that the
account is waiting for import and makes no account/deck provisioning writes.

## Check the published result

```bash
PREVIEW_REVISION=REPLACE_WITH_FULL_SOURCE_SHA npm run rehearsal:check
APP_URL=https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike/rehearsal/ \
  node scripts/installable.mjs
```

The live check uses a fresh Chromium context. It installs the existing root
and auth-only parent workers, then checks the actual full-app preview, project
label, revision, manifest scope, and separate guest database. Legacy database
records, preferences, and sentinel PAT keys must remain exactly unchanged.
Installability also exercises guest study, mobile controls, and offline reload.
These checks do not sign into Google and do not replace a physical iPhone check.

On an iPhone, open the exact rehearsal URL in Safari. Confirm the **Test
rehearsal** label, test project, and source revision; choose **Study on this
device**, and confirm the study screen loads. Keep existing study installations
and storage. Record the device/browser, date, source revision, and result on
#23. Do not call that check passed based only on a desktop mobile viewport.

Scan with the iPhone camera to open the rehearsal:

![QR code for the rehearsal URL](rehearsal-qr.png)

[Open the rehearsal URL directly](https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike/rehearsal/)

After preview checks, rerun the read-only preflight to confirm Joakim's test
account has not been provisioned. Record the environment evidence on #23;
the real import is #24 and real second-device restoration is #25.

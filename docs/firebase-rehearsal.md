# Isolated test-project rehearsal runbook

Use only `flashcards-ls9-auth-test`; this is an isolated test-project preview,
not the production app. Production Firebase `1.2.0` is already published. The
full-app rehearsal URL is:

<https://licensedsaucer9-web.github.io/ls9-flashcards-site/auth-spike/rehearsal/>

The auth-only identity preview is its parent:
<https://licensedsaucer9-web.github.io/ls9-flashcards-site/auth-spike/>.
Neither preview is linked from the public root app.

The environment (#23), real import (#24), and real second-device verification
(#25) are complete as of 2026-10-04. The recorded physical-device result used
app revision `10d48ab`. Account UI fixes from #28–#29 are merged in current
source, but those PRs did not publish them or record a physical iPhone check.
The rename release published the test preview at `bdf9b15`; its automated
live checks are recorded in [the rename record](rename.md). No new physical
iPhone or real Google sign-in result is claimed for that revision.
Always compare the visible deployed revision with the revision under test.
The initial `1.0.0` production release and device-acceptance gates are complete. The
[rollout plan](firebase-rollout-plan.md) records the remaining off-machine
backup closeout; this test-project rehearsal is not a production gate.

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

The pre-import #23 inspection recorded Joakim's account and legacy deck absent.
The completed #24 import now provides the confirmed legacy assignment, with
newer reviews/settings from #25. Inspect that current state; do not recreate
the empty pre-import environment. The client will
accept only that account after the importer marks it complete; a pending or
missing account cannot trigger personal-deck creation in this preview.

## Deploy restrictive test-project rules

Run from the source revision you are recording:

```bash
npm exec -- firebase deploy --only firestore:rules \
  --project flashcards-ls9-auth-test --non-interactive
```

Record the source revision, rules checksum, release identifier, and date
privately. This is an operator command; CI and pull requests do not deploy
rules. Production rules are deployed; this command only targets the isolated test project.

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
web values and `BASE=/ls9-flashcards-site/auth-spike/`, copy it to
`auth-spike/` while preserving the `rehearsal/` child, then copy the full app
into that child. Stage only the preview directory. Record the public-site
commit after deployment.

The full app uses `german-flashcards-rehearsal` local databases and preferences.
It preserves the legacy app's profile list, progress/settings, and PAT keys
on the shared origin. It does not copy device-only legacy data; production
legacy recovery was waived and the retired application is no longer used by
anyone.
Google authentication uses the
separate test project's Firebase persistence. A verified mapped account opens
its imported deck. Other or pending accounts report that their verified import
is required and make no account/deck provisioning writes; **Study on this
device** remains available. In current source, a guarded authenticated session
shows **Signed in to Google** and **Sign out of Google**, with the sign-in
button hidden, including restored sessions and local-study Settings. Those
controls require a preview built from the corresponding merged revision.

## Check the published result

```bash
PREVIEW_REVISION=REPLACE_WITH_FULL_SOURCE_SHA npm run rehearsal:check
APP_URL=https://licensedsaucer9-web.github.io/ls9-flashcards-site/auth-spike/rehearsal/ \
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
and storage. For a new account-UI release, exercise real login, cancellation,
restored session, and sign-out in Safari and the installed app as applicable.
Record device/browser, date, source revision, and result. A desktop mobile
viewport does not establish a physical iPhone result.

Scan with the iPhone camera to open the rehearsal:

![QR code for the rehearsal URL](rehearsal-qr.png)

[Open the rehearsal URL directly](https://licensedsaucer9-web.github.io/ls9-flashcards-site/auth-spike/rehearsal/)

After preview checks, rerun the read-only preflight and compare account/deck
assignment with the expected imported state. Guest/guarded-session checks must
not create a personal deck or alter legacy membership. Record aggregate
results; keep exact state private. The completed real-data result is in
[the import record](issue-24-status.md) and
[the final #25 verification](https://github.com/licensedsaucer9-web/ls9-flashcards/issues/25#issuecomment-5980511235).
Reviews on a mapped account are real test-project writes; they are not a
read-only preview check or authorization for production operations.

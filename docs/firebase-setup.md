# Firebase setup and operations

The Firebase client is the authorized production build as of 2026-10-07.
A new account receives the built-in deck with no studied progress. Use the
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
reviews. Production has been serving Firebase study since 2026-10-07; legacy
studied-data import was waived. The latest recorded production rules deployment
was verified on 2026-10-16. See the [operating record](firebase-rollout-plan.md#current-operations--2026-10-17);
do not assume either database is empty.

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

## Prepare and verify a release candidate

The #38 release tooling now builds the published Firebase client. Production
study is live, and legacy import/device recovery (#37) was waived on 2026-10-07.
Both Pages publish steps use matching master-only/non-PR guards: pushes to
master publish after CI; pull requests do not publish. These local commands
build or read public artifacts; they do not deploy rules, import data, sign into
Google or publish.

Use Node 22 and a clean, committed source checkout. Keep operator credentials
and real records out of the build environment. Dependencies remain locked:

```bash
npm ci
npm test
npm run test:account-ui
npm run test:rules # Java 21; isolated demo Firestore emulator
npm run release:build
npm run release:verify
```

The builder pins actual Git HEAD, requires no source changes before/after
the build, selects the production public web config and `/ls9-flashcards-site/`,
and clears preview/bridge/emulator overrides. It refuses test/device/bridge
artifacts, an unversioned package, wrong project/base, or dirty source as
candidates. Both publication conditions must keep the same exact
master-only/non-PR guard. Ordinary development
builds still work and mark local changes. The package version is `1.4.0`.

`dist-firebase/release.json` identifies version, full source commit, backend,
project, base, mode, emulator flag and public-site repository. The same values
are compiled into the app. Settings → Install shows version and short source
commit even offline; the worker also caches `release.json`.
`release-candidate.json` binds that identity to a sorted SHA-256 inventory of
all deployable files, excluding the inventory itself to avoid a checksum cycle.
Local verification rejects changes, omissions and extra files. These hashes
bind bytes to a reviewed candidate; they do not prove migration or device
acceptance, and do not sign an untrusted artifact.

Run installability against the built candidate with a disposable browser profile
and device study; do not sign the unmigrated owner into production. In two terminals:

```bash
BASE=/ls9-flashcards-site/ npm run preview -- --outDir dist-firebase --strictPort
APP_URL=http://127.0.0.1:4173/ls9-flashcards-site/ node scripts/installable.mjs
```

CI runs these checks, the isolated test rehearsal and unpublished recovery
bridge checks, then verifies and uploads `firebase-candidate-SOURCE_SHA`.
The upload includes `.nojekyll` after the artifact's private-file checks and
expires after 14 days. Save the verified archive durably outside Git if the
operational gate will take longer. Preserve its inventory fingerprint and CI
run/check results. A rebuilt PR or master commit is a different candidate and
needs its own checks; do not mix files from different builds.

Publication uses the exact tested `dist-firebase` bytes with both existing
master-only/non-PR conditions kept together. The workflow retains `auth-spike/`
and `auth-spike-prod/` during root cleanup for the historical previews. The separate old
Pages URL was retired by owner decision on 2026-10-17; its repository is archived
and its application/redirect replaced by a 404-only deployment. The unpublished bridge build/test remains historical
tooling, not an active recovery route. See the [retirement record](rename.md#old-site-retirement-2026-10-17). Pages does not deploy rules;
a local candidate build does not itself publish, deploy rules or migrate data.

After the candidate is actually served, keep the matching local artifact and
record the public `gh-pages` commit. The read-only check is:

```bash
npm run release:verify -- --served --site-commit FULL_PUBLIC_SITE_COMMIT
```

It checks that public branch before/after comparison, fetches the served
inventory and every public candidate file, and rejects stale/different/missing
bytes. `.nojekyll` is verified locally as a deployment marker; Pages need not
serve dotfiles. The output records version, source/site commits, artifact
fingerprint, verified file count and served URL, without UIDs or record values.
Save the receipt with operational evidence. No public-site commit is invented
in the build: publication creates it later.

Then verify running Settings version/source on desktop, Safari and each Home
Screen installation after its worker update and after reopening offline.
Record date, device/browser/OS, URL, source/site revisions and update outcome.
A successful HTTP comparison does not prove every installed client updated;
the historical #38/#39 results do not establish that every later client updated.
Retain a known-good artifact. After Firebase study exists, rollback uses a
compatible Firebase client and retains its data, rather than restoring the
legacy writer over it.

## Rules and private operator files

`firestore.rules` is the source of the restrictive client rules. CI tests
rules but does not deploy them. Test deployment and read-only preflight commands
are in [the rehearsal runbook](firebase-rehearsal.md). Production deployment
is an operator action separate from Pages. The last recorded production
deployment was verified on 2026-10-16 with SHA-256
`863c8e03c918d81a67e88f166ca109bfe93c45c48f22b5ecf6dbfc9a3a1086f1`;
see the [operating record](firebase-rollout-plan.md#current-operations--2026-10-17).

Set `GERMAN_FLASHCARDS_PRIVATE_DIR` to a durable directory outside every Git
repository, with mode 700. Keep credentials, mappings, snapshots, baselines,
and reports there with mode 600. The default is
`~/.config/german-flashcards`. The original rehearsal host tracked home in Git,
making that default unsuitable there; inspect the current Git boundaries before
choosing it. The tool refuses ignored files and symlinks inside Git
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

The output contains account metadata, each user's settings/progress/streak activity, deck
membership/cards, and a SHA-256 of the serialized body. Keep its log private
too. Files are mode 600 and existing outputs are never overwritten. Check
the checksum and aggregate document counts privately.

On this machine the daily command is `node --experimental-strip-types
scripts/firestore-backup.mjs`. It reads production through the logged-in
Firebase CLI, writes the same private dump, and records aggregate counts,
checksum, and elapsed time in `backup-status.json`. The user timer
`firestore-backup.timer` runs that command at 08:30 and keeps 14 dumps.
Stdout is the status object. A failed run writes `ok: false` and a non-zero
exit. A separate `firestore-drive-copy.timer` runs an rclone copy of dumps and
`backup-status.json` to the configured off-machine backup destination at 08:45.
The local backup and copy jobs both succeeded on 2026-10-17. Their private
configuration stays on the host; a successful copy job is not a restore drill.

The 2026-10-17 scheduled backup reported the `activity` collection's aggregate
count. Older backups without activity remain readable. Keep operational and
device evidence separate in the [#58 release checklist](firebase-rollout-plan.md#forgiving-streaks--58).

The #74 source writes version-2 dumps, including extra deck ownership/cards,
per-deck settings/progress, and tombstones alongside the unchanged German paths
and account-wide activity. Version-1 dumps still restore the original deck.
Extra-deck nested parent documents need not exist. Aggregate settings/progress
counts include every deck. The daily runner's source checkout was updated to
this code on 2026-10-17, after that morning's backup/copy. No new live dump was
triggered by the update. Record a subsequent version-2 dump and isolated restore
of extra-deck settings/progress/tombstones before declaring that coverage
qualified. The configured off-machine copy and its successful job are separate
from that restore evidence.

This `kind: firestore` dump differs from the GitHub snapshot accepted by
`migrate import`. Restoring it does not recreate Google Auth identities,
browser IndexedDB or pending device work, deployed security rules, or hosting.
Confirm UID ownership separately; do not invent identity mappings. Production
restore is not authorized by this command. Restore drills use an isolated
emulator project, not `flashcards-ls9-prod` or `flashcards-ls9-auth-test`.

## Production preflight

`npm run migrate -- preflight` binds this source revision to project
`flashcards-ls9-prod`, public base `/ls9-flashcards-site/`, legacy base
`/german-flashcards-site/`, authorized hosts
`licensedsaucer9-web.github.io` and `flashcards-ls9-prod.firebaseapp.com`,
and the SHA-256 of `firestore.rules` and `firebase.json`. Both Pages publish
steps must stay `if: ${{ false }}`. Stdout is one JSON object of blockers,
checksums, and device-route counts. Rules deployment, Admin access, UID
confirmation, production inspection, backup, and publication stay outside
this command.

A private `--out` report repeats that fingerprint. It records this rules
command with `executed: false`:

```text
npx firebase deploy --only firestore:rules --project flashcards-ls9-prod
```

Reuse the package only when the data-repo commit, this source revision, and
the rules checksum are unchanged, and a fresh read-only capture matches the
saved reviewed server evidence. Compare the relevant document IDs, values,
clocks, assignments, and memberships with that capture, or compare a canonical
checksum of that state. Leave the capture time out of the checksum. Collection
counts are an additional check. Matching counts do not show that the server is
unchanged. The importer keeping a newer server value does not mean the
reviewed dry run still describes the target. An unavailable server comparison
or checksum blocks reuse. A difference invalidates the reviewed dry run:
create a new export, baseline, dry run, and preflight, and review that
evidence before an authorized apply. This command leaves legacy writes running.
The historical compatibility-site rollback revision is
`1dbc26214bb3bfe1e132edc94688bd3137c1e996`. Its hosting was retired on 2026-10-17;
this is not a live rollback route. After Firebase study exists, roll
back with a Firebase-compatible client and keep that data. The production
backup command is the one in the previous section; preflight leaves it
unrun.

`service-account-prod.json` and `migration-map-prod.json` are the expected
private filenames. The command checks only whether those names exist outside
Git. A present file is not a confirmed production UID, and file contents stay
out of stdout. This command does not read production, so the server
fingerprint stays unavailable and blocks reuse. Device routes stay blocked
until #34 has a private inventory and a saved same-context read, so this
package stays `ready: false`.

```bash
umask 077
npm run migrate -- preflight \
  --out "$MIGRATION_DIR/exports/preflight-$BACKUP_STAMP.json"
```

## Restore a Firestore dump

`npm run migrate -- restore` validates the checksum, supported paths, record
shapes, clocks, tombstones, and account/deck membership before it opens a
client. The default is a read-only dry run. `--apply` creates documents that
are missing and leaves identical documents unchanged. A target document that
differs, is newer, or is not in the dump fails closed before the first write.
There is no overwrite mode. Repeat the same dump, project, and credential
with a new `--report` file to resume after an interruption. An unchanged
repeat does not add documents.

Stdout is one JSON line: aggregate counts, the dump checksum, and
`elapsedMs`. Path-level differences go only to `--report` (mode 600). Keep
both files private. The command refuses `flashcards-ls9-prod` and
`flashcards-ls9-auth-test`. Use the emulator or another empty demo project.

```bash
umask 077
npm run migrate -- restore \
  --dump "$MIGRATION_DIR/exports/firestore-$BACKUP_STAMP.json" \
  --project demo-restore-rehearsal \
  --credential service-account.json \
  --report "$MIGRATION_DIR/exports/firestore-$BACKUP_STAMP.restore.json" \
  --emulator
```

Add `--apply` only after that dry run reports creates and zero conflicts,
newer documents, and extras. Record `elapsedMs` and the checksum outside
Git. For a live throwaway project, pass that project's credential and omit
`--emulator`. The credential's `project_id` must equal `--project`.

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

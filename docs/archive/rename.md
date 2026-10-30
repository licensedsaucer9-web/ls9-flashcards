# LS9 Flashcards rename

The user selected **LS9 Flashcards** and requested the app, GitHub repositories,
and public URL rename before continuing development on 2026-10-04.

| Purpose | Current name / URL |
| --- | --- |
| Application source (private) | [ls9-flashcards](https://github.com/licensedsaucer9-web/ls9-flashcards) |
| Legacy data (private) | [ls9-flashcards-data](https://github.com/licensedsaucer9-web/ls9-flashcards-data) |
| Built site (public) | [ls9-flashcards-site](https://github.com/licensedsaucer9-web/ls9-flashcards-site) |
| Public app | <https://licensedsaucer9-web.github.io/ls9-flashcards-site/> |
| Test rehearsal | <https://licensedsaucer9-web.github.io/ls9-flashcards-site/auth-spike/rehearsal/> |
| Retired old-installation URL (404 page, plus kill-switch workers since 2026-10-26) | `https://licensedsaucer9-web.github.io/german-flashcards-site/` |

## Old-site retirement, 2026-10-17

Joakim explicitly requested retirement of `german-flashcards-site`, confirming
that the two known users do not need the old redirect. The published app and
redirect have been replaced by a minimal 404-only deployment, and the repository
is archived with its history/assets retained; it was not deleted. This is the
owner's retirement decision, not a claim that an
agent inspected devices, verified unsynced records, or recovered legacy progress.
Legacy studied-data import and device recovery were waived on 2026-10-07.

The old root was a redirect and its service worker redirected old clients and
unregistered itself. Historical assets/previews remained in Git. The current
source workflow publishes only to `ls9-flashcards-site`, so disabling the old
app does not remove a deployment dependency. Known references to the old path
are the historical migration/preflight runbooks and unpublished recovery-bridge
build/tests; those do not require live hosting. The two known users do not need
continued forwarding of old shared links. No tracking or analytics was added.

The retirement record is
[german-flashcards-site#1](https://github.com/licensedsaucer9-web/german-flashcards-site/issues/1).
The pre-retirement `gh-pages` revision is
`6bfcdecc8dbf506ac22e155adc5c855ea170b670`. Re-enabling the old Pages path or
publishing its recovery bridge requires a new authorized operation. Current app
hosting, Firebase data, the archived legacy data repository, and browser storage
are retained. An old cached offline installation is not remotely erased or
upgraded by removing hosting; current icons/bookmarks must use the current URL.

GitHub rejected the Pages-disable API request with HTTP 422, "Deactivating
GitHub pages for this repository is not allowed." Pages remains configured,
publishing only `gh-pages:/docs`, which contains `.nojekyll` and `404.html`.
The original root, worker, assets and test previews remain in Git, outside the
publishing directory. On 2026-10-26 (`gh-pages` commit `7d48bdb`, issue #119) the
repository was unarchived briefly to add self-removing `sw.js` workers at
`docs/`, `docs/auth-spike/`, `docs/auth-spike-prod/` and
`docs/auth-spike/rehearsal/`: a browser that still has an old worker installed
fetches the new file, clears that scope's caches, unregisters and opens the new app;
then the repository was archived again. A bare 404 had left those workers (and the cached
legacy app) in place. This removes the hosted app/redirect without deleting
history or falsely claiming that the Pages configuration was disabled.

The sections below record the historical 2026-10-04 rename and publication,
including compatibility behavior that no longer represents live hosting.

The package is `ls9-flashcards`. App headings, HTML/Apple metadata, manifests,
icons, and documentation use LS9 branding. The short installed label is
**LS9 Cards**; the separate test preview uses **LS9 Test**. QR codes point to
the new public and rehearsal URLs.

## Historical rename behavior — 2026-10-04

The following existing-installation and release-boundary details describe the
October 4 branding release. Firebase went live October 7, and the old URL was
retired October 17 as recorded above; held-publication and compatibility-client
statements below are historical, not current operating instructions.

### Existing installations

IndexedDB/localStorage prefixes, Firebase project IDs, emulator IDs, card/deck
IDs, and `GERMAN_FLASHCARDS_PRIVATE_DIR` retain their original values. Existing
local checkout directories may also retain their old names; they are filesystem
locations, not product identity.

[GitHub repository renames](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
preserve repository redirects, but do not redirect project-site URLs. Source
and data repository names are not reused, so their redirects remain available.
The old public-site name is deliberately reused for a temporary compatibility
repository serving the old Pages path, with the renamed legacy client and
its original service-worker/manifest scope.

The compatibility app links to the new address without forcing navigation or
deleting/copying local storage. Keep older Safari/Home Screen installations
until their device-only work is recovered and acknowledged. Do not infer that
a new Home Screen icon shares every old installation's storage.

### Release boundary

This is a branding/URL release of the existing GitHub-sync client, based on
source commit `1a833b7260166429171f965ed798f79a6fc14626`, with its rename changes
retained on branch `rename/legacy-public`. The new default data-repository name
is also used when an existing default-owner configuration has the old name.
Stored tokens, revision clocks, and data files remain intact.

The production Firebase client is still staged. Both production publication
steps remain disabled. The test-only previews are published with the new
branding at their corresponding new and compatibility paths. Authorized
Firebase domains use the unchanged `licensedsaucer9-web.github.io` hostname;
no project/UID reassignment is part of this rename.

The [rollout plan](../firebase-rollout-plan.md) owns later production cutover,
device recovery, token retirement, and retirement of the compatibility site.

## Deployment and verification, 2026-10-04

| Artifact | Published revision |
| --- | --- |
| Current source and test preview | `bdf9b152bc4f65e09623a414bbd005e6a2e81cad` |
| Legacy client source (`rename/legacy-public`) | `925fc60b12f039f7a5b040fd02a84a81f40625ee` |
| New site's `gh-pages` | `fe39ae7440a6c4d44d67b18f65781b99238b33b1` |
| Compatibility site's `gh-pages` | `1dbc26214bb3bfe1e132edc94688bd3137c1e996` |
| Data repository documentation | `2079043ad6afd2a5c3c2eef330efdf7962e1d7e8` |

Both Pages sites report successful builds. Their live titles, manifests,
release records, service workers, offline reload, mobile controls, and Chromium
installability checks passed. The live rehearsal check verified the expected
source/test project, nested worker scopes, separate guest storage, and unchanged
legacy storage sentinels. Local browser checks confirmed the legacy database
names and a single-line heading at 320px and 390px.

[Source CI](https://github.com/licensedsaucer9-web/ls9-flashcards/actions/runs/37214229420)
passed unit, account UI, emulator rules/sync/migration, Firebase artifact,
offline installation, and rehearsal checks. The legacy client's tests and
artifact checks passed, as did the data repository's three verifier tests.
The data repository change touched documentation and a script docstring only.

This release did not perform live Google sign-in, provision accounts, import
data, deploy production Firebase rules, or change stored study records. The
physical-device rehearsal evidence remains the earlier #25 result; desktop
mobile viewports do not establish a new iPhone result.

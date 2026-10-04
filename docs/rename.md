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
| Old-installation compatibility | <https://licensedsaucer9-web.github.io/german-flashcards-site/> |

The package is `ls9-flashcards`. App headings, HTML/Apple metadata, manifests,
icons, and documentation use LS9 branding. The short installed label is
**LS9 Cards**; the separate test preview uses **LS9 Test**. QR codes point to
the new public and rehearsal URLs.

## Existing installations

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

## Release boundary

This is a branding/URL release of the existing GitHub-sync client, based on
source commit `1a833b7260166429171f965ed798f79a6fc14626`, with its rename changes
retained on branch `rename/legacy-public`. The new default data-repository name
is also used when an existing default-owner configuration has the old name.
Stored tokens, revision clocks, and data files remain intact.

The production Firebase client is still staged. Both production publication
steps remain disabled. The test-only previews can be rebuilt with the new
branding at their corresponding new and compatibility paths. Authorized
Firebase domains use the unchanged `licensedsaucer9-web.github.io` hostname;
no project/UID reassignment is part of this rename.

The [rollout plan](firebase-rollout-plan.md) owns later production cutover,
device recovery, token retirement, and retirement of the compatibility site.

# Issue #10 pickup note — 2026-09-29

Work continues on draft PR [#16](https://github.com/licensedsaucer9-web/german-flashcards/pull/16), which has `Fixes #10`. Do not merge or start the vibe-handoff review yet. The normal app is still GitHub-backed; the unlinked Firebase auth preview is separate and does not read or write Firestore or flashcards.

The OAuth test project is `flashcards-ls9-auth-test`; its UID is `ZcNqtHRh2BfjAhQMxHxOMrrW8EB2`. The production project is `flashcards-ls9-prod`; its separately recorded UID for later migration mapping is `1t9SLr7YDtez9n9k2f455iKyFvX2`. Both UIDs and the phone results are on [issue #10](https://github.com/licensedsaucer9-web/german-flashcards/issues/10). Project setup and remaining checks are in [firebase-setup.md](firebase-setup.md).

The [test preview](https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike/) is installed on Joakim's iPhone Home Screen. A Google popup returned to it successfully; the test UID survived leaving/reopening, an Airplane Mode reopen, and an offline sign-in error. Reconnecting restored the online indicator and sign-in returned the same UID. The main app's service worker had initially captured the preview path; that was fixed on the live Pages site and in PR #16. Do not clear Safari website data because it may hold local flashcard progress.

Joakim dismissed a Google window after one tap while already signed in. The existing UID remained, but the preview reported `auth/cancelled-popup-request`, so a clean cancellation result is still unverified. The preview was updated to guard against overlapping popup requests and published to Pages. The live test bundle contains that guard. Headless Chromium now reports `auth/popup-closed-by-user` for one dismissed popup, and a forced-blocked popup reports `auth/popup-blocked` without changing the signed-out UID. Both Firebase projects are Spark: Cloud Billing reports billing disabled and no linked account, and both `europe-west1` databases have no collections.

Closing the Google window on the installed iPhone PWA often left the screen on Opening Google sign-in. Firebase keeps no window handle in that mode, so `signInWithPopup` never rejects. Preview revision 2 recovers when the page is back in front, and a later tap on Continue with Google clears a stuck attempt instead of opening a second popup.

**Next:** with the iPhone online, close and reopen the installed Auth Check app until the page says Preview revision 2. Tap Continue with Google once, dismiss the window, and record whether the screen leaves Opening Google sign-in, the exact error code, and whether the same UID remains.

After that, complete the remaining issue #10 checks: iPhone Safari sign-in/cancellation, installed-preview blocked popup, and desktop Chrome. Update the issue record and PR. Only start the vibe-handoff review once the issue's required checks are addressed. Remove the temporary preview directories after testing.

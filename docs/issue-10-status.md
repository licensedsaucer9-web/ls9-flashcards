# Issue #10 pickup note — 2026-09-29

Work continues on draft PR [#16](https://github.com/licensedsaucer9-web/german-flashcards/pull/16), which has `Fixes #10`. Do not merge or start the vibe-handoff review yet. The normal app is still GitHub-backed; the unlinked Firebase auth preview is separate and does not read or write Firestore or flashcards.

The OAuth test project is `flashcards-ls9-auth-test`; its UID is `ZcNqtHRh2BfjAhQMxHxOMrrW8EB2`. The production project is `flashcards-ls9-prod`; its separately recorded UID for later migration mapping is `1t9SLr7YDtez9n9k2f455iKyFvX2`. Both UIDs and the phone results are on [issue #10](https://github.com/licensedsaucer9-web/german-flashcards/issues/10). Project setup and remaining checks are in [firebase-setup.md](firebase-setup.md).

The [test preview](https://licensedsaucer9-web.github.io/german-flashcards-site/auth-spike/) is installed on Joakim's iPhone Home Screen. A Google popup returned to it successfully; the test UID survived leaving/reopening, an Airplane Mode reopen, and an offline sign-in error. Reconnecting restored the online indicator and sign-in returned the same UID. The main app's service worker had initially captured the preview path; that was fixed on the live Pages site and in PR #16. Do not clear Safari website data because it may hold local flashcard progress.

Joakim dismissed a Google window after one tap while already signed in. The existing UID remained, but the preview reported `auth/cancelled-popup-request`, so a clean cancellation result is still unverified. The preview was updated to guard against overlapping popup requests and published to Pages. The live test bundle contains that guard. Headless Chromium now reports `auth/popup-closed-by-user` for one dismissed popup, and a forced-blocked popup reports `auth/popup-blocked` without changing the signed-out UID. Both Firebase projects are Spark: Cloud Billing reports billing disabled and no linked account, and both `europe-west1` databases have no collections.

Closing the Google window on the installed iPhone PWA often left the screen on Opening Google sign-in. Firebase keeps no window handle in that mode, so `signInWithPopup` never rejects. Preview revision 2 recovers when the page is back in front, and a later tap on Continue with Google clears a stuck attempt instead of opening a second popup.

When the dismiss does not hang, the preview reports `auth/network-request-failed`. That is Firebase's helper iframe on `firebaseapp.com` failing while iOS has the page in the background. The connection indicator can still say online. Preview revision 3 says so on the screen next to the code.

On Preview revision 3, Joakim dismissed one Google window on the installed Auth Check app. The screen did not stay on Opening Google sign-in. The code was `auth/network-request-failed`, with the helper explanation, and the connection line could stay online. The UID was unchanged.

In iPhone Safari, Joakim cancelled with the back button. The code was `auth/popup-closed-by-user` and the UID was unchanged.

In iPhone Safari, a completed Google sign-in showed the same test UID.

**Next:** installed Auth Check blocked popup. In iOS Settings, turn on Safari → Block Pop-ups, open the installed app, tap Continue with Google once, and record the error code and whether the UID stays the same. Turn Block Pop-ups off again afterward. Desktop Chrome remains after that. Only start the vibe-handoff review once the issue's required checks are addressed. Remove the temporary preview directories after testing.

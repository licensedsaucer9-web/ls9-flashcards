> Written by Codex (gpt-6.1-sol) on 2026-10-10. These are proposals, not decisions.

# Plan: LS9 Flashcards for iOS and Android stores

**Recommendation:** ship bundled Capacitor apps first, sharing the existing TypeScript application and Firebase data. Make native authentication, reliable offline startup, account deletion, mobile file handling, and signed releases mandatory. Reconsider React Native if a device spike shows that the shared web UI cannot meet the desired experience.

This is a planning proposal only. No files, issues, PRs, branches, commits, pushes, or deployments were changed. If adopted, incorporate this workstream into [docs/firebase-rollout-plan.md](../../docs/firebase-rollout-plan.md), which remains the repository’s active plan.

## 1. Evidence and starting point

| Finding | Evidence and implication |
|---|---|
| The released application is `1.2.0`, with Firebase sync and device-only study. | [package.json](../../package.json#L4), [README.md](../../README.md#L7). Preserve the deployed PWA throughout mobile delivery. |
| The UI is plain TypeScript, HTML, and CSS; it is not a React application. | DOM rendering and hash navigation in [src/main.ts](../../src/main.ts#L69), dependencies in [package.json](../../package.json#L25). React Native would require a UI rewrite. |
| Local writes and their pending sync markers commit together in IndexedDB. Firestore uses an in-memory cache. | [src/db.ts](../../src/db.ts#L450), [src/cloud-on.ts](../../src/cloud-on.ts#L430). Preserve this explicit durable queue. |
| Accounts use Firebase UID identity, separate local databases, and one assigned deck. | [src/user.ts](../../src/user.ts#L73), [src/provision.ts](../../src/provision.ts#L22). Mobile clients should open the same account and deck. |
| Google authentication currently uses `signInWithPopup`. Account adoption attempts online provisioning before binding the account database. | [src/cloud-on.ts](../../src/cloud-on.ts#L258), [src/cloud-on.ts](../../src/cloud-on.ts#L328). Native login and offline cold startup need dedicated work. |
| The private legacy vocabulary file contains 514 unique cards, zero tombstones, and vocabulary fields matching all 514 bundled seeds. One separate profile file contains 514 progress records. | Read-only aggregate inspection of [data.json](https://github.com/licensedsaucer9-web/ls9-flashcards-data/blob/main/data.json), [users/joakim.json](https://github.com/licensedsaucer9-web/ls9-flashcards-data/blob/main/users/joakim.json), and [src/seed.ts](../../src/seed.ts#L535). Package the seed; never package personal progress. |
| Physical deletion is forbidden by current rules; ordinary card deletion creates a tombstone that can retain vocabulary text. | [firestore.rules](../../firestore.rules#L105), [src/record-sync.ts](../../src/record-sync.ts#L254). Card deletion is insufficient for account erasure. |
| Restore supports the optional v1.2.0 `wordTypes` setting. | Settings can contain `wordTypes` in [src/firestore-docs.ts](../../src/firestore-docs.ts#L60). This change accepts settings with or without a valid optional `wordTypes` list; invalid lists and unrelated extra settings keys still fail. [scripts/restore-core.mjs](../../scripts/restore-core.mjs#L83). |
| Daily private backups and an isolated production-dump restore are recorded; an off-machine copy remains outstanding. | [AGENTS.md](../../AGENTS.md#L6), [docs/firebase-rollout-plan.md](../../docs/firebase-rollout-plan.md#L265). Mobile release must not imply that outstanding protection already exists. |

Some older passages describe a held release or legacy writer. Use the current release statement in [README.md](../../README.md#L7) and operating boundaries in [AGENTS.md](../../AGENTS.md#L13), rather than reopening completed or waived migration work.

## 2. Goals and non-goals

### Goals

- Release useful, polished iOS and Android applications through App Store and Google Play.
- Preserve the existing review behavior, tiers, word-type filters, editing, and CSV import. These are implemented in [src/main.ts](../../src/main.ts#L366), [src/srs.ts](../../src/srs.ts), and [src/csv.ts](../../src/csv.ts#L127).
- Allow immediate offline guest study with the bundled deck, and offline study of previously downloaded account data.
- Share account data between PWA, iOS, and Android without resetting schedules, changing card IDs, or duplicating accounts.
- Add store-compliant authentication, privacy disclosures, and account/data deletion.
- Establish repeatable signing, beta distribution, release evidence, and recovery procedures.

### Non-goals for the first store release

- Multiple decks, public sharing, subscriptions, advertising, FSRS, or review-event history. Existing product boundaries are documented in [README.md](../../README.md#L9) and [docs/firebase-rollout-plan.md](../../docs/firebase-rollout-plan.md#L278).
- Reimporting archived studied data or recovering waived legacy device contexts. Those were explicitly waived in [AGENTS.md](../../AGENTS.md#L13).
- Guaranteed background uploads or immediate cross-device updates. Current sync is foreground-based and has no realtime listener: [docs/architecture.md](../../docs/architecture.md#L96).
- Server push reminders as a launch prerequisite. They are an optional extension described below.

## 3. Options and recommendation

Relative effort below is an architectural judgment based on the actual DOM UI and browser storage dependencies, not a delivery estimate.

| Option | Reuse and required work | Recommendation |
|---|---|---|
| **Capacitor with bundled assets** | Reuses the DOM UI, CSS, scheduler, parsers, IndexedDB, and most sync code. Adds native projects and adapters for authentication, lifecycle, files, and optional notifications. Capacitor supports adding native projects to an existing web application. [Capacitor installation](https://capacitorjs.com/docs/getting-started) | **Preferred first release.** Highest direct reuse for this repository. |
| **React Native** | Reuses suitable TypeScript logic and data definitions. Rewrites DOM screens, CSS, navigation, browser storage integration, and platform authentication. React Native renders native components rather than existing HTML. [React Native](https://reactnative.dev/) | Choose if Joakim requires native UI components throughout, or the Capacitor spike fails usability/performance criteria. |
| **Native SwiftUI and Kotlin/Compose** | Separate platform UIs, persistence, and integrations. Reuse vocabulary, Firebase contracts, and test vectors; port scheduler/merge behavior. Android’s native Compose toolkit is Kotlin-based. [Android Compose](https://developer.android.com/compose) | Reserve for a product commitment that justifies two platform implementations. |
| **WebView loading the published URL** | Depends on the website and its update/cache behavior; delivers little additional platform integration. | Reject as the proposed release architecture. Apple expects functionality beyond a repackaged website, and Google rejects limited functionality/content. [Apple §4.2](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality), [Google functionality policy](https://support.google.com/googleplay/android-developer/answer/9898783?hl=en) |

The Capacitor decision should be conditional on an early physical-device spike. Its acceptance gate is native login, offline cold launch, persistent grades after termination, usable editing/import, accessibility, and correct navigation.

## 4. Architecture and data-model changes

### Shared application with platform adapters

Keep the current source application and introduce proposed adapters under `src/platform/` for:

- Authentication: sign-in, linking, reauthentication, restored sessions, and sign-out.
- App lifecycle and connectivity.
- File selection, full-state export/import, and sharing.
- Optional notifications.
- Platform information and release identity.

Keep scheduling, merge rules, card identity, and document conversion shared. The existing boundaries are [src/srs.ts](../../src/srs.ts), [src/merge.ts](../../src/merge.ts), [src/record-sync.ts](../../src/record-sync.ts), and [src/firestore-docs.ts](../../src/firestore-docs.ts).

Add proposed `ios/`, `android/`, and `capacitor.config.ts` projects. Build a separate mobile artifact, for example `dist-mobile`, with the Firebase backend enabled and a mobile-appropriate base path. Capacitor copies the built `webDir` into native projects; its remote `server.url` setting is intended for development, not production. [Capacitor installation](https://capacitorjs.com/docs/getting-started), [configuration](https://capacitorjs.com/docs/config).

The native package should contain its executable web assets and seed. Disable PWA service-worker registration and browser installation instructions inside the native build; retain them for the PWA. Current integration points are [vite.config.ts](../../vite.config.ts#L58) and [src/main.ts](../../src/main.ts#L864).

### Authentication

Replace the native use of browser popups with a maintained native authentication bridge or a small audited Capacitor bridge.

Recommended ownership: native provider flows obtain credentials, while the existing Firebase JavaScript Auth instance owns the application session used by Firestore. Firebase supports exchanging Google ID tokens through `GoogleAuthProvider.credential` and `signInWithCredential`. Google disallows embedded user agents for OAuth authorization. [Firebase Google authentication](https://firebase.google.com/docs/auth/web/google-signin), [Google OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app).

Implement:

- Google sign-in on both platforms.
- Sign in with Apple on iOS, with nonce handling.
- Apple account access on Android and the PWA, so an Apple-only account remains usable across supported clients.
- Explicit provider linking from an already authenticated account. Preserve its Firebase UID; never merge accounts merely because emails match.
- Clear handling of cancellation, provider collisions, account switching, revoked credentials, and sign-out.

Firebase documents stable UID identity for linked providers, Apple nonce validation, and consent considerations when linking anonymized Apple identities. [Firebase account linking](https://firebase.google.com/docs/auth/web/account-linking), [Firebase Apple authentication](https://firebase.google.com/docs/auth/ios/apple).

Generalize Google-specific account labels and controls in [src/cloud-on.ts](../../src/cloud-on.ts#L466).

### Offline persistence and startup

Initially retain IndexedDB, behind a storage boundary, subject to device acceptance. Preserve the atomic data/outbox guarantees in [src/db.ts](../../src/db.ts#L450). If the spike cannot establish reliable persistence across termination and upgrades, implement native SQLite storage before release using the same transaction guarantees.

Add local metadata recording the **last successfully validated account/deck binding**. On offline startup:

- Guest study opens immediately.
- A restored matching account can open its downloaded database without waiting for online provisioning.
- Cloud writes wait for authentication and assignment validation.
- Missing downloaded data produces an actionable state; it must not masquerade as restored progress.

This addresses the startup dependency visible in [src/cloud-on.ts](../../src/cloud-on.ts#L258) and [src/provision.ts](../../src/provision.ts#L22).

Keep the native WebView origin and local database names stable across upgrades. Browser and native storage are separate contexts; retaining a database-name string does not transfer Safari’s data into an app. Account database naming is implemented in [src/user.ts](../../src/user.ts#L73).

### Proposed data changes

| Data | Proposed treatment |
|---|---|
| Cards and card IDs | Keep existing content fields, seed IDs, rank/tier, and tombstones. No mobile-specific duplication. [src/types.ts](../../src/types.ts#L25) |
| SRS progress | Keep current per-user, per-card state and clocks. No scheduler migration. [src/firestore-docs.ts](../../src/firestore-docs.ts#L24) |
| Study settings | Keep direction, session size, tier, `wordTypes`, and settings clock. [src/firestore-docs.ts](../../src/firestore-docs.ts#L15) |
| Account/deck assignment | Keep Firebase UID and existing assignment. Provider linking belongs in Firebase Auth. [src/account-plan.ts](../../src/account-plan.ts#L5) |
| Cached account binding | New local metadata only, separated from synced study preferences. |
| Local reminder preferences | New device-local preferences; disabled by default. |
| Account erasure | New server-owned deletion job/blocking marker, with explicit retention and recovery behavior. |
| Optional server push | New private device registrations and reminder preferences, isolated from existing settings documents. |

Packaging alone should not require a Firestore schema-version bump. New administrative and notification records need their own documented schemas.

## 5. Sync and Firestore rules impact

### Preserve existing sync guarantees

Continue using the serialized pull/merge/push loop, per-record transactions, revision-specific acknowledgements, and UID/session guards. The implementation is in [src/sync.ts](../../src/sync.ts#L49), [src/cloud-sync.ts](../../src/cloud-sync.ts#L65), and [src/db.ts](../../src/db.ts#L810).

Connect native resume/connectivity events to that loop and deduplicate overlapping browser/native triggers. Capacitor provides lifecycle and Android back-button events. [Capacitor App API](https://capacitorjs.com/docs/apis/app).

Retain truthful status:

- **Saved on this device:** durable local work remains pending.
- **Synced:** the relevant pending revisions received Firestore acknowledgement.

Do not acknowledge work merely because a native SDK accepted it into a local queue. Existing acknowledgement semantics are defined in [src/record-sync.ts](../../src/record-sync.ts#L61).

Keep current conflict behavior for the first release. Clock skew and simultaneous reviews remain documented limitations of [src/merge.ts](../../src/merge.ts#L172); native packaging does not resolve them.

### Rules changes

Adding Apple authentication does not inherently require provider-specific rules: ownership currently depends on `request.auth.uid`. Preserve account isolation, deck membership, immutable assignments, and strict document shapes. [firestore.rules](../../firestore.rules#L8).

Account deletion requires additional protection:

1. A server-owned deletion marker blocks the affected UID from recreating account/deck documents or uploading stale pending work.
2. Apply that check to provisioning, progress/settings writes, and deck access.
3. Keep administrative deletion jobs inaccessible to ordinary clients.
4. Keep physical account erasure behind a trusted backend rather than broadly granting client delete permissions.
5. Make clients distinguish account deletion/revocation from temporary sync failure.

The current rules allow account creation but deny account updates/deletes, and deny physical card/progress deletion: [firestore.rules](../../firestore.rules#L105).

Optional notification records should use narrowly validated owner-only access or an authenticated registration endpoint. Never place tokens in readable deck documents or make client registration capable of sending notifications.

Rules deployment remains separate from Pages publication. Preserve both master-only Pages conditions and `dist-firebase` publication in [.github/workflows/pages.yml](../../.github/workflows/pages.yml#L87).

### Account erasure service

Recommend an authenticated, idempotent backend operation that:

- Requires recent reauthentication and explicit confirmation.
- Blocks further synchronization before deleting data.
- Recursively removes private progress/settings, owned personal decks, and optional device registrations.
- Removes shared-deck membership without deleting another member’s data.
- Revokes relevant Apple tokens and Firebase sessions, deletes the Auth account, and reports completion.
- Clears the initiating client’s account database/outbox. Other clients clear cached account data when they subsequently detect deletion.

Deleting a Firestore parent document does not delete its subcollections. [Firebase deletion documentation](https://firebase.google.com/docs/firestore/manage-data/delete-data).

**Shared-deck erasure needs an owner decision:** current card documents contain no author UID, so historical personal contributions cannot safely be attributed by the existing schema. Resolve provenance and erasure policy before supporting affected shared accounts; membership removal alone must not be presented as complete erasure. [src/firestore-docs.ts](../../src/firestore-docs.ts#L33).

If implemented using Cloud Functions for Firebase, deployment requires Blaze billing. The repository only records an older Spark/billing check, not current billing status. [Firebase Functions requirements](https://firebase.google.com/docs/functions/get-started), [docs/firebase-setup.md](../../docs/firebase-setup.md#L22).

## 6. Migration path for existing users and data

| Existing user/data | Migration |
|---|---|
| Firebase account with acknowledged changes | Sign into the same Firebase project/provider in the native app; pull the existing assignment, vocabulary, progress, settings, and tombstones. |
| Firebase account with pending PWA work | Sync the PWA first; verify native and independent client readback before retiring the old installation. |
| Device-only PWA user willing to use sync | Use the existing confirmed guest-copy flow in the original browser context, then sign into that account in the native app. |
| Device-only user who wants to remain offline | Add a user-controlled full-state export/import path to the PWA and native app before launch. |
| New native user | Offer offline guest study immediately; create a personal seeded deck when they choose online account sync. |
| Archived legacy progress | Leave archived and private. Do not reopen the waived production import/recovery scope. |

Guest-copy confirmation already exists in [src/cloud-on.ts](../../src/cloud-on.ts#L210). Preserve its account isolation and shared-vocabulary warning.

A full-state transfer format should preserve IDs, vocabulary, SRS state, settings clocks, and tombstones. Validate it, preview aggregate counts, require a destination choice, and make repeat imports safe. Exclude authentication tokens, UID mappings, and device registrations.

CSV is unsuitable for progress migration: [src/csv.ts](../../src/csv.ts#L181) creates new UUIDs and fresh scheduling state.

Before mobile launch:

- Extend backup/restore coverage for new administrative schemas.
- Define how erasure records prevent an older backup from resurrecting deleted accounts.
- Exclude live push tokens from restoration.
- Complete the outstanding off-machine backup copy.

The exporter currently enumerates only account/settings/progress and deck/cards: [scripts/migration-files.mjs](../../scripts/migration-files.mjs#L49).

Keep credentials, mappings, exports, and detailed comparisons under `GERMAN_FLASHCARDS_PRIVATE_DIR`; public evidence contains aggregates and revision/checksum information. Live rehearsals use `flashcards-ls9-auth-test`; restore drills use isolated emulators. [AGENTS.md](../../AGENTS.md#L13), [docs/firebase-setup.md](../../docs/firebase-setup.md#L201).

## 7. Store requirements

Requirements below were checked against official sources for this plan; recheck them before submission.

### Developer accounts and fees

| Store | Requirement |
|---|---|
| Apple | Apple Developer Program membership: **US$99 per year**, with regional pricing. Individual enrollment displays the owner’s legal name as seller; organizations require a qualifying legal entity and D-U-N-S verification. [Apple enrollment](https://developer.apple.com/programs/enroll/) |
| Google Play | Play Console registration: **US$25 one time**, plus developer identity verification and applicable personal-account device/testing requirements. [Google registration](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en) |

Joakim must choose account ownership and public seller identity before fixing bundle/package IDs.

### Review and authentication

The release should demonstrate substantial offline learning utility, editing, native file handling, and account sync. A wrapper has no guaranteed approval. Submit complete metadata, real screenshots, support details, age-rating answers, and reviewer access to account features. [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [Google functionality policy](https://support.google.com/googleplay/android-developer/answer/9898783?hl=en).

**Treat Sign in with Apple as required for this iOS scope alongside Google.** Apple §4.8 currently requires an equivalent privacy-preserving login option, with specified exemptions; it does not name Apple as the only possible implementation. A generic consumer flashcard app appears outside those exemptions, and device-only study is not equivalent account authentication. [Apple §4.8](https://developer.apple.com/app-store/review/guidelines/#login-services), [current account UI](../../src/cloud-on.ts#L466).

### Privacy policy and disclosures

Publish an accessible privacy policy linked from the app and listings. Document account identity, uploaded cards, schedules/settings, Firebase processing, retention/backups, deletion, support contact, and any optional notification data.

Prepare Apple privacy labels and Google Data safety answers from the **shipped dependency and network inventory**. Candidate disclosures include name/email, account identifiers, user-created card content, and review-state data. Exact classifications must be validated during implementation; offline-only storage does not justify claiming that the whole synced app collects no data. [Apple privacy details](https://developer.apple.com/app-store/app-privacy-details/), [Google Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en), [cloud document paths](../../src/cloud-push.ts#L35).

Audit native SDK manifests, signatures where required, and required-reason API usage. Apple explicitly lists Capacitor, GoogleSignIn, and several Firebase SDKs among affected dependencies. [Apple SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/).

### Account and data deletion

Provide a prominent in-app deletion flow covering the account and associated data. Sign-out or temporary deactivation is insufficient. Apple also specifies token revocation for Sign in with Apple accounts. [Apple deletion requirements](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion).

Google additionally requires a functional web resource for requesting account/data deletion without reinstalling the app. Explain completion timing and any retained data. [Google deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).

### Build requirements

Current published requirements include **Xcode 26 or later with the iOS 26 SDK** for Apple uploads and **Android API 36 or higher** for new Google Play submissions. These are separate from the minimum OS versions Joakim chooses to support. [Apple upcoming requirements](https://developer.apple.com/news/upcoming-requirements/), [Google target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en).

## 8. Optional review reminders

**Recommendation: start with optional local reminders; defer server push.**

Local notifications can schedule device reminders without a sending server. Request permission only after an explicit opt-in, offer a local-time schedule and disable control, and use generic wording. Avoid an exact-alarm dependency for ordinary study reminders. Reconcile schedules after relevant app activity, timezone changes, sign-out, and deletion. [Capacitor local notifications](https://capacitorjs.com/docs/apis/local-notifications).

The existing due-card selector can inform reminders while the app is running, but its filters and locally cached data must be respected: [src/db.ts](../../src/db.ts#L592).

If Joakim later chooses server push:

- Add private per-device token registrations, consent, timezone, quiet hours, expiry, and token rotation.
- Use an authenticated server sender with rate limits and deduplication.
- Avoid vocabulary/progress details in notification payloads.
- Cancel registrations on sign-out/deletion and prune invalid tokens.
- Do not claim exact due counts when the server lacks unsynced offline reviews.

For a common FCM sender, explicitly integrate Firebase Messaging on iOS: Capacitor’s push plugin returns an **APNs token on iOS** and an **FCM token on Android**. Configure APNs credentials and obtain the appropriate FCM registration token rather than treating the two as interchangeable. [Capacitor push API](https://capacitorjs.com/docs/apis/push-notifications), [Firebase Apple messaging setup](https://firebase.google.com/docs/cloud-messaging/ios/get-started).

## 9. CI/CD signing and beta testing

### CI/CD

Extend the existing checks in [.github/workflows/pages.yml](../../.github/workflows/pages.yml#L16) with separate mobile workflows:

| Stage | Proposed behavior |
|---|---|
| PR verification | Existing unit/account/emulator checks, mobile build checks, native compile/smoke checks. No signing/upload credentials exposed to PRs. |
| iOS candidate | Pinned macOS/Xcode runner; distribution signing and provisioning; archive and upload to App Store Connect/TestFlight. |
| Android candidate | Pinned Java/Android tooling; signed AAB; Play App Signing with a separate upload key. |
| Release evidence | Record source commit, shared app version, native build number/version code, Firebase project, and artifact checksums. |
| Production promotion | Promote the tested candidate through owner-controlled release steps; keep backend/rules deployment separate from site publication. |

An App Store Connect API key authenticates API operations; manage iOS code-signing material separately. Use least-privilege credentials, ephemeral CI keychains/files, rotation, and durable recovery copies outside Git. [App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api).

For Android, distinguish upload and app-signing keys. Register the certificate fingerprints required by authentication integrations, including the certificate used for Play-distributed installs. [Android signing](https://developer.android.com/studio/publish/app-signing).

Retain the existing offline version/source identity mechanism from [vite.config.ts](../../vite.config.ts#L39), adding native build metadata. Extend ignore rules for mobile outputs and credentials from [.gitignore](../../.gitignore#L14).

### Beta testing

- **TestFlight:** begin with internal testers, then external testers. Apple supports up to 100 internal team testers and 10,000 external testers; the first external build requires TestFlight review. [TestFlight](https://developer.apple.com/testflight/).
- **Play internal testing:** distribute through the actual Play signing path to up to 100 testers. [Play testing tracks](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en).
- **New personal Play accounts:** accounts created after 13 November 2023 require a qualifying closed test with at least 12 continuously opted-in testers for 14 days before applying for production access. Internal testing does not satisfy that gate. [Google personal-account testing](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).

Use explicit auth-test configurations for rehearsals. The existing `VITE_REHEARSAL_PREVIEW` admits verified legacy assignments only, so introduce a distinct mobile test configuration for fresh-user tests while preserving that guard. [src/provision.ts](../../src/provision.ts#L49), [src/rehearsal.ts](../../src/rehearsal.ts).

## 10. Milestones and issue-sized steps

Each row is a proposed future issue, not an issue created by this plan.

| Step | Deliverable | Acceptance criteria |
|---|---|---|
| **M0.1 — Approve mobile scope** | Record wrapper choice, supported devices, account ownership, reminder scope, and backend budget in the active plan. | Joakim’s decisions recorded; mandatory release gates identified. |
| **M0.2 — Establish store identities** | Developer enrollment, bundle/package IDs, support/privacy destinations. | Ownership verified; identifiers and public seller identity recorded; credentials private. |
| **M0.3 — Capacitor feasibility spike** | Bundled app on real iPhone and Android hardware. | Google/Apple flow feasibility, offline cold launch, grade persistence after termination, navigation, and file handling demonstrated; written go/no-go decision. |
| **M0.5 — Complete off-machine backups** | Durable private copy with observable success and retention. | Successful copy and retrieval verified; aggregate checksum evidence recorded outside detailed private reports. |
| **M1.1 — Add mobile build/platform boundary** | Native projects, adapters, bundled mobile artifact, platform-aware Settings. | Both platforms compile; native bundle is offline-capable and correctly identifies project/version; PWA installation checks remain valid. |
| **M1.2 — Implement offline account startup** | Cached validated binding and durable native storage behavior. | Previously downloaded accounts open offline without provisioning; grades survive reopen/upgrade; fresh guest works without network; account isolation passes. |
| **M1.3 — Implement native Google auth** | Provider bridge and session handling on both platforms. | Sign-in, cancellation, restoration, sign-out, and switching pass on installed devices and Play-signed builds; UID matches the PWA. |
| **M1.4 — Implement Apple auth** | iOS Apple login and Android/PWA access for Apple accounts. | First/returning login, hidden email, nonce handling, and cross-platform account identity pass. |
| **M1.5 — Add explicit provider linking** | Link another provider to the current account. | UID/deck/progress remain stable; consent is clear; collisions preserve both existing datasets without silent merging. |
| **M1.6 — Integrate native lifecycle sync** | Resume/network/back-button integration. | Offline grade → terminate → reopen → reconnect → independent client succeeds; pending status remains truthful; repeated events do not corrupt acknowledgements. |
| **M1.7 — Polish mobile interactions** | Safe areas, keyboard, accessibility, navigation, native files/share. | VoiceOver/TalkBack, large text, editing, CSV selection, session exit, and Android back behavior pass on chosen device range. |
| **M1.8 — Add portable full-state transfer** | PWA/native export and validated import. | Guest progress, custom cards, IDs, settings, and tombstones survive transfer; repeat import is safe; credentials excluded. |
| **M2.1 — Implement deletion backend/rules** | Idempotent erasure, sync blocking, recursive cleanup, provider revocation. | Interrupted jobs resume; stale clients cannot recreate data; unrelated accounts remain intact; shared-content policy resolved for supported accounts. |
| **M2.2 — Implement deletion interfaces** | In-app flow, web request resource, completion/error states. | Recent-auth/confirmation works; offline requests are not falsely reported complete; local account cache clears; web requests work without installed apps. |
| **M2.3 — Extend recovery for new schemas** | Administrative records, erasure-aware recovery, notification exclusions. | Isolated restore covers supported schema versions; deleted accounts cannot be resurrected; live device tokens are not restored. |
| **M2.4 — Prepare privacy disclosures** | Policy, SDK inventory, Apple labels, Google Data safety. | Answers match shipped network/data behavior; URLs work; native SDK privacy requirements pass archive inspection. |
| **M3.1 — Add iOS signing/release CI** | Signed archive and TestFlight upload. | Clean-source candidate builds on pinned tools; secrets remain absent from logs/artifacts; installed build identity matches recorded evidence. |
| **M3.2 — Add Android signing/release CI** | Signed AAB and Play internal upload. | Play App Signing configured; store-installed Google login works; increasing version codes preserve local data. |
| **M3.3 — Record beta acceptance** | TestFlight and Play device matrix, plus qualifying closed test if applicable. | Migration, offline persistence, sync isolation, auth/linking, deletion, accessibility, and upgrades pass on the exact candidates. |
| **M3.4 — Submit and release** | Listings, screenshots, review access, owner-controlled launch. | Required store declarations complete; both stores approve; production smoke/readback evidence recorded; compatible recovery release available. |
| **Optional — Local reminders** | Opt-in device schedules. | Permission denial, disable, timezone changes, taps, sign-out, and deletion pass without affecting study. |
| **Optional — Server push** | Private registrations, sender, APNs/FCM integration. | Token rotation, deduplication, quiet hours, revoked consent, and deletion pass; privacy disclosures updated. |

These steps extend the repository’s current checks rather than substituting browser/emulator results for native evidence. Existing test boundaries are described in [package.json](../../package.json#L20) and [TEST.md](../../TEST.md#L169).

## 11. Risks

| Risk | Response |
|---|---|
| Store rejection for insufficient app utility | Gate the wrapper on usable offline learning and platform integration; describe concrete functionality during review. |
| Offline account startup remains network-dependent | Fix account binding before beta; test cold launches, not just resume. [src/cloud-on.ts](../../src/cloud-on.ts#L258) |
| Apple login creates a second account | Explicit linking, grouped Apple configuration, collision handling, and cross-client UID acceptance. [account identity](../../src/user.ts#L78) |
| Data disappears after origin/storage changes | Stable origins, upgrade tests, full-state export, and an early persistence decision. [local database implementation](../../src/db.ts#L112) |
| Deleted data returns from stale clients or backups | Rules-level blocking and erasure-aware recovery; handle retained offline copies when clients reconnect. [provisioning](../../src/provision.ts#L22), [backup exporter](../../scripts/migration-files.mjs#L49) |
| Recovery confidence exceeds actual coverage | Keep `wordTypes` regression coverage, verify new schemas, and complete off-machine copies. [restore validator](../../scripts/restore-core.mjs#L83), [AGENTS.md](../../AGENTS.md#L6) |
| More installs increase Firestore cost/latency | Measure full-deck/progress reads and per-record transactions before optimizing. [src/cloud-push.ts](../../src/cloud-push.ts#L35) |
| Conflicting simultaneous reviews | Document current clock-based behavior; keep scheduler redesign outside packaging scope. [src/merge.ts](../../src/merge.ts#L202) |
| Content rights are insufficiently documented | Confirm distribution rights and attribution for vocabulary/examples/ranking sources. The code’s MIT license and frequency-source reference are evidence, not a provenance audit. [LICENSE](../../LICENSE), [README.md](../../README.md#L43) |
| Signing or testing gates delay launch | Establish ownership, key recovery, macOS build access, and required testers early. |

## 12. Open decisions for Joakim

1. **Meaning of “proper apps”:** accept a polished Capacitor UI, or require native UI components throughout? Recommended: Capacitor, conditional on the spike.
2. **Developer identity:** individual or organization accounts, public seller name, and final bundle/package IDs?
3. **Device support:** minimum iOS/Android versions, iPad/tablet commitment, and available test hardware/macOS build access?
4. **Backend budget:** approve a hosted deletion service and any required billing changes? Server push adds a separate operational commitment.
5. **Guest migration:** make full-state offline export/import a first-release gate? Recommended: yes.
6. **Shared-account erasure:** do production shared-deck accounts need support, and what provenance policy governs their historical contributions?
7. **Privacy operations:** deletion completion target, backup retention, off-machine destination, and erasure-record retention?
8. **Reminders:** none initially, local reminders, or server push? Recommended: optional local reminders first.
9. **Commercial scope and launch timing:** confirm a free initial release and choose target dates after enrollment, feasibility, and applicable closed-testing gates are known.

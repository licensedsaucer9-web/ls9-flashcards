> Archived proposal from 2026-10-10, retained as design evidence rather than an active work plan. Implementation baselines and line references below are historical; current operation is in [README](../../README.md) and [the rollout plan](../firebase-rollout-plan.md).

> Written by Codex (gpt-6.1-sol) on 2026-10-10. These are proposals, not decisions.
>
> Note: the wordTypes restore gap described here is fixed by PR #55.

**Recommended direction.** Add private decks with a deck picker, deck-specific settings and independent progress. Support both German vocabulary and basic question/answer decks. Ship content-only file sharing first; make live shared decks a separate, optional milestone. Keep the existing German deck’s cloud records in place through a compatibility adapter.

This is a planning-only proposal, independent of mobile work. No files or repository objects were changed. Proposed schemas below describe future work.

**Starting point and evidence.** The dated release statement and package identify v1.2.0. Older passages in the architecture, acceptance guide, and data-repository README describe earlier rollout states; use the current release statement and operating instructions for release status. [README.md](../../README.md), [package.json](../../package.json), [AGENTS.md](../../AGENTS.md).

| Area | Inspected implementation |
|---|---|
| Account/deck relationship | Provisioning preserves one assigned `deckId`; a new account receives `decks/{uid}`. [src/provision.ts](../../src/provision.ts#L22) |
| Content and progress | Cloud content is already separate from private progress, but progress paths omit deck identity. [src/cloud-push.ts](../../src/cloud-push.ts#L35) |
| Local persistence | IndexedDB version 1 has `cards` keyed by card ID and one `settings` row containing preferences, tombstones and pending markers. [src/db.ts](../../src/db.ts#L91) |
| Card format | Fields, directions and articles are German/English-specific. [src/types.ts](../../src/types.ts#L1) |
| Scheduling | Latest SM-2-style state per card; no review history. A running session captures its queue and direction. [src/srs.ts](../../src/srs.ts#L7), [src/main.ts](../../src/main.ts#L366) |
| Sync | Every pass pulls the assigned deck and all personal progress, then inserts missing German seeds and pushes dirty records. [src/cloud-sync.ts](../../src/cloud-sync.ts#L65) |
| Inspected vocabulary snapshot | `data.json` contains 514 unique cards, tiers of 100/150/264, frequency ranks on every card, no embedded SRS and no tombstones. Tags include 373 nouns, 91 verbs and 50 adjectives. This is the frozen vocabulary snapshot, not an inventory of current production progress. [data.json](https://github.com/licensedsaucer9-web/ls9-flashcards-data/blob/main/data.json), [data README](https://github.com/licensedsaucer9-web/ls9-flashcards-data/blob/main/README.md) |

**Goals and non-goals.** The rollout plan already identifies multiple subjects, ownership, seed handling and per-deck state as later product work. This proposal makes that direction concrete. [docs/firebase-rollout-plan.md](../../docs/firebase-rollout-plan.md#L278).

Goals:

- Create, name, select, archive and study several decks, including offline.
- Import into a clearly identified deck or create a new deck from an import.
- Give each user independent settings and progress for each deck.
- Preserve existing cards, schedules, preferences, deletions and pending work.
- Make German vocabulary features optional capabilities of a deck.
- Keep sync work proportional to changed records and relevant decks.
- Allow sharing content without exposing personal schedules.

Non-goals for the first release: native/mobile implementation work, mixed-deck review sessions, a public marketplace, collaborative editing, images/audio, rich HTML cards, cloze generation, FSRS, review history, daily study budgets or automatic rescheduling. The current app’s session size limits the initial session queue; it is not a daily review limit. [src/session.ts](../../src/session.ts#L1), [src/main.ts](../../src/main.ts#L373).

**Options and recommendation.**

| Option | Benefit | Cost or limitation | Recommendation |
|---|---|---|---|
| Treat tags as decks | Small initial UI change | Retains one settings document, one progress namespace and German-only content; cannot provide independent decks safely | Reject |
| Private deck library with generic text cards and file sharing | Covers additional languages and subjects while keeping ownership simple | Requires storage, sync and rules changes plus compatibility adapters | **Choose** |
| Shared catalog with subscriptions, roles and collaborative editing immediately | Supports centrally maintained decks | Adds invitations, membership lifecycle, revocation, content-update policy and operational infrastructure | Defer |

The second option builds on the existing content/progress separation. A fully unified cloud migration would be cleaner eventually, but moving all existing progress immediately introduces coexistence problems with older clients that still write the original paths. Keep that migration outside the first release. [src/firestore-docs.ts](../../src/firestore-docs.ts#L15), [src/cloud-push.ts](../../src/cloud-push.ts#L76).

**Architecture and deck model.** Introduce a deck context passed explicitly through storage, rendering and sync: account identity, deck identity and operation generation. Routes should identify the deck for review, editing and import. Today routes identify only the screen/card, and study locks contain account/database identity without a deck. [src/main.ts](../../src/main.ts#L71), [src/study-lock.ts](../../src/study-lock.ts#L1).

Use one account database containing multiple decks rather than one database per deck. Preserve the existing account/guest database names and storage prefixes. [src/user.ts](../../src/user.ts#L73), [AGENTS.md](../../AGENTS.md).

| Proposed record/path | Purpose |
|---|---|
| `decks/{deckId}` | Small metadata document: schema version, immutable owner, title, description, card template, face labels/locales, filter capabilities, source provenance and archive state |
| `decks/{deckId}/cards/{cardId}` | One content document per card, with content clock and deletion tombstone |
| `users/{uid}/decks/{deckId}` | Private library entry: reference, personal display name and archive preference; never an authorization grant |
| `users/{uid}/decks/{deckId}/settings/current` | Private direction, session size and filters |
| `users/{uid}/decks/{deckId}/progress/{cardId}` | Private latest SRS state |
| Optional `decks/{deckId}/members/{uid}` | Authoritative membership/role for later live sharing |

Additional decks receive stable random IDs independent of their titles. Logical card identity becomes `(deckId, cardId)`; personal progress identity becomes `(uid, deckId, cardId)`. Reusing a card ID in another deck must be harmless. This addresses the current card-ID-only local keys, progress maps and pending markers. [src/db.ts](../../src/db.ts#L133), [src/types.ts](../../src/types.ts#L77).

For the original deck, retain:

- Existing `users/{uid}.deckId` as its immutable compatibility assignment.
- Existing card wire format and `users/{uid}/progress/*` and `settings/current` paths.
- Existing membership behavior, including preassigned shared legacy decks.

Present those records through the same internal interfaces as new decks. Derive the original state location from the account assignment, never from a client-editable library field. Existing rules prohibit reassignment, and provisioning deliberately preserves assignments. [firestore.rules](../../firestore.rules#L105), [src/provision.ts](../../src/provision.ts#L39).

New local stores should separate deck metadata, content, progress, settings and outbox records. Use compound keys and a per-deck index. Commit each mutation and its pending revision atomically, preserving the current durability guarantee without expanding the single settings row indefinitely. [docs/architecture.md](../../docs/architecture.md#L88), [src/db.ts](../../src/db.ts#L450).

**Card templates, creation and import.** Define two initial templates:

- **Basic:** plain-text front/back, optional examples and tags.
- **German vocabulary:** the same internal faces plus article, word types, optional frequency rank and tier.

Adapt existing `de/en` and example fields into the internal model. Use deck face labels and locales for rendering/search/sorting; German article handling and the Gender grade belong to the vocabulary template. Those concerns are currently embedded in the editor, review renderer and German collation. [src/word-types.ts](../../src/word-types.ts#L251), [src/main.ts](../../src/main.ts#L447), [src/db.ts](../../src/db.ts#L592).

Creation should offer an empty deck, a built-in German copy or an imported deck. Keep the current built-in German onboarding default initially. Built-in content comes from the application’s seed assets; the archived data repository remains a reference/recovery source. [src/seed.ts](../../src/seed.ts#L535), [README.md](../../README.md).

Replace unconditional German reseeding with an explicit seed-pack policy. New decks initialize their selected pack once; later pack updates require a deliberate merge policy. Preserve original-deck reseeding and tombstones through its adapter. Seed identity must use provenance rather than applying the current `seed-` prefix rule to every deck. [src/cloud-sync.ts](../../src/cloud-sync.ts#L82), [src/db.ts](../../src/db.ts#L493), [src/merge.ts](../../src/merge.ts#L181).

Extend import with:

- Generic `front,back` CSV and continued support for existing German CSV columns.
- Explicit target deck/template, validation preview, duplicate counts and confirmation before committing.
- Duplicate detection within the destination deck. The same content may exist in several decks.
- Durable import identity/card IDs so interrupted sync resumes without recreating cards.
- A versioned JSON deck package preserving content, metadata and provenance. Default exports omit progress, account identifiers and membership.

Current CSV import appends immediately, deduplicates by normalized `de+en`, generates UUIDs and initializes cards as due. It supports only part of the editor’s content fields. [src/csv.ts](../../src/csv.ts#L127), [src/main.ts](../../src/main.ts#L803).

**Per-deck settings, scheduling, filters and tiers.**

| Concern | Proposed behavior |
|---|---|
| Direction | Store front→back/back→front per user/deck; map existing DE→EN/EN→DE values losslessly |
| Session size | Per user/deck; retain `0 = all matching due cards` |
| Scheduling | Independent SRS state per user/deck/card; keep the existing algorithm initially |
| Active selection | Remember locally per account so switching decks on one device does not interrupt another device |
| Word types | Enable the existing noun/verb/adjective facet for vocabulary decks; hide it for basic decks |
| Other subjects | Use optional tag filters with deck-appropriate labels rather than assigning noun/verb/adjective meanings |
| Tiers | Optional deck-defined cumulative levels; preserve the original three German tiers and their membership |

Preserve word-type semantics: empty selection means All, including untyped cards; multiple selected types match with OR; multi-type cards enter the queue once. Combine separate facets with AND. Filters change eligibility, never SRS or due dates. [src/word-types.ts](../../src/word-types.ts#L42), [src/word-types.ts](../../src/word-types.ts#L84), [src/db.ts](../../src/db.ts#L587).

Do not generalize German tier sizes into a universal frequency policy. The current implementation has three cumulative levels, defaults unclassified cards to tier 3 and includes fixed German-specific explanatory text. New decks should default to all cards, with tiers disabled unless configured; tiered decks use their own labels and actual counts. Preserve existing users’ selected tier. [src/tiers.ts](../../src/tiers.ts#L4), [src/types.ts](../../src/types.ts#L8).

Keep one schedule per card across directions, matching the existing model. Separate forward/reverse schedules would be another migration. Deck or filter changes must not alter a running session’s captured scope. [src/types.ts](../../src/types.ts#L25), [src/main.ts](../../src/main.ts#L369).

An optional interval multiplier can follow later as a per-deck preference. If chosen, specify first-review behavior explicitly, apply it only to future successful-review intervals and preserve existing due dates. The retained proposal suggests default 1, range 0.5–7 and unchanged Again/Gender behavior; it is not implemented. [docs/firebase-rollout-plan.md](../../docs/firebase-rollout-plan.md#L292).

**Sync changes.** Preserve serialized foreground sync, record-level transactions, separate content/progress/settings clocks and acknowledgement of only the revision actually sent. Extend every queue item and acknowledgement with deck identity. Separate account-session validity from the selected UI deck: switching decks should invalidate stale screens without losing valid pending uploads for another deck. [src/sync.ts](../../src/sync.ts#L49), [src/record-sync.ts](../../src/record-sync.ts#L61).

Change synchronization in four ways:

1. Push dirty records across all decks fairly; one rejected deck must not block other decks.
2. Separate local-change pushes from reconciliation so each grade does not force a complete content pull.
3. Reconcile the active deck on foreground/manual sync; download inactive decks deliberately. Undownloaded decks show unknown counts rather than zero due.
4. For new schemas, paginate initial downloads and use server-assigned change timestamps for subsequent pulls, including tombstones. Persist page application and cursors atomically; replay timestamp boundaries safely.

Replication timestamps must be separate from the wall clocks used to resolve content and progress conflicts. The original adapter can retain full reconciliation until older writers support change markers. Current merge behavior uses wall clocks and does not merge review events, so simultaneous reviews remain a limitation. [src/cloud-push.ts](../../src/cloud-push.ts#L35), [src/merge.ts](../../src/merge.ts#L197), [docs/architecture.md](../../docs/architecture.md#L113).

“Synced” should mean all this account’s pending deck records are acknowledged. Show per-deck failures and make sign-out inspect the whole account outbox; currently it examines one settings row. [src/cloud-on.ts](../../src/cloud-on.ts#L515).

**Firestore rules and optional sharing.** Current rules allow only UID-named personal deck creation, immutable membership, member editing of shared vocabulary and owner-only progress/settings. They cannot authorize arbitrary additional private decks. [firestore.rules](../../firestore.rules#L105).

Add explicit rules for:

- Random-ID private deck creation with `ownerUid == request.auth.uid`; ownership remains immutable.
- Library entries that reference an owned/authorized deck; creating an entry cannot grant access.
- Deck-scoped private state readable only by its user.
- Template-specific content, settings and timestamp validation with bounded text/tags.
- Original paths retaining their current compatibility policy.
- Archive/tombstone operations; defer permanent deck purging.

Do not write empty progress documents for every new card in new decks. Missing progress means unstudied; create a record on the first review. Current seed insertion marks both content and progress pending, so sparse progress requires deliberate adapter/default behavior. [src/db.ts](../../src/db.ts#L535).

For initial sharing, export/import content-only packages into independent private copies. For optional live sharing, introduce owner/editor/viewer roles: editors change content, viewers study, and every user keeps private progress/settings. Membership must be authoritative on the deck; private library entries are projections only. Invitation acceptance must never permit self-granted access. The current Firebase configuration contains rules/emulator configuration and no deployed invitation service. [firestore.rules](../../firestore.rules#L124), [firebase.json](../../firebase.json).

Live-sharing acceptance must also define leaving, revocation and rejected offline edits. Revocation can stop future server access; it cannot retract content already downloaded. Preserve rejected local work for an explicit private-copy/export action.

**Firebase storage, write rates and quotas.** These platform limits were checked against official documentation; the repository does not establish the project’s current usage or available quota.

| Constraint | Design impact |
|---|---|
| Maximum document size: **1 MiB**; API request: **10 MiB** | Keep cards, progress and memberships as separate documents; bound import requests. [Firestore limits](https://firebase.google.com/docs/firestore/quotas) |
| Rules document lookups: **10** per single-document/query request; **20** per transaction/batch, with per-operation limits too | Budget authorization lookups and test realistic batches. [Firestore limits](https://firebase.google.com/docs/firestore/quotas) |
| Free allowance: **1 GiB storage, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, 10 GiB outbound/month**, for one database/project | Budget total project activity, including imports and backups; daily allowances reset around midnight Pacific time. [Firestore quotas](https://firebase.google.com/docs/firestore/quotas) |
| Indexed sequential fields can limit a collection to **500 writes/second**; single-document throughput depends on workload | Avoid shared per-review counters, use scattered IDs, throttle imports and exempt unused indexes. [Firestore best practices](https://firebase.google.com/docs/firestore/best-practices) |
| Storage includes indexes/metadata; rules can add billed reads | JSON file size and application read counts are incomplete cost estimates. [Firestore billing](https://firebase.google.com/docs/firestore/pricing) |

The inspected vocabulary JSON is approximately 120 KB, but it is not a Firestore storage measurement. Current rules already bound faces to 200 characters, examples to 1,000 and tags to 12 entries; retain explicit bounds and add tag-string validation for new templates. [data.json](https://github.com/licensedsaucer9-web/ls9-flashcards-data/blob/main/data.json), [firestore.rules](../../firestore.rules#L83).

A significant current cost is full pulls. With 514 content and 514 progress documents, one online pass requests approximately **1,030 documents** before dirty-record transaction and rules reads. About 48 such passes consume nearly the daily free read allowance across the project. This is a calculated scenario, not measured production usage. [src/cloud-push.ts](../../src/cloud-push.ts#L28).

For new decks, an N-card import should require roughly N content writes plus small metadata overhead, rather than N additional unstudied progress writes. Measure cold-download and steady-state reads, writes, bytes and retries. Do not interpret the existing `WRITE_CHUNK = 499` as a throughput guarantee: its queue still performs individual transactions. [src/record-sync.ts](../../src/record-sync.ts#L135).

Set a launch capacity envelope after measurement. Suggested test targets are 20 decks/account and 2,000 cards/deck, with larger imports tested separately. UI caps are guardrails; hard aggregate limits require trusted enforcement.

**Migration and rollout path.**

1. **Prepare recovery first.** Extend backup/restore before writing new schemas. The exporter enumerates only original settings/progress and deck cards; restore explicitly rejects membership in more than one deck. It also currently rejects settings containing `wordTypes`, despite v1.2.0 allowing that field. [scripts/migration-files.mjs](../../scripts/migration-files.mjs#L49), [scripts/restore-core.mjs](../../scripts/restore-core.mjs#L82), [scripts/restore-core.mjs](../../scripts/restore-core.mjs#L111).
2. **Expose the original deck through compatibility interfaces.** Resolve and cache its actual assignment; preserve IDs, clocks, schedules, tombstones and preferences. Additional decks do not require copying existing cloud progress.
3. **Upgrade IndexedDB transactionally.** Retain old stores for recovery, migrate pending revisions as well as visible data, and record completion atomically. If an offline device lacks the cloud assignment, retain an unresolved original-deck namespace and refuse cloud writes until resolved—never assume a shared deck is UID-named. Current provisioning returns the assignment, but account adoption does not retain it locally. [src/provision.ts](../../src/provision.ts#L44), [src/cloud-on.ts](../../src/cloud-on.ts#L268).
4. **Handle guests explicitly.** Migrate device decks locally. Copy into an account only after target selection and confirmation; make repeat copies idempotent. Existing copy choices are account/device-based and need deck identity added. [src/cloud-on.ts](../../src/cloud-on.ts#L210), [src/copy-choice.ts](../../src/copy-choice.ts).
5. **Rehearse coexistence.** Older clients continue using the original wire format. Same-browser database upgrades should make obsolete tabs stop safely rather than write stale stores. Rollback uses a compatible client that preserves new records. [src/db.ts](../../src/db.ts#L42).
6. **Release through existing boundaries.** Live rehearsals use `flashcards-ls9-auth-test`; restore drills use the isolated emulator. Keep private evidence outside Git. Publish `dist-firebase` through the paired master-only gates and deploy rules separately. This does not reopen the waived studied-data import or legacy-device recovery. [AGENTS.md](../../AGENTS.md), [.github/workflows/pages.yml](../../.github/workflows/pages.yml#L87).

An off-machine dump copy remains outstanding and should be a prerequisite for production schema expansion. Keep this proposal within the existing active rollout plan if adopted. [docs/firebase-rollout-plan.md](../../docs/firebase-rollout-plan.md#L265).

**Milestones as proposed issue-sized steps.** These are planning labels, not created issues.

| Step | Deliverable | Acceptance criteria |
|---|---|---|
| **Foundation 1** | Deck/card contracts and compatibility adapters | Original documents round-trip losslessly; basic cards need no German fields; identical card IDs in different decks remain independent |
| **Foundation 2** | Deck-scoped IndexedDB stores/outbox | Content, progress and pending revisions commit atomically; deck reads are scoped; stale account/UI operations cannot mutate another context |
| **Foundation 3** | Resumable local migration | Restart, blocked upgrade and unresolved assignment preserve data; original settings, tombstones and pending work survive |
| **Foundation 4** | Rules for private additional decks | Owner/outsider/unauthenticated matrix passes; library forgery grants no access; original rules behavior remains covered |
| **Product 5** | Library provisioning and explicit seed packs | Concurrent creation is idempotent; empty/basic decks gain no German seeds; original deletions survive reseeding |
| **Product 6** | Picker and deck-scoped routes | Selection persists locally; editing/import displays its target; cached decks reopen offline; switching decks safely closes a session |
| **Product 7** | Per-deck settings and filters | Changing A cannot affect B; generic labels replace German wording; original word-type/tier behavior and due dates remain unchanged |
| **Product 8** | Import preview and content export | German/basic CSV and JSON round-trip; duplicates are deck-local; interrupted uploads resume; exports contain no personal state |
| **Sync 9** | Deck-aware pushes and acknowledgements | Switching accounts/decks mid-operation cannot acknowledge another queue; newer edits stay pending; one rejected deck does not block others |
| **Sync 10** | Paginated bootstrap and incremental reconciliation | Cursor interruption/equal timestamps/deletions are covered; inactive decks are not fully pulled after every grade; cold/steady-state costs are recorded |
| **Recovery 11** | Versioned complete backup export | Includes library, metadata, all deck settings/progress, cards, memberships and tombstones; aggregate counts/checksum verify completeness |
| **Recovery 12** | Restore compatibility and durable copies | Accepts existing/new dumps including `wordTypes`; emulator restore/readback and zero-write repeat pass; off-machine copy is verified |
| **Release 13** | Mixed-client and two-client acceptance | Offline grade, restart, reconnect, deletion, import and settings isolation pass across two decks/clients; original older writer remains compatible |

Build verification should extend the existing unit, browser and emulator suites, followed by the release artifact checks. Those checks are proposed here, not executed during planning. [package.json](../../package.json), [scripts/firestore-rules-test.mjs](../../scripts/firestore-rules-test.mjs), [scripts/cloud-sync-emulator-test.mjs](../../scripts/cloud-sync-emulator-test.mjs).

The current rehearsal client requires a completed legacy assignment. Add an explicitly isolated multi-deck test mode rather than removing that guard. [src/cloud-on.ts](../../src/cloud-on.ts#L124), [vite.config.ts](../../vite.config.ts#L9).

Optional follow-ups:

- **Live sharing:** invitation lifecycle and owner/editor/viewer rules; acceptance includes outsider denial, private progress, leaving, revocation and retained rejected offline work.
- **Interval controls:** per-deck multiplier; acceptance includes default parity, future-only changes, consistent interval previews and unchanged existing due dates.

**Risks and mitigations.**

| Risk grounded in current implementation | Mitigation |
|---|---|
| Card/progress collision from ID-only keys | Compound identity throughout storage, queues, routes and adapters. [src/types.ts](../../src/types.ts#L77) |
| German cards appearing in unrelated decks | Explicit seed-pack provenance and initialization. [src/cloud-sync.ts](../../src/cloud-sync.ts#L82) |
| Read quotas exhausted despite few writes | Separate pushes from reconciliation, paginate and measure usage. [src/cloud-push.ts](../../src/cloud-push.ts#L35) |
| Incomplete/unrestorable backups after expansion | Recovery milestones precede production schema writes. [scripts/restore-core.mjs](../../scripts/restore-core.mjs#L111) |
| Old clients and pending offline work lost at cutover | Original wire compatibility, transactional migration and compatible rollback. [src/db.ts](../../src/db.ts#L175) |
| Clock skew or simultaneous reviews lose one state | Retain and document current conflict policy; review-event merging remains separate work. [docs/architecture.md](../../docs/architecture.md#L126) |

**Open decisions for Joakim.**

1. **Initial deck types:** basic plus German vocabulary, or additional language-specific templates immediately? Recommended: basic plus German.
2. **Onboarding:** retain the automatic German deck or start with deck selection? Recommended: preserve current onboarding initially.
3. **Sharing:** independent file copies or live subscriptions in the first release? Recommended: file copies.
4. **Compatibility lifetime:** accept the original-path adapter through this release, or require a full cloud migration? Recommended: retain the adapter.
5. **Scheduling:** keep current intervals, or include a per-deck multiplier now? Recommended: unchanged algorithm initially; one schedule across directions.
6. **Tier/filter flexibility:** optional three cumulative levels and tag facets, or arbitrary hierarchies? Recommended: the smaller model.
7. **Capacity and budget:** expected users, decks, import sizes and willingness to enable billing? Use measured results to set launch limits.
8. **Recovery ownership:** where should the off-machine private backups live, and what recovery-time/data-loss targets should release acceptance prove?

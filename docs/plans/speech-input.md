# Plan: speech input (spoken answers)

Status: proposal for #150. Phase 0 (device test page) and Phase 1 (Settings
switch and Hard-mode mic, #158) are implemented; Phase 1 follows the device
results: no Home Screen hint (decision 4 dropped, the Home Screen app works on
iOS 18.7) and app-side start/silence/stable/hard timeouts. The rest is not
implemented. The code, tests and
`docs/architecture.md` stay authoritative; this file describes a possible next
step and should be removed or archived once it ships or is dropped.

## Goal

On a review card, the learner taps a mic button and says the answer. The browser
transcribes it, the app compares the transcript with the card's expected answer
and shows a score. Accuracy is the minimum; fluency is optional and only where
the browser gives us usable signals. The primary target is **Safari on iPhone
and Mac**, which has the least reliable implementation of the Web Speech API.

## Hard requirement: off by default, per browser, hidden when off

- A new **Speech input** switch in Settings, directly below the existing
  **Speech** (output) switch. It works the **same way as Speech output**
  (`src/speech.ts`): one `localStorage` key, `${storagePrefix}.speech-input`,
  read once at module load, **off by default**, **only on this device** and
  **never synced**. It is not part of `Settings`/Firestore and not part of a
  deck.
- If the speech recognition API is missing, the switch is disabled with a note
  ("Speech input is not available in this browser."), as Speech output does now.
- **The mic button is not rendered at all** unless the switch is on **and** the
  API is available, and the current session has not marked recognition as
  unusable (see Feature detection). It is not hidden by CSS or rendered
  disabled. Removed means removed from the DOM, as `speakButton()` in
  `src/main.ts` already does.
- With the switch off, review screens and keyboard handling behave exactly as
  they do today. The UI test checks this.

## What the browser offers (Safari specifics)

Sources are listed at the end. **[V]** means checked against a source on
2026-10-31. **[U]** means unverified, and the Phase 0 device spike must confirm
it.

| Topic | Finding |
|---|---|
| Availability | Safari 14.1 on macOS and Safari on iOS/iPadOS 14.5 and later expose the API. caniuse rates it "partial" up to the current Safari 27.x. **[V]** |
| Name | Prefixed only: `webkitSpeechRecognition`. WebKit added the prefix when it enabled the API (STP 119), and nothing we found says Safari 26/27 removed it. Detect both `SpeechRecognition` and `webkitSpeechRecognition`. **[V]** prefix exists, **[U]** still prefix-only in 27.x |
| Engine / server | WebKit says it uses "the same speech engine as Siri". firt.dev describes it as an Apple cloud-based service. Treat audio as **sent to Apple**. **[V]** for the Siri engine, **[U]** for whether any language runs on device |
| Siri/Dictation setting | The API is only available when Siri is enabled (WebKit 14.1 notes). Bug 225298 also shows enabling Dictation fixes "service not available". Typical symptom: `error` with `service-not-allowed` or `not-allowed` right after `start()`. **[V]** |
| User gesture | `start()` must be called from a user activation, such as the click handler of the mic button. Never auto-start on card render. **[V]** (firt.dev) |
| Mic permission | The first `start()` triggers Safari's microphone prompt. iOS Safari can ask again per session or per page load, depending on Settings → Safari → Microphone. Denial shows up as an `error` event with `not-allowed`. **[U]** for the exact re-prompt behaviour |
| Home-screen PWA | A WebKit engineer said the API is **not available in SFSafariViewController or Home Screen web apps** (bug 225298, closed RESOLVED LATER, comments through 2025, no fix recorded). Apple forum reports agree. Our iPhone install path is Add to Home Screen, so **expect speech input not to work in the installed app on iOS** and to work only in a Safari tab. **[V]** that it is broken, **[U]** whether iOS 26/27 changed anything |
| `continuous` | We do not need it, because an answer is one short utterance. Use `continuous = false`. Safari's continuous mode is known to be unreliable. **[U]** |
| `interimResults` | Supported in Safari according to MDN/BCD. Needed only for the fluency signals. **[U]** for how often Safari emits interim results |
| `maxAlternatives` | We would like 3–5 for matching. Safari may return only one alternative. Code must work with one. **[U]** |
| `confidence` | Present on `SpeechRecognitionAlternative`, but Safari values are reportedly often 0 or constant. Never grade on it. **[U]** |
| `lang` | Set it explicitly per answer side with the existing `speechLang()` map: de-DE, es-ES, nb-NO, en-GB (also fr-FR and others). Do not rely on the page language. Siri supports all four, but the exact Safari recognition locale list is not published. **[U]** for nb-NO in particular |
| Auto-stop / timeouts | With `continuous = false`, recognition ends after a pause. Safari also ends a session that hears nothing after a few seconds (`no-speech` or a plain `end`). Add our own hard stop of about 8 s with `stop()`, and treat `end` with no final result as "didn't catch that". **[U]** for Safari's own timeouts |
| On-device API | The newer spec additions `processLocally`, `SpeechRecognition.available()` and `install()` are documented on MDN with Chrome/Edge implementations. We found nothing showing WebKit support. Feature-detect them and do not depend on them. **[U]** for Safari |
| Conflict with `speechSynthesis` | Recording and playback share the iOS audio session. Reports describe synthesis going silent or quiet after recognition, and recognition failing while an utterance plays. **[U]** Mitigation: call `cancelSpeech()` before `start()`, never call `speak()` while listening, and wait for `end` before any speak button works again |

Desktop Chrome/Edge also send audio to Google/Microsoft servers unless on-device
mode is used. Firefox has no usable recognition. These browsers are secondary
targets.

## Feature detection and fallback

New module `src/speech-input.ts`, shaped like `src/speech.ts`:

```ts
type Ctor = new () => SpeechRecognitionLike
function recognitionCtor(): Ctor | null  // window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
export function listenAvailable(): boolean   // ctor present && !unusableThisSession
export function listenEnabled(): boolean     // localStorage, default false
export function chooseListen(value: boolean): boolean
export function listen(lang: string, opts): ListenHandle // start/stop/abort, resolves to ListenResult
```

- Use a small local interface (`SpeechRecognitionLike`) instead of relying on
  `lib.dom` types, which do not include the prefixed constructor.
- **Static detection** (`listenAvailable`) is the constructor check only.
- **iOS standalone:** the constructor may exist but fail. When
  `matchMedia('(display-mode: standalone)').matches` or `navigator.standalone`
  is true on iOS, Phase 0 decides whether to (a) hide the mic up front or
  (b) try it and fall back. Recommendation: (b), with the runtime rule below,
  so the button reappears automatically if Apple fixes it.
- **Runtime fallback:** `service-not-allowed`, `not-allowed` or
  `audio-capture`, or a `start()` that throws, marks recognition unusable for
  the rest of the page session. The mic button disappears and one toast
  explains why. Examples: "Speech input needs microphone access" or "Speech
  input isn't available in the Home Screen app on iPhone — open in Safari".
  Typed answers and flip cards keep working. The stored preference is not
  changed.
- `no-speech`, `aborted` and `network` errors are per attempt. They show
  "Didn't catch that — try again" and leave the button in place.

## Answer matching

Reuse the existing pipeline in `src/hard-mode.ts` and add a speech-tolerant
layer around it. Do not fork it.

1. **Normalise the transcript** with `answerKey()` (NFC, case, typography,
   punctuation, German ä/ö/ü/ß ↔ ae/oe/ue/ss). Speech also needs extra
   handling: strip filler words at the edges, using a list chosen by the
   answer-side language. Never use one shared list: German `um` is a
   preposition and separable prefix ("um sieben", "um zu", "steig um"),
   so it is a filler only for English. Lists hold only sounds that are not
   words in that language. Proposed: de äh, ähm, öh, öhm; en um, uh, er, erm;
   es eh, ehm; nb eh, ehm, øh.
   Also never strip a token that appears as a word in any accepted answer
   for the card, and never strip if that would leave the transcript empty.
   Then collapse repeated words ("der der Hund"), and map spelled-out ↔ digit
   numbers for cards whose answer is a number. Recognisers often write
   "3" for "drei".
2. **Accents.** Unlike typing, the learner cannot "misspell" an accent. The
   recogniser chooses the spelling, so a missing accent in the transcript is a
   recognition artefact. Compare a second key with all diacritics stripped
   (NFD, remove combining marks) and accept that as a match. For German nouns,
   still compare the article separately.
3. **Multiple accepted answers** come from the existing `alternatives()` split
   on `/` and `;`, with optional trailing glosses. Try every recogniser
   alternative (up to `maxAlternatives`) against every accepted answer and keep
   the best.
4. **Articles.** When the deck uses articles and the card has one, run the
   existing `matchAnswer` logic. The right article gives `correct`, a wrong
   gender with the right word gives `wrong_gender`, and a missing article does
   not count as correct. Speech adds one risk: recognisers sometimes drop or
   mishear short articles ("die" ↔ "dir", "el" swallowed). Use exact match
   for the article token and fuzzy match only for the word. Treat a missing
   article as `incorrect`, the same as typing (decision 3).
5. **Fuzzy word match.** Use normalised Levenshtein similarity on the word
   part (ratio = 1 − distance / max length). It is simple, has no dependency
   and is easy to test. Phonetic algorithms (Kölner Phonetik for German,
   Soundex/Metaphone variants) are language-specific and add little because
   the recogniser already outputs real words. Leave them out of scope.
   Proposed bands, to be tuned in Phase 0 with real transcripts:
   - exact after normalisation → `correct`
   - ratio ≥ 0.85, or one edit for words of 5 letters or fewer → `close`
     (the recogniser heard almost the right word)
   - otherwise → `incorrect`
6. **Grade mapping.** The result type is
   `SpokenMatch = AnswerMatch | 'close'`.
   - **Hard mode (typed-answer screen):** the transcript is put into the answer
     field, and the learner sees it and can edit it before **Check answer**.
     Submitting then uses the unchanged `matchAnswer` → `automaticGrade` path,
     so Easy/Good/Gender/Again stay exactly as they are now. `close` matters
     only as the hint "Heard: … — close"; the typed path decides the grade.
     This is the recommended Phase 1 because grading does not change at all.
     No auto-submit (decision 1).
   - **Flip mode:** the mic sits on the front face. A spoken answer flips the
     card and shows "You said: …" with a **suggested** grade highlighted on the
     grade bar. Suggestions: `correct` → Good, `close` → Hard,
     `wrong_gender` → Gender, `incorrect` → Again. The learner still taps
     (or uses keys 1–5) to grade. A `close` match suggests Hard (decision 5), so scheduling never depends on the
     recogniser alone. Easy is never suggested, because recognition cannot
     tell an instant answer from a slow one.
7. Matching lives in a pure function, `matchSpoken(card, direction,
   alternatives[], languages)`, in `src/hard-mode.ts` or a new
   `src/spoken-match.ts`. The Node unit tests cover it.

**Which language is spoken?** The answer side. For `de-en` the learner says
the base-language word, using `speechLang(baseLang)`, e.g. en-GB. For `en-de`
they say the target word, using `speechLang(targetLang)`. Pronunciation
practice mostly matters for `en-de`. Decision 2: the mic is offered **only
when the answer is in the target language** (`en-de`); in `de-en` there is no
mic button.

## Fluency (optional, display-only)

These signals are available from events without any extra API:

| Signal | How | Realistic in Safari? |
|---|---|---|
| Start latency | `audiostart`/`start` → `speechstart`, or → first `result` if `speechstart` is missing | Probably. Event support is **[U]**. Fall back to the button tap → first result |
| Duration | `speechstart` → `speechend`, or → last result | Probably **[U]** |
| Hesitation | Number of interim results whose text was later revised. Filler words seen in interim but stripped from final text. Gap length between interim updates | Only if Safari emits interim results often enough **[U]** |
| Confidence | `results[i][0].confidence` | Unreliable, see above. Show nothing based on it |

Decision 6: Phase 3 shows a small "fluency" line on the result, such as
"Started after 0.8 s · 1.2 s · smooth/hesitant", and **does not feed it into
grading or SRS**. Real pronunciation or fluency scoring (phoneme alignment,
prosody) needs raw audio and an acoustic model. Examples are a WASM model such
as Whisper or Vosk with `getUserMedia`, or a paid pronunciation-assessment API.
That is a separate project with download-size, battery and privacy costs, and
it is out of scope here.

## UI

- **Settings:** "Speech input" switch below "Speech", with the same markup
  (`setting-switch`, `role="switch"`). The note reads: "Show a mic button on
  review cards to answer by voice. Only on this device. Safari sends audio to
  Apple for recognition." The toast on storage failure copies the Speech one.
  **Off by default, stored per browser, not synced.**
- **Mic button:** a `🎤` button with `aria-label="Answer by voice"`,
  **rendered only when `listenEnabled() && listenAvailable()`**. With the
  switch off or the API missing, there is no button in the DOM.
  - Flip mode: on the front, before flipping, next to the speak button.
  - Hard mode: beside the answer field.
  - Only when the answer side is the target language (decision 2).
- **Home Screen app hint (decision 4):** when the switch is on and the app
  runs standalone (`navigator.standalone` or `display-mode: standalone`)
  where recognition does not work, show a short hint on review cards:
  "Speech input works in a Safari tab. Open the site in Safari to use it."
- **Listening state:** the button gets `aria-pressed="true"` and a pulsing
  style. Tapping again stops. A `role="status"` line shows "Listening…" and
  the interim transcript.
- **Keyboard:** the review `onKey` handler already ignores events from
  `[data-speak]`. Extend that to `[data-listen]` so Space/Enter on the mic does
  not flip the card. No new global shortcut in Phase 1.
- **Lifecycle:** call `abort()` on card advance, route change (`go()`),
  `visibilitychange` to hidden and session end. This mirrors where
  `cancelSpeech()` is called today. Only one recognition can run at a time.

## Privacy

- Safari's recognition is Siri-engine and, as far as public sources say,
  server-based. **Audio may be sent to Apple** and is covered by Apple's
  Siri/Dictation privacy terms, not by this app. Chrome sends audio to
  Google unless on-device mode is used. Say this in the Settings note.
  Opting in is what makes it acceptable (decision 7: accepted, with the note).
- The app itself stores nothing. No audio, no transcripts and no fluency
  numbers go to IndexedDB, Firestore or analytics. The transcript lives only in
  the current card's in-memory state. `firestore.rules` and sync code do not
  change.
- Microphone access is requested only on a mic-button tap, never on load.

## Tests

- **Unit (Node, `scripts/speech-input-test.mjs`, added to `npm test`):**
  `matchSpoken` tables per language. Cover umlaut/ß variants, stripped accents
  (es "árbol" → "arbol"), per-language fillers (de "um" kept as an answer
  or its first word; en "um" stripped; a filler that is also an accepted
  answer kept), repeated words, numbers, wrong-gender
  articles, alternatives with glosses, and the `close` threshold edges. Also
  check `listenAvailable()` is false outside a browser and `listenEnabled()`
  is false by default, as `speech-test.mjs` does.
- **UI (`scripts/speech-input-ui-test.mjs` → `npm run test:speech-input-ui`):**
  Playwright + Chromium, structured like `scripts/speech-ui-test.mjs`. An
  `addInitScript` installs a **fake `webkitSpeechRecognition` class** whose
  `start()` records `lang`/`continuous`/`interimResults` on
  `window.__listens`. The test drives it through
  `window.__recognize({ interim: [...], final: [[alt1, alt2]], error })`,
  which dispatches `start`, `audiostart`, `speechstart`, `result`
  (with `isFinal` false and then true) and `end` on a timer. Cases:
  - switch off by default; **no `[data-listen]` in the DOM** in flip or Hard
    mode while off
  - API missing (`noRecognition` init deleting both constructors): switch
    disabled with the note, and no mic button even if localStorage says true
  - on: mic present; the correct `lang` per direction/deck (de-DE, es-ES,
    nb-NO, en-GB)
  - `cancelSpeech` called before `start()` (reuse the speech fake's cancel
    counter)
  - Hard mode: the transcript fills the field and grading is unchanged
  - flip mode: the card flips and the correct grade button is suggested
  - `not-allowed` error: the button disappears and a toast shows
  - `no-speech`: the button stays and a retry message shows
  - route change during listening calls `abort()`
  - the preference survives reload and is not in `getSettings()` or the
    synced payload, mirroring the existing `settingsBefore` check
- **Manual (human evidence, not automatable):** Safari on iPhone (tab and Home
  Screen app) and Safari on Mac, one deck each in de/es/nb/en. Record the
  results in the PR.

## Effort and phases

| Phase | Scope | Estimate |
|---|---|---|
| 0 Spike | Standalone device test page (`public/speech-test.html`, not linked from the app, no app behaviour changes) that logs every event, transcript, alternative count and confidence on iPhone Safari (tab + Home Screen) and Mac Safari for the four languages. Settles the **[U]** rows, the timeouts and the `close` threshold. Needs Joakim's devices | 0.5 day + device time |
| 1 Toggle + Hard mode | `src/speech-input.ts`, Settings switch, detection/fallback, mic in Hard mode filling the answer field, lifecycle aborts, unit + UI tests, architecture doc update | 1.5 days |
| 2 Flip mode | `matchSpoken` with fuzzy/accent rules, "You said" panel, suggested grade, tests | 1 day |
| 3 Fluency | Latency/duration/hesitation line, display-only, tests with the fake's timed events | 0.5–1 day |

Total about 3.5–4 days plus device testing. Each phase is a separate PR, and
each is useful without the next.

## Decisions (Joakim, 2026-10-31)

Joakim chose the recommended answers to the former open questions:

1. **Hard mode:** a spoken answer fills the answer field for review. No
   auto-submit.
2. **Direction:** the mic is shown only when the answer is in the target
   language (`en-de`), for speaking practice.
3. **German articles:** a noun spoken without its article stays `incorrect`,
   the same as typing.
4. **iPhone Home Screen app:** show a hint to open the site in a Safari tab.
5. **Flip mode:** a close fuzzy match suggests Hard.
6. **Fluency:** keep the Phase 3 fluency line, display-only (no grading/SRS
   effect).
7. **Privacy:** audio going to Apple/Google servers is acceptable, with the
   note in Settings.

## Sources (checked 2026-10-31)

- MDN, SpeechRecognition (properties, events, `processLocally`,
  `available()`/`install()`, server-based note):
  <https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition>
- MDN, `SpeechRecognition.available()`:
  <https://developer.mozilla.org/docs/Web/API/SpeechRecognition/available_static>
- caniuse, Speech Recognition API (Safari 14.1+, iOS 14.5+, partial through
  27.x): <https://caniuse.com/speech-recognition>
- WebKit, New WebKit Features in Safari 14.1 (Siri engine; Siri must be
  enabled): <https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/>
- WebKit, Safari Technology Preview 119 release notes (enabled by default,
  webkit- prefix): <https://www.webkit.org/?p=11525>
- WebKit Bugzilla 225298, "Speech recognition service is not available"
  (unavailable in SFSafariViewController and Home Screen web apps; RESOLVED
  LATER): <https://bugs.webkit.org/show_bug.cgi?id=225298>
- Apple Developer Forums, webkitSpeechRecognition in a PWA:
  <https://developer.apple.com/forums/thread/748048>
- Maximiliano Firtman, iOS 14.5 (cloud-based service, user gesture, not in
  standalone PWA): <https://firt.dev/ios-14.5/>
- Microsoft Edge, Speech recognition API (on-device mode, Canary/Dev):
  <https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api>

Not found: any WebKit/Apple statement about Safari support for
`processLocally`, any Safari 26/27 change to speech recognition, or a published
list of Safari recognition locales. These remain **[U]** until Phase 0.

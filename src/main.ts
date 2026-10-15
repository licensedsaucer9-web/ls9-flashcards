import './style.css'
import { registerSW } from 'virtual:pwa-register'
import type { Article, Card, Direction, Grade, LocalDeck, PublicSettings, Tier, WordType } from './types.ts'
import { ARTICLES } from './types.ts'
import { deckSyncs } from './record-sync.ts'
import {
  accountBadge,
  accountHomeNote,
  accountPanelHtml,
  accountSignIn,
  accountSyncText,
  bindAccountPanel,
  markAccountBooted,
  noteLocalChange,
  onAccountSync,
  prepareAccount,
  takeFreshPersonalDeck,
} from './account.ts'
import type { AccountHooks } from './account-hooks.ts'
import {
  DatabaseBlockedError,
  deleteCard,
  getAllCards,
  getActiveDeck,
  getDeckCardCounts,
  getDecks,
  createLocalDeck,
  putDeckFeatures,
  switchActiveDeck,
  getCard,
  getDueByTier,
  getSettings,
  importLegacyData,
  insertMissingSeeds,
  onDatabaseEvent,
  putCard,
  putCards,
  putSettings,
  saveReview,
} from './db.ts'
import { seedCards } from './seed.ts'
import { seedBeforeFirstSync } from './sign-in-flow.ts'
import { newSrs } from './srs.ts'
import { quietlyRefreshStreak, refreshStreakDay, streakPlaceholder } from './streak-ui.ts'
import { importCsv } from './csv.ts'
import { $, esc, formatDue, germanHead, shuffle } from './dom.ts'
import {
  countWordTypes,
  editorTagField,
  editorWordType,
  noDueWordTypeMessage,
  normalizeWordTypes,
  reviewFaces,
  sameWordTypes,
  savedWordTypes,
  tagsWithWordType,
  tagsWithoutTypeEdit,
  toggleWordType,
  wordTypeBadgeHtml,
  wordTypeSelectionLabel,
  wordTypeSpoken,
  type WordTypeCounts,
} from './word-types.ts'
import { selectReviewCandidates, sessionCount, SESSION_PRESETS, suggestSessionSize } from './session.ts'
import { tierCounts, tierOf, tierLabel, TIERS, TIER_NOTES } from './tiers.ts'
import { captureStudyLock, studyLockCurrent, type StudyLock } from './study-lock.ts'
import { recoveryBridge, rehearsalPreview } from './rehearsal.ts'
import { buildInfo } from './build-info.ts'
import {
  bootSync,
  deckSelectionChanged,
  onSyncStatus,
  pauseSync,
  schedulePush,
  syncNow,
} from './sync.ts'

registerSW({ immediate: true })

type Route =
  | { name: 'home' }
  | { name: 'review' }
  | { name: 'deck' }
  | { name: 'decks' }
  | { name: 'edit'; id: string | null }
  | { name: 'import' }
  | { name: 'settings' }

const app = $('#app')
const main = $('#main')
const tabbar = $('#tabbar')

let toastTimer = 0

function parseRoute(): Route {
  const hash = location.hash.replace(/^#/, '') || '/'
  const parts = hash.split('/').filter(Boolean)
  if (parts.length === 0) return { name: 'home' }
  if (parts[0] === 'review') return { name: 'review' }
  if (parts[0] === 'deck') return { name: 'deck' }
  if (parts[0] === 'decks') return { name: 'decks' }
  if (parts[0] === 'import') return { name: 'import' }
  if (parts[0] === 'settings') return { name: 'settings' }
  if (parts[0] === 'card' && parts[1] === 'new') return { name: 'edit', id: null }
  if (parts[0] === 'card' && parts[1]) return { name: 'edit', id: parts[1] }
  return { name: 'home' }
}

function go(path: string) {
  location.hash = path
}

function toast(msg: string) {
  document.getElementById('toast')?.remove()
  const el = document.createElement('div')
  el.id = 'toast'
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el.remove(), 2400)
}

function pushSoon(): void {
  if (accountSignIn && !captureStudyLock().uid) {
    noteLocalChange()
    return
  }
  schedulePush()
}

async function ensureSeed(): Promise<number> {
  // insertMissingSeeds only writes rows into the original deck, whichever deck is active.
  const added = await insertMissingSeeds(seedCards())
  if (added) pushSoon()
  return added
}

async function patchSettings(patch: Partial<PublicSettings>): Promise<void> {
  await putSettings(patch)
  pushSoon()
}

const accountHooks: AccountHooks = {
  toast,
  ensureSeed,
  onIdentityChanged() {
    scheduleRender()
  },
  setTabs(visible) {
    setTabbar(visible ? 'home' : 'none')
  },
}

function showDatabaseNotice(event: 'versionchange' | 'blocked'): void {
  let banner = document.getElementById('db-block')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'db-block'
    banner.className = 'db-block'
    document.body.appendChild(banner)
  }
  banner.textContent = event === 'blocked'
    ? 'A database upgrade is waiting on another tab. Close other LS9 Flashcards tabs and reload.'
    : 'This tab closed its database so another tab can upgrade. Reload to continue.'
}

/** A shared chip row for choosing the highest tier to include. */
function tierChips(selected: Tier, dueByTier: Record<Tier, { due: number; total: number }>): string {
  // Both numbers run cumulatively up to each tier, so a chip matches the queue you
  // would actually review: tier 2 is 250 words and up to 250 due, not 150. The totals
  // are computed per chip because the Deck screen can show a tier that is not the
  // saved setting.
  let words = 0
  let due = 0
  return TIERS.map((tier) => {
    words += dueByTier[tier].total
    due += dueByTier[tier].due
    const on = selected === tier ? ' is-on' : ''
    return `<button type="button" class="chip tier-chip${on}" data-tier="${tier}" title="${esc(TIER_NOTES[tier])}">Tier ${tier}<small>${words} · ${due} due</small></button>`
  }).join('')
}

function bindTierChips(onPick: (tier: Tier) => void): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach((btn) => {
    btn.addEventListener('click', () => onPick(Number(btn.dataset.tier) as Tier))
  })
}

const WORD_TYPE_CHIPS: { id: 'all' | WordType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'noun', label: 'Nouns' },
  { id: 'verb', label: 'Verbs' },
  { id: 'adj', label: 'Adjectives' },
]

function wordTypeCountsFor(cards: Card[], tier: Tier, now = Date.now()): WordTypeCounts {
  return countWordTypes(
    cards
      .filter((card) => tierOf(card) <= tier)
      .map((card) => ({ tags: card.tags, article: card.article, due: card.srs.due <= now })),
  )
}

function wordTypeChips(selected: readonly WordType[], counts: WordTypeCounts): string {
  const chosen = normalizeWordTypes(selected)
  return WORD_TYPE_CHIPS.map((chip) => {
    const on = chip.id === 'all' ? chosen.length === 0 : chosen.includes(chip.id)
    const count = counts[chip.id]
    return `<button type="button" class="chip type-chip${on ? ' is-on' : ''}" data-word-type="${chip.id}" aria-pressed="${on ? 'true' : 'false'}">${chip.label}<small>${count.words} · ${count.due} due</small></button>`
  }).join('')
}

function bindWordTypeChips(current: readonly WordType[], onPick: (next: WordType[]) => void): void {
  document.querySelectorAll<HTMLButtonElement>('[data-word-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.wordType
      if (!value || value === 'all') {
        onPick([])
        return
      }
      if (value !== 'noun' && value !== 'verb' && value !== 'adj') return
      onPick(toggleWordType(current, value))
    })
  })
}

function scopeLabel(tier: Tier, types: readonly WordType[], deck?: LocalDeck): string {
  const typesLabel = wordTypeSelectionLabel(types)
  const tierText = deck?.tiers === false ? 'All cards' : tierLabel(tier)
  return typesLabel ? `${tierText} · ${typesLabel}` : tierText
}

function touch(card: Card): Card {
  return { ...card, updated_at: Date.now() }
}

function syncLineText(): string {
  if (accountSignIn) return accountSyncText()
  return 'On this device'
}

function setTabbar(active: 'home' | 'deck' | 'decks' | 'settings' | 'none') {
  const show = active !== 'none'
  app.classList.toggle('has-tabbar', show)
  tabbar.hidden = !show
  tabbar.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.getAttribute('data-tab') === active)
  })
}

function genderClass(article: Article): string {
  return article === 'none' ? 'none' : article
}

function iconReview() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/></svg>`
}
function iconDeck() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h11v12H8z"/><path d="M5 8v10a2 2 0 0 0 2 2h10"/></svg>`
}
function iconCards() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`
}
function iconSettings() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4"/></svg>`
}

tabbar.innerHTML = `
  <a class="tab" data-tab="home" href="#/">${iconReview()}Review</a>
  <a class="tab" data-tab="deck" href="#/deck">${iconCards()}Cards</a>
  <a class="tab" data-tab="decks" href="#/decks">${iconDeck()}Decks</a>
  <a class="tab" data-tab="settings" href="#/settings">${iconSettings()}Settings</a>
`

async function renderHome() {
  const lock = captureStudyLock()
  setTabbar('home')
  const settings = await getSettings()
  const all = await getAllCards()
  const activeDeck = await getActiveDeck()
  if (!studyLockCurrent(lock)) return
  const now = Date.now()
  const reviewTier = activeDeck?.tiers === false ? 3 : settings.tier
  const reviewTypes = activeDeck?.supportsWordTypes === false ? [] : settings.wordTypes
  const candidates = selectReviewCandidates(all, reviewTier, reviewTypes, now)
  const available = candidates.cards.length
  const suggested = suggestSessionSize(available)
  const n = sessionCount(available, settings.sessionSize)
  const next = candidates.dueCount === 0 ? candidates.cards[0] : undefined
  const noneOfType = reviewTypes.length > 0 && available === 0
  const ready = candidates.dueCount > 0
  const canStart = available > 0
  const startLabel = ready
    ? n === available
      ? `Start ${n} ${n === 1 ? 'card' : 'cards'}`
      : `Start ${n} of ${available}`
    : canStart ? `Review ${n} ${n === 1 ? 'card' : 'cards'} ahead` : 'Start review'
  const presets = SESSION_PRESETS.map((size) => {
    const on = settings.sessionSize === size
    const label = size === 0 ? 'All' : String(size)
    const extra = size === suggested ? ' · suggested' : ''
    return `<button type="button" class="chip ${on ? 'is-on' : ''}" data-session="${size}">${label}${extra}</button>`
  }).join('')
  main.innerHTML = `
    <section class="screen">
      <header class="topbar">
        <h1>${esc(activeDeck && activeDeck.origin !== 'original' ? activeDeck.name : 'LS9 Flashcards')}</h1>
        <span class="badge" id="sync-line">${esc(syncLineText())}</span>
      </header>
      ${streakPlaceholder()}
      <div class="due-hero">
        <p class="kicker">Due now · ${esc(scopeLabel(reviewTier, reviewTypes, activeDeck))}</p>
        <div class="due-count ${ready ? '' : 'caught-up'}" data-due-count>${candidates.dueCount}</div>
        <p class="due-label">${
          noneOfType
            ? esc(noDueWordTypeMessage(reviewTypes, reviewTier))
            : ready
            ? candidates.dueCount === 1
              ? 'card waiting'
              : 'cards waiting'
            : next
              ? `Caught up · next ${formatDue(next.srs.due)}`
              : openingEmptyDeck
                ? 'Opening your deck…'
                : 'No cards yet'
        }</p>
        ${noneOfType ? '<button type="button" class="secondary" id="show-all-types">All</button>' : ''}
        <div class="session-box">
          <p class="kicker" style="margin:0">This session</p>
          <div class="chips" id="session-chips">${presets}</div>
          <label class="inline-num">Custom
            <input id="session-custom" type="number" min="1" step="1" inputmode="numeric" value="${
              settings.sessionSize > 0 ? settings.sessionSize : ''
            }" placeholder="${suggested}" />
          </label>
        </div>
        <button class="primary" id="start" data-session-count="${n}" ${canStart ? '' : 'disabled'}>${esc(startLabel)}</button>
        <p class="note" id="who">${accountSignIn ? accountHomeNote() : 'On this device'}</p>
      </div>
    </section>
  `
  $('#start').addEventListener('click', () => {
    if (canStart) go('/review')
  })
  document.getElementById('show-all-types')?.addEventListener('click', async () => {
    await patchSettings({ wordTypes: [] })
    await renderHome()
  })
  $('#session-chips').querySelectorAll<HTMLButtonElement>('[data-session]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await patchSettings({ sessionSize: Number(btn.dataset.session) })
      await renderHome()
    })
  })
  const custom = $('#session-custom') as HTMLInputElement
  custom.addEventListener('change', async () => {
    const v = Math.floor(Number(custom.value))
    if (!Number.isFinite(v) || v < 1) return
    await patchSettings({ sessionSize: v })
    await renderHome()
  })
}

let unbindKeys: (() => void) | null = null

async function renderReview() {
  const lock = captureStudyLock()
  setTabbar('none')
  const settings = await getSettings()
  if (!studyLockCurrent(lock)) return
  const activeDeck = await getActiveDeck()
  if (!studyLockCurrent(lock)) return
  const all = await getAllCards()
  if (!studyLockCurrent(lock)) return
  const reviewTier = activeDeck?.tiers === false ? 3 : settings.tier
  const reviewTypes = activeDeck?.supportsWordTypes === false ? [] : settings.wordTypes
  const candidates = selectReviewCandidates(all, reviewTier, reviewTypes)
  const reviewingAhead = candidates.dueCount === 0
  const ordered = reviewingAhead ? candidates.cards : shuffle(candidates.cards)
  const queue = ordered.slice(0, sessionCount(ordered.length, settings.sessionSize))
  if (queue.length === 0) {
    go('/')
    return
  }

  const sessionTotal = queue.length
  const leftover = () => Math.max(0, candidates.dueCount - sessionTotal)
  let flipped = false
  let saving = false
  let attempt: string | null = null

  const paint = () => {
    if (!studyLockCurrent(lock) || parseRoute().name !== 'review') return
    const card = queue[0]
    if (!card) {
      main.innerHTML = `
        <section class="screen review">
          <header class="topbar">
            <button class="ghost" id="back">Close</button>
            <h1>Done</h1>
            <span></span>
          </header>
          ${streakPlaceholder()}
          <div class="due-hero">
            <p class="kicker">Session</p>
            <div class="due-count caught-up">0</div>
            <p class="due-label">${
              reviewingAhead
                ? 'Review ahead complete'
                : leftover() > 0
                ? `Session complete · ${leftover()} still due`
                : 'No more due cards'
            }</p>
            <button class="primary" id="home">Back home</button>
          </div>
        </section>
      `
      quietlyRefreshStreak()
      $('#back').addEventListener('click', () => go('/'))
      $('#home').addEventListener('click', () => go('/'))
      return
    }

    const remaining = queue.length
    const done = sessionTotal - remaining
    const pct = Math.round((done / sessionTotal) * 100)
    const faces = reviewFaces(card, settings.direction, activeDeck)
    const wordClass = (name: string) => (name ? ` ${name}` : '')

    main.innerHTML = `
      <section class="screen review">
        <header class="topbar">
          <button class="ghost" id="back">Close</button>
          <div class="review-meta">${reviewingAhead ? 'Review ahead · ' : ''}<span data-remaining>${remaining}</span> left · ${esc(scopeLabel(reviewTier, reviewTypes, activeDeck))}</div>
          <span></span>
        </header>
        ${streakPlaceholder()}
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="card-stage">
          <button class="flip ${flipped ? 'is-flipped' : ''}" id="card" type="button" aria-label="Flip card">
            <div class="flip-inner">
              <div class="${faces.front.className}">
                ${faces.front.kickerHtml}
                <div class="word${wordClass(faces.front.wordClass)}">${esc(faces.front.wordText)}</div>
                <p class="hint">${flipped ? '' : 'Tap to flip'}</p>
              </div>
              <div class="${faces.back.className}">
                ${faces.back.kickerHtml}
                <div class="word${wordClass(faces.back.wordClass)}">${esc(faces.back.wordText)}</div>
                ${
                  card.example_de
                    ? `<p class="example"><strong>${esc(card.example_de)}</strong>${
                        card.example_en ? `<br>${esc(card.example_en)}` : ''
                      }</p>`
                    : ''
                }
              </div>
            </div>
          </button>
        </div>
        <div class="grades ${activeDeck?.articles !== false && card.article !== 'none' ? 'noun' : ''}" ${flipped ? '' : 'hidden'}>
          <button class="grade again" data-grade="again">Again<small>1</small></button>
          ${
            activeDeck?.articles !== false && card.article !== 'none'
              ? `<button class="grade gender" data-grade="wrong_gender">Gender<small>5</small></button>`
              : ''
          }
          <button class="grade hard" data-grade="hard">Hard<small>2</small></button>
          <button class="grade good" data-grade="good">Good<small>3</small></button>
          <button class="grade easy" data-grade="easy">Easy<small>4</small></button>
        </div>
      </section>
    `

    quietlyRefreshStreak()
    $('#back').addEventListener('click', () => go('/'))
    $('#card').addEventListener('click', () => {
      if (flipped) return
      flipped = true
      paint()
    })
    main.querySelectorAll<HTMLButtonElement>('[data-grade]').forEach((btn) => {
      btn.addEventListener('click', () => grade(btn.dataset.grade as Grade))
    })
  }

  const grade = async (g: Grade) => {
    if (!studyLockCurrent(lock) || saving || !flipped) return
    const card = queue[0]
    if (!card) return
    saving = true
    attempt ??= crypto.randomUUID()
    try {
      const saved = await saveReview(card.id, g, attempt)
      if (!studyLockCurrent(lock)) return
      queue.shift()
      attempt = null
      // A sync-deleted card is skipped without earning activity or resurrecting it.
      if (saved) {
        pushSoon()
        if (g === 'again' || g === 'wrong_gender') queue.push(saved)
      }
      flipped = false
      paint()
    } catch {
      if (studyLockCurrent(lock)) toast('Could not save this review. Try again.')
    } finally {
      saving = false
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof Element && e.target.closest('[data-streak]')) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (!flipped && queue[0]) {
        flipped = true
        paint()
      }
      return
    }
    if (!flipped) return
    const map: Record<string, Grade> = {
      '1': 'again',
      '2': 'hard',
      '3': 'good',
      '4': 'easy',
      '5': 'wrong_gender',
    }
    const g = map[e.key]
    if (g === 'wrong_gender' && (activeDeck?.articles === false || queue[0]?.article === 'none')) return
    if (g) void grade(g)
  }

  unbindKeys?.()
  window.addEventListener('keydown', onKey)
  unbindKeys = () => window.removeEventListener('keydown', onKey)
  paint()
}

async function renderDecks() {
  const lock = captureStudyLock()
  setTabbar('decks')
  const decks = await getDecks()
  const cards = await getAllCards()
  const settings = await getSettings()
  if (!studyLockCurrent(lock)) return
  const deckCounts = await getDeckCardCounts()
  if (!studyLockCurrent(lock)) return
  const dueByTier = await getDueByTier()
  if (!studyLockCurrent(lock)) return
  const activeDeck = decks.find(deck => deck.id === settings.activeDeckId)
  if (!activeDeck) return
  const { targetLang, baseLang } = activeDeck
  const counts = tierCounts(cards)
  const typeCounts = wordTypeCountsFor(cards, activeDeck.tiers ? settings.tier : 3)
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar"><h1>Decks</h1></header>
      <ul class="card-list">
        ${decks.map((deck) => {
          const n = deckCounts.get(deck.id) ?? 0
          const active = deck.id === settings.activeDeckId
          return `<li class="card-row">
            <div class="left">
              <div class="de">${esc(deck.name)}</div>
              <div class="en">${deck.origin === 'original' ? '' : `${esc(deck.targetLang)} · `}${n} ${n === 1 ? 'card' : 'cards'}</div>
            </div>
            ${active ? '<span class="badge">Active</span>' : `<button type="button" class="chip" data-switch="${esc(deck.id)}">Switch</button>`}
          </li>`
        }).join('')}
      </ul>
      <form class="setting" id="new-deck">
        <p class="kicker" style="margin:0">New deck</p>
        <input name="name" type="text" placeholder="Deck name" required maxlength="60" autocomplete="off" />
        <input name="targetLang" type="text" placeholder="Target language" required maxlength="40" autocomplete="off" />
        <p class="note">English is the base language. The new deck starts empty and stays on this device.</p>
        <button type="submit" class="chip">Create and switch</button>
      </form>
      <div class="setting" role="group" aria-label="Deck extras">
        ${([['articles', 'Articles'], ['supportsWordTypes', 'Word types'], ['tiers', 'Tiers']] as const).map(([key, label]) => `<label><input type="checkbox" role="switch" data-feature="${key}" ${activeDeck[key] ? 'checked' : ''} /> ${label}</label>`).join('')}
      </div>
      ${activeDeck.tiers ? `<div class="setting">
        <p class="kicker" style="margin:0">Deck tier</p>
        <div class="chips" id="tier-chips">${tierChips(settings.tier, dueByTier)}</div>
        <p class="note">${esc(TIER_NOTES[settings.tier])} Higher tiers include the lower ones, so tier 2 reviews everything in tier 1 too. ${counts[1]} / ${counts[1] + counts[2]} / ${cards.length} words.</p>
      </div>` : ''}
      <div class="setting">
        <p class="kicker" style="margin:0">Review direction</p>
        <div class="seg" id="dir">
          <button type="button" data-dir="de-en" class="${settings.direction === 'de-en' ? 'is-on' : ''}">${esc(targetLang)} → ${esc(baseLang)}</button>
          <button type="button" data-dir="en-de" class="${settings.direction === 'en-de' ? 'is-on' : ''}">${esc(baseLang)} → ${esc(targetLang)}</button>
        </div>
        <p class="note">${esc(targetLang)} → ${esc(baseLang)} shows the ${esc(targetLang)} word first. ${esc(baseLang)} → ${esc(targetLang)} shows ${esc(baseLang)} first.</p>
      </div>
      ${activeDeck.supportsWordTypes ? `<div class="setting">
        <p class="kicker" style="margin:0">Word type</p>
        <div class="chips" id="type-chips" role="group" aria-label="Word type">${wordTypeChips(settings.wordTypes, typeCounts)}</div>
        <p class="note">All reviews every word type, including words with no type. Pick nouns, verbs, adjectives, or any combination. Turning the last type off returns to All. A card with more than one type is still reviewed once. This does not change when a card is due.</p>
      </div>` : ''}
    </section>
  `
  main.querySelectorAll<HTMLInputElement>('[data-feature]').forEach(input => {
    input.addEventListener('change', async () => {
      await putDeckFeatures({ [input.dataset.feature!]: input.checked })
      scheduleRender()
    })
  })
  $('#new-deck').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim()
    const targetLang = (form.elements.namedItem('targetLang') as HTMLInputElement).value.trim()
    if (!name || !targetLang) return
    const created = await createLocalDeck(name, targetLang)
    if (!created) {
      toast('Could not create the deck')
      return
    }
    deckSelectionChanged(false)
    toast(`Switched to ${created.name}`)
    go('/')
  })
  main.querySelectorAll<HTMLButtonElement>('[data-switch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await switchActiveDeck(btn.dataset.switch!))) {
        toast('Could not switch decks')
        return
      }
      // Returning to the original deck resumes its pending cloud sync right away.
      deckSelectionChanged(deckSyncs(await getActiveDeck()))
      go('/')
    })
  })
  bindTierChips(async (tier) => {
    await patchSettings({ tier })
    scheduleRender()
  })
  $('#dir').querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const direction = btn.dataset.dir as Direction
      await patchSettings({ direction })
      toast(direction === 'de-en' ? `${targetLang} → ${baseLang}` : `${baseLang} → ${targetLang}`)
      scheduleRender()
    })
  })
  bindWordTypeChips(settings.wordTypes, async (wordTypes) => {
    if (sameWordTypes(settings.wordTypes, wordTypes)) return
    await patchSettings({ wordTypes })
    scheduleRender()
  })
}

async function renderDeck() {
  setTabbar('deck')
  const activeDeck = (await getActiveDeck())!
  const { targetLang, baseLang } = activeDeck
  const all = await getAllCards()
  const settings = await getSettings()
  const dueByTier = await getDueByTier()
  const now = Date.now()
  // The deck list is a browser, not a review queue, so it starts on the chosen
  // tier and can be widened with the filter.
  let maxTier: Tier = activeDeck.tiers ? settings.tier : 3
  const list = (filter: string) => {
    const q = filter.trim().toLowerCase()
    return all
      .filter((c) => tierOf(c) <= maxTier)
      .filter((c) => {
        if (!q) return true
        return (
          c.de.toLowerCase().includes(q) ||
          c.en.toLowerCase().includes(q) ||
          c.tags.some((t) => t.toLowerCase().includes(q)) ||
          c.article.includes(q)
        )
      })
      .sort((a, b) => a.de.localeCompare(b.de, 'de'))
  }

  const paint = (filter = '') => {
    const shown = list(filter)
    main.innerHTML = `
      <section class="screen scroll">
        <header class="topbar"><h1>Cards</h1><span class="badge">${shown.length} of ${all.length}</span></header>
        ${activeDeck.tiers ? `<div class="chips" id="tier-chips">${tierChips(maxTier, dueByTier)}</div>` : ''}
        <div class="fab-row">
          <a class="secondary" href="#/card/new" style="display:flex;align-items:center;justify-content:center">Add card</a>
          <a class="secondary" href="#/import" style="display:flex;align-items:center;justify-content:center">CSV import</a>
        </div>
        <input class="search" id="search" type="search" placeholder="Search ${esc(targetLang)} or ${esc(baseLang)}" value="${esc(filter)}" />
        ${
          shown.length === 0
            ? `<p class="empty">No cards match.</p>`
            : `<ul class="card-list">${shown
                .map((c) => {
                  const due = c.srs.due <= now
                  return `<li>
                    <a class="card-row" href="#/card/${esc(c.id)}">
                      <div class="left">
                        <div class="de-line">
                          <div class="de ${genderClass(activeDeck.articles ? c.article : 'none')}">${esc(germanHead(activeDeck.articles ? c.article : 'none', c.de))}</div>
                          ${activeDeck.supportsWordTypes ? wordTypeBadgeHtml(c) : ''}
                        </div>
                        <div class="en">${esc(c.en)}</div>
                      </div>
                      <span class="row-badges">
                        ${activeDeck.tiers ? `<span class="badge tier t${tierOf(c)}">T${tierOf(c)}</span>` : ''}
                        <span class="badge ${due ? 'due' : ''}">${due ? 'due' : formatDue(c.srs.due, now)}</span>
                      </span>
                    </a>
                  </li>`
                })
                .join('')}</ul>`
        }
      </section>
    `
    bindTierChips((tier) => {
      maxTier = tier
      paint(search.value)
    })
    const search = $('#search') as HTMLInputElement
    search.addEventListener('input', () => paint(search.value))
    if (filter) {
      search.focus()
      search.setSelectionRange(filter.length, filter.length)
    }
  }
  paint()
}

function articleOptions(selected: Article): string {
  return ARTICLES.map(
    (a) => `<option value="${a}" ${a === selected ? 'selected' : ''}>${a}</option>`,
  ).join('')
}

function tierOptions(card: Card | undefined): string {
  const current = card ? tierOf(card) : 3
  return TIERS.map((t) => `<option value="${t}" ${t === current ? 'selected' : ''}>Tier ${t}</option>`).join('')
}

function wordTypeOptions(selected: string): string {
  const options: [string, string][] = [
    ['noun', 'Noun'],
    ['verb', 'Verb'],
    ['adj', 'Adjective'],
    ['other', 'Other'],
  ]
  return options
    .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`)
    .join('')
}

async function renderEdit(id: string | null) {
  setTabbar('deck')
  const activeDeck = (await getActiveDeck())!
  const { targetLang, baseLang } = activeDeck
  const existing = id ? await getCard(id) : undefined
  if (id && !existing) {
    toast('Card not found')
    go('/deck')
    return
  }
  const c = existing
  const typeChoice = c ? editorWordType(c.tags, c.article) : 'noun'
  const extraTypes = c ? savedWordTypes(c.tags).slice(1).map(wordTypeSpoken) : []
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar">
        <button class="ghost" id="back">Back</button>
        <h1>${c ? 'Edit card' : 'New card'}</h1>
        <span></span>
      </header>
      <form class="form" id="form">
        <label>${esc(targetLang)}
          <input name="de" type="text" required value="${esc(c?.de ?? '')}" autocomplete="off" />
        </label>
        <label>${esc(baseLang)}
          <input name="en" type="text" required value="${esc(c?.en ?? '')}" autocomplete="off" />
        </label>
        ${activeDeck.articles ? `<label>Article
          <select name="article">${articleOptions(c?.article ?? 'none')}</select>
        </label>` : ''}
        ${activeDeck.supportsWordTypes ? `<label>Word type
          <select name="wordType">${wordTypeOptions(typeChoice)}</select>
        </label>` : ''}
        ${
          activeDeck.supportsWordTypes && extraTypes.length
            ? `<p class="note">Also ${esc(extraTypes.join(' and '))}. Choosing a different type replaces the extra labels.</p>`
            : ''
        }
        <label>Example (${esc(targetLang)})
          <textarea name="example_de">${esc(c?.example_de ?? '')}</textarea>
        </label>
        <label>Example (${esc(baseLang)})
          <textarea name="example_en">${esc(c?.example_en ?? '')}</textarea>
        </label>
        <label>Tags (comma separated)
          <input name="tags" type="text" value="${esc(editorTagField(c?.tags ?? []))}" />
        </label>
        ${activeDeck.tiers ? `<label>Tier
          <select name="tier">${tierOptions(c)}</select>
        </label>
        <p class="note">${
          typeof c?.rank === 'number'
            ? `Corpus rank ${c.rank} of 50,000, so this card sits in tier ${tierOf(c)} by default. The tier box overrides that.`
            : 'A card of your own has no corpus rank, so it lives in the tier you pick here.'
        }</p>` : ''}
        <button class="primary" type="submit">Save</button>
        ${c ? `<button class="danger" type="button" id="delete">Delete</button>` : ''}
      </form>
    </section>
  `
  $('#back').addEventListener('click', () => go('/deck'))
  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target as HTMLFormElement)
    const de = String(fd.get('de') ?? '').trim()
    const en = String(fd.get('en') ?? '').trim()
    const article = activeDeck.articles ? String(fd.get('article') ?? 'none') as Article : c?.article ?? 'none'
    const example_de = String(fd.get('example_de') ?? '').trim()
    const example_en = String(fd.get('example_en') ?? '').trim()
    const tagsField = String(fd.get('tags') ?? '')
    const tags = activeDeck.supportsWordTypes
      ? tagsWithWordType(tagsField, String(fd.get('wordType') ?? 'other'), c?.tags ?? [])
      : tagsWithoutTypeEdit(tagsField, c?.tags ?? [])
    const tier = activeDeck.tiers ? Math.min(3, Math.max(1, Number(fd.get('tier')) || 3)) as Tier : c?.tier
    if (!de || !en) {
      toast(`${targetLang} and ${baseLang} are required`)
      return
    }
    const now = Date.now()
    if (c) {
      // Re-read so a foreground merge cannot lose remote SRS or resurrect a deletion.
      const fresh = await getCard(c.id)
      if (!fresh) {
        toast('Card was deleted')
        go('/deck')
        return
      }
      const card = touch({
        ...fresh,
        de,
        en,
        article,
        example_de,
        example_en,
        tags,
        tier,
      })
      await putCard(card)
      pushSoon()
      toast('Saved')
      go('/deck')
      return
    }
    const card: Card = {
      id: crypto.randomUUID(),
      de,
      en,
      article,
      example_de,
      example_en,
      tags,
      tier,
      created_at: now,
      updated_at: now,
      srs: { ...newSrs(now), updated_at: now },
    }
    await putCard(card)
    pushSoon()
    toast('Card added')
    go('/deck')
  })
  const del = document.getElementById('delete')
  del?.addEventListener('click', async () => {
    if (!c) return
    if (!confirm(`Delete ${germanHead(c.article, c.de)}?`)) return
    await deleteCard(c.id)
    pushSoon()
    toast('Deleted')
    go('/deck')
  })
}

async function renderImport() {
  setTabbar('deck')
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar">
        <button class="ghost" id="back">Back</button>
        <h1>CSV import</h1>
        <span></span>
      </header>
      <p class="note">Columns: <code>de,en,article,example_de</code>. An optional <code>type</code> column can be noun, verb, adjective, or other. Article is der, die, das, or none. A noun is assumed when the article is set and type is left blank. Duplicates of an existing de+en pair are skipped.</p>
      <div class="drop" id="drop">
        <span>Drop a .csv file here</span>
        <label class="file-btn">Choose file
          <input id="file" type="file" accept=".csv,text/csv" hidden />
        </label>
      </div>
      <label>Or paste CSV
        <textarea id="paste" placeholder="de,en,article,example_de,type"></textarea>
      </label>
      <button class="primary" id="run">Import</button>
      <div id="result"></div>
    </section>
  `
  $('#back').addEventListener('click', () => go('/deck'))
  const drop = $('#drop')
  const file = $('#file') as HTMLInputElement
  const paste = $('#paste') as HTMLTextAreaElement

  const readFile = (f: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      paste.value = String(reader.result ?? '')
    }
    reader.readAsText(f)
  }

  drop.addEventListener('dragover', (e) => {
    e.preventDefault()
    drop.classList.add('is-over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('is-over')
    const f = e.dataTransfer?.files[0]
    if (f) readFile(f)
  })
  file.addEventListener('change', () => {
    const f = file.files?.[0]
    if (f) readFile(f)
  })

  $('#run').addEventListener('click', async () => {
    const text = paste.value
    if (!text.trim()) {
      toast('Paste or choose a CSV first')
      return
    }
    const existing = await getAllCards()
    const result = importCsv(text, existing)
    if (result.imported.length) {
      await putCards(result.imported)
      pushSoon()
    }
    const bits = [`Imported ${result.imported.length}`]
    if (result.skipped) bits.push(`skipped ${result.skipped}`)
    toast(bits.join(', '))
    const resultEl = $('#result')
    resultEl.innerHTML =
      result.errors.length > 0
        ? `<ul class="error-list">${result.errors.map((err) => `<li>${esc(err)}</li>`).join('')}</ul>`
        : `<p class="note">${result.imported.length} new cards. New cards are due immediately.</p>`
  })
}

async function renderCloudSettings() {
  const lock = captureStudyLock()
  setTabbar('settings')
  if (!studyLockCurrent(lock)) return
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar"><h1>Settings</h1><span class="badge">${esc(accountBadge())}</span></header>
      ${accountPanelHtml()}
      <div class="setting">
        <p class="kicker" style="margin:0">Install</p>
        <p class="note" id="app-version" data-version="${esc(buildInfo.version)}" data-source="${esc(buildInfo.sourceCommit)}">Version ${esc(buildInfo.version)} · ${esc(buildInfo.sourceCommit.slice(0, 7))}${buildInfo.sourceDirty ? ' (local changes)' : ''}</p>
        <p class="note">PWA: Chrome/Edge install, iPhone Safari share → Add to Home Screen. The app itself must be served over HTTPS for iPhone. Progress stays in this browser when you are signed out, and with the account when you are signed in.</p>
        <p class="note" id="sw-status"></p>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">SRS</p>
        <p class="note">SM-2 with Again / Gender / Hard / Good / Easy. Gender is for nouns: you knew the word but missed der, die, or das. It requeues the card now with a smaller ease penalty than Again. Verbs and adjectives hide that button.</p>
      </div>
    </section>
  `
  bindAccountPanel(accountHooks)
  const sw = 'serviceWorker' in navigator
  $('#sw-status').textContent = sw
    ? 'Service worker APIs are available in this browser.'
    : 'Service worker is not available in this browser.'
}

async function renderSettings() {
  return renderCloudSettings()
}

let renderChain: Promise<void> = Promise.resolve()
let openingEmptyDeck = false

function scheduleRender(): void {
  renderChain = renderChain.then(() => render()).catch((error: unknown) => {
    if (error instanceof DatabaseBlockedError) return
    console.error(error)
  })
}

async function render() {
  const lock: StudyLock = captureStudyLock()
  unbindKeys?.()
  unbindKeys = null
  const route = parseRoute()
  if (route.name === 'home') await renderHome()
  else if (route.name === 'review') await renderReview()
  else if (route.name === 'deck') await renderDeck()
  else if (route.name === 'decks') await renderDecks()
  else if (route.name === 'edit') await renderEdit(route.id)
  else if (route.name === 'import') await renderImport()
  else await renderSettings()
  if (!studyLockCurrent(lock)) return
  document.getElementById('db-block')?.remove()
  quietlyRefreshStreak()
}

function clearLegacyGithubToken(): void {
  // A recovery open must leave the installation's stored keys untouched.
  if (rehearsalPreview || recoveryBridge) return
  try {
    localStorage.removeItem('german-flashcards.github')
    localStorage.removeItem('german-flashcards.github.shas')
  } catch {
    /* Storage can be blocked; the token is unused either way. */
  }
}

async function boot() {
  clearLegacyGithubToken()
  onDatabaseEvent(showDatabaseNotice)
  await prepareAccount(accountHooks)
  markAccountBooted()
  let added = 0
  // Signed-out study on the bridge is the legacy source. Seeding and the
  // one-time profile import write that database, so this open only reads it.
  // After sign-in the study lock is the account database, which sync may seed.
  const signedIn = Boolean(captureStudyLock().uid)
  if (recoveryBridge) {
    if (signedIn) await bootSync()
  } else if (accountSignIn) {
    // A deck created with this sign-in has nothing on the server yet. Paint
    // the built-in words before the cloud read, which can stall after the
    // Google sheet returns on a phone. An existing account still syncs first
    // so a server tombstone is applied before any missing seed is inserted.
    if (signedIn) {
      if (seedBeforeFirstSync(takeFreshPersonalDeck())) {
        try {
          added = await ensureSeed()
        } catch {
          openingEmptyDeck = true
        }
      } else openingEmptyDeck = true
    } else added = await ensureSeed()
  } else {
    await importLegacyData()
    added = await ensureSeed()
  }
  scheduleRender()
  await renderChain
  if (added > 0) toast(`Added ${added} new cards`)
  if (!recoveryBridge && accountSignIn && captureStudyLock().uid) {
    void bootSync().finally(() => {
      openingEmptyDeck = false
      const now = parseRoute().name
      if (now === 'home' || now === 'deck' || now === 'decks') scheduleRender()
    })
  }
  window.addEventListener('hashchange', () => {
    scheduleRender()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      pauseSync()
      return
    }
    quietlyRefreshStreak()
    if (accountSignIn && !captureStudyLock().uid) {
      const route = parseRoute().name
      if (route === 'home' || route === 'deck' || route === 'decks') scheduleRender()
      return
    }
    void syncNow()
      .then(() => {
        const now = parseRoute().name
        if (now === 'home' || now === 'deck' || now === 'decks') scheduleRender()
      })
      .catch(() => {
        /* status already set */
      })
  })
  window.addEventListener('online', () => {
    if (!accountSignIn || !captureStudyLock().uid) return
    void syncNow().catch(() => {
      /* The pending records stay until the next foreground retry. */
    })
  })
  window.addEventListener('pagehide', () => {
    pauseSync()
  })
  const paintSyncLine = () => {
    const el = document.getElementById('sync-line')
    if (el) el.textContent = syncLineText()
    quietlyRefreshStreak()
  }
  onSyncStatus(paintSyncLine)
  onAccountSync(paintSyncLine)
  // Refresh the passive date-dependent text while open; this never starts sync.
  window.setInterval(() => {
    if (document.visibilityState === 'visible') refreshStreakDay()
  }, 1000)
}

void boot()

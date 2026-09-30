import './style.css'
import { registerSW } from 'virtual:pwa-register'
import type { Article, Card, Direction, GithubConfig, Grade, PublicSettings, Tier } from './types.ts'
import { ARTICLES } from './types.ts'
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
} from './account.ts'
import type { AccountHooks } from './account-hooks.ts'
import {
  DatabaseBlockedError,
  deleteCard,
  getAllCards,
  getCard,
  getDueByTier,
  getDueCards,
  getSettings,
  importLegacyData,
  insertMissingSeeds,
  onDatabaseEvent,
  putCard,
  putCards,
  putSettings,
} from './db.ts'
import { seedCards } from './seed.ts'
import { newSrs, review } from './srs.ts'
import { importCsv } from './csv.ts'
import { $, esc, formatDue, germanHead, shuffle } from './dom.ts'
import { sessionCount, SESSION_PRESETS, suggestSessionSize } from './session.ts'
import { tierCounts, tierOf, tierLabel, TIERS, TIER_NOTES } from './tiers.ts'
import { captureStudyLock, studyLockCurrent, type StudyLock } from './study-lock.ts'
import { activeUser, createUser, listUsers, setActiveUser } from './user.ts'
import {
  bootSync,
  discoverRemoteUsers,
  getSyncStatus,
  onSyncStatus,
  pauseSync,
  schedulePush,
  syncNow,
} from './sync.ts'
import {
  defaultGithubConfig,
  isGithubConfigured,
  loadGithubConfig,
  sanitizeToken,
  saveGithubConfig,
} from './github.ts'

registerSW({ immediate: true })

type Route =
  | { name: 'home' }
  | { name: 'review' }
  | { name: 'deck' }
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
  if (accountSignIn) {
    noteLocalChange()
    return
  }
  schedulePush()
}

async function ensureSeed(): Promise<number> {
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
    ? 'A database upgrade is waiting on another tab. Close other German Flashcards tabs and reload.'
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

function touch(card: Card): Card {
  return { ...card, updated_at: Date.now() }
}

function syncLineText(): string {
  if (accountSignIn) return accountSyncText()
  const st = getSyncStatus()
  if (st.state === 'off') return 'This device only · connect GitHub in Settings'
  if (st.state === 'syncing') return st.message || 'Syncing…'
  if (st.state === 'waiting' || st.state === 'error') return st.message
  if (st.state === 'ok' && st.at) {
    const sec = Math.max(0, Math.round((Date.now() - st.at) / 1000))
    if (sec < 10) return 'Backed up just now'
    if (sec < 60) return `Backed up ${sec}s ago`
    const min = Math.round(sec / 60)
    return `Backed up ${min}m ago`
  }
  return st.message || 'GitHub connected'
}

function setTabbar(active: 'home' | 'deck' | 'settings' | 'none') {
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
function iconSettings() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4"/></svg>`
}

tabbar.innerHTML = `
  <a class="tab" data-tab="home" href="#/">${iconReview()}Review</a>
  <a class="tab" data-tab="deck" href="#/deck">${iconDeck()}Deck</a>
  <a class="tab" data-tab="settings" href="#/settings">${iconSettings()}Settings</a>
`

async function renderHome() {
  const lock = captureStudyLock()
  setTabbar('home')
  const settings = await getSettings()
  const dueByTier = await getDueByTier()
  const due = await getDueCards(settings.tier)
  const all = await getAllCards()
  if (!studyLockCurrent(lock)) return
  const suggested = suggestSessionSize(due.length)
  const n = sessionCount(due.length, settings.sessionSize)
  const inTier = all.filter((c) => tierOf(c) <= settings.tier)
  const next = inTier
    .filter((c) => c.srs.due > Date.now())
    .sort((a, b) => a.srs.due - b.srs.due)[0]
  const ready = due.length > 0
  const startLabel = ready
    ? n === due.length
      ? `Start ${n} ${n === 1 ? 'card' : 'cards'}`
      : `Start ${n} of ${due.length}`
    : 'Start review'
  const presets = SESSION_PRESETS.map((size) => {
    const on = settings.sessionSize === size
    const label = size === 0 ? 'All' : String(size)
    const extra = size === suggested ? ' · suggested' : ''
    return `<button type="button" class="chip ${on ? 'is-on' : ''}" data-session="${size}">${label}${extra}</button>`
  }).join('')
  main.innerHTML = `
    <section class="screen">
      <header class="topbar">
        <h1>German</h1>
        <span class="badge" id="sync-line">${esc(syncLineText())}</span>
      </header>
      <div class="due-hero">
        <p class="kicker">Due now · ${esc(tierLabel(settings.tier))}</p>
        <div class="due-count ${ready ? '' : 'caught-up'}" data-due-count>${due.length}</div>
        <p class="due-label">${
          ready
            ? due.length === 1
              ? 'card waiting'
              : 'cards waiting'
            : next
              ? `Caught up · next ${formatDue(next.srs.due)}`
              : 'No cards yet'
        }</p>
        <div class="session-box">
          <p class="kicker" style="margin:0">Deck tier</p>
          <div class="chips" id="tier-chips">${tierChips(settings.tier, dueByTier)}</div>
          <p class="note" style="margin:0">${esc(TIER_NOTES[settings.tier])}</p>
        </div>
        <div class="session-box">
          <p class="kicker" style="margin:0">This session</p>
          <div class="chips" id="session-chips">${presets}</div>
          <label class="inline-num">Custom
            <input id="session-custom" type="number" min="1" step="1" inputmode="numeric" value="${
              settings.sessionSize > 0 ? settings.sessionSize : ''
            }" placeholder="${suggested}" />
          </label>
        </div>
        <button class="primary" id="start" data-session-count="${n}" ${ready ? '' : 'disabled'}>${esc(startLabel)}</button>
        <p class="note" id="who">${
          accountSignIn ? accountHomeNote() : `${esc(activeUser().name)} · <a href="#/settings">switch profile</a>`
        }</p>
      </div>
    </section>
  `
  $('#start').addEventListener('click', () => {
    if (due.length) go('/review')
  })
  bindTierChips(async (tier) => {
    await patchSettings({ tier })
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
  const due = await getDueCards(settings.tier)
  if (!studyLockCurrent(lock)) return
  const queue = shuffle(due).slice(0, sessionCount(due.length, settings.sessionSize))
  if (queue.length === 0) {
    go('/')
    return
  }

  const sessionTotal = queue.length
  const leftover = () => due.length - sessionTotal
  let flipped = false

  const paint = () => {
    if (!studyLockCurrent(lock)) return
    const card = queue[0]
    if (!card) {
      main.innerHTML = `
        <section class="screen review">
          <header class="topbar">
            <button class="ghost" id="back">Close</button>
            <h1>Done</h1>
            <span></span>
          </header>
          <div class="due-hero">
            <p class="kicker">Session</p>
            <div class="due-count caught-up">0</div>
            <p class="due-label">${
              leftover() > 0
                ? `Session complete · ${leftover()} still due`
                : 'No more due cards'
            }</p>
            <button class="primary" id="home">Back home</button>
          </div>
        </section>
      `
      $('#back').addEventListener('click', () => go('/'))
      $('#home').addEventListener('click', () => go('/'))
      return
    }

    const remaining = queue.length
    const done = sessionTotal - remaining
    const pct = Math.round((done / sessionTotal) * 100)
    const deText = germanHead(card.article, card.de)
    const g = genderClass(card.article)
    const frontIsDe = settings.direction === 'de-en'
    const front = frontIsDe ? deText : card.en
    const backHead = frontIsDe ? card.en : deText
    const articleLabel =
      card.article !== 'none'
        ? card.article
        : card.tags.includes('adj')
          ? 'adj'
          : card.tags.includes('verb')
            ? 'verb'
            : 'word'

    main.innerHTML = `
      <section class="screen review">
        <header class="topbar">
          <button class="ghost" id="back">Close</button>
          <div class="review-meta"><span data-remaining>${remaining}</span> left · ${esc(tierLabel(settings.tier))}</div>
          <span></span>
        </header>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="card-stage">
          <button class="flip ${flipped ? 'is-flipped' : ''}" id="card" type="button" aria-label="Flip card">
            <div class="flip-inner">
              <div class="face front gender-${g}">
                ${frontIsDe ? `<span class="article ${g}">${esc(articleLabel)}</span>` : `<span class="prompt">English</span>`}
                <div class="word ${frontIsDe ? g : ''}">${esc(front)}</div>
                <p class="hint">${flipped ? '' : 'Tap to flip'}</p>
              </div>
              <div class="face back gender-${g}">
                ${frontIsDe ? `<span class="prompt">English</span>` : `<span class="article ${g}">${esc(articleLabel)}</span>`}
                <div class="word ${frontIsDe ? '' : g}">${esc(backHead)}</div>
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
        <div class="grades ${card.article !== 'none' ? 'noun' : ''}" ${flipped ? '' : 'hidden'}>
          <button class="grade again" data-grade="again">Again<small>1</small></button>
          ${
            card.article !== 'none'
              ? `<button class="grade gender" data-grade="wrong_gender">Gender<small>5</small></button>`
              : ''
          }
          <button class="grade hard" data-grade="hard">Hard<small>2</small></button>
          <button class="grade good" data-grade="good">Good<small>3</small></button>
          <button class="grade easy" data-grade="easy">Easy<small>4</small></button>
        </div>
      </section>
    `

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
    if (!studyLockCurrent(lock)) return
    const card = queue.shift()
    if (!card) return
    const current = await getCard(card.id)
    // Sync may have merge-deleted this card while the review screen was open.
    // Do not fall back to the stale queue object — that would resurrect it.
    if (!current) {
      flipped = false
      paint()
      return
    }
    // A review changes scheduling, not vocabulary, so only the scheduling clock
    // moves. Bumping the card's own updated_at would rewrite the shared deck
    // file on every single grade.
    const saved = { ...current, srs: { ...review(current.srs, g), updated_at: Date.now() } }
    await putCard(saved)
    if (!studyLockCurrent(lock)) return
    pushSoon()
    if (g === 'again' || g === 'wrong_gender') queue.push(saved)
    flipped = false
    paint()
  }

  const onKey = (e: KeyboardEvent) => {
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
    if (g === 'wrong_gender' && queue[0]?.article === 'none') return
    if (g) void grade(g)
  }

  unbindKeys?.()
  window.addEventListener('keydown', onKey)
  unbindKeys = () => window.removeEventListener('keydown', onKey)
  paint()
}

async function renderDeck() {
  setTabbar('deck')
  const all = await getAllCards()
  const settings = await getSettings()
  const dueByTier = await getDueByTier()
  const now = Date.now()
  // The deck list is a browser, not a review queue, so it starts on the chosen
  // tier and can be widened with the filter.
  let maxTier: Tier = settings.tier
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
        <header class="topbar"><h1>Deck</h1><span class="badge">${shown.length} of ${all.length}</span></header>
        <div class="chips" id="tier-chips">${tierChips(maxTier, dueByTier)}</div>
        <div class="fab-row">
          <a class="secondary" href="#/card/new" style="display:flex;align-items:center;justify-content:center">Add card</a>
          <a class="secondary" href="#/import" style="display:flex;align-items:center;justify-content:center">CSV import</a>
        </div>
        <input class="search" id="search" type="search" placeholder="Search German or English" value="${esc(filter)}" />
        ${
          shown.length === 0
            ? `<p class="empty">No cards match.</p>`
            : `<ul class="card-list">${shown
                .map((c) => {
                  const due = c.srs.due <= now
                  return `<li>
                    <a class="card-row" href="#/card/${esc(c.id)}">
                      <div class="left">
                        <div class="de ${genderClass(c.article)}">${esc(germanHead(c.article, c.de))}</div>
                        <div class="en">${esc(c.en)}</div>
                      </div>
                      <span class="row-badges">
                        <span class="badge tier t${tierOf(c)}">T${tierOf(c)}</span>
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

async function renderEdit(id: string | null) {
  setTabbar('deck')
  const existing = id ? await getCard(id) : undefined
  if (id && !existing) {
    toast('Card not found')
    go('/deck')
    return
  }
  const c = existing
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar">
        <button class="ghost" id="back">Back</button>
        <h1>${c ? 'Edit card' : 'New card'}</h1>
        <span></span>
      </header>
      <form class="form" id="form">
        <label>German
          <input name="de" type="text" required value="${esc(c?.de ?? '')}" autocomplete="off" />
        </label>
        <label>English
          <input name="en" type="text" required value="${esc(c?.en ?? '')}" autocomplete="off" />
        </label>
        <label>Article
          <select name="article">${articleOptions(c?.article ?? 'der')}</select>
        </label>
        <label>Example (DE)
          <textarea name="example_de">${esc(c?.example_de ?? '')}</textarea>
        </label>
        <label>Example (EN)
          <textarea name="example_en">${esc(c?.example_en ?? '')}</textarea>
        </label>
        <label>Tags (comma separated)
          <input name="tags" type="text" value="${esc((c?.tags ?? []).join(', '))}" />
        </label>
        <label>Tier
          <select name="tier">${tierOptions(c)}</select>
        </label>
        <p class="note">${
          typeof c?.rank === 'number'
            ? `Corpus rank ${c.rank} of 50,000, so this card sits in tier ${tierOf(c)} by default. The tier box overrides that.`
            : 'A card of your own has no corpus rank, so it lives in the tier you pick here.'
        }</p>
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
    const article = String(fd.get('article') ?? 'none') as Article
    const example_de = String(fd.get('example_de') ?? '').trim()
    const example_en = String(fd.get('example_en') ?? '').trim()
    const tags = String(fd.get('tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const tier = Math.min(3, Math.max(1, Number(fd.get('tier')) || 3)) as Tier
    if (!de || !en) {
      toast('German and English are required')
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
      <p class="note">Columns: <code>de,en,article,example_de</code>. Article is der, die, das, or none. Duplicates of an existing de+en pair are skipped.</p>
      <div class="drop" id="drop">
        <span>Drop a .csv file here</span>
        <label class="file-btn">Choose file
          <input id="file" type="file" accept=".csv,text/csv" hidden />
        </label>
      </div>
      <label>Or paste CSV
        <textarea id="paste" placeholder="de,en,article,example_de"></textarea>
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
  const settings = await getSettings()
  const dueByTier = await getDueByTier()
  const cards = await getAllCards()
  if (!studyLockCurrent(lock)) return
  const counts = tierCounts(cards)
  const suggested = suggestSessionSize((await getDueCards(settings.tier)).length)
  if (!studyLockCurrent(lock)) return
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar"><h1>Settings</h1><span class="badge">${esc(accountBadge())}</span></header>
      ${accountPanelHtml()}
      <div class="setting">
        <p class="kicker" style="margin:0">Deck tier</p>
        <div class="chips" id="tier-chips">${tierChips(settings.tier, dueByTier)}</div>
        <p class="note">${esc(TIER_NOTES[settings.tier])} Higher tiers include the lower ones, so tier 2 reviews everything in tier 1 too. ${counts[1]} / ${counts[1] + counts[2]} / ${cards.length} words.</p>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">Review direction</p>
        <div class="seg" id="dir">
          <button type="button" data-dir="de-en" class="${settings.direction === 'de-en' ? 'is-on' : ''}">DE → EN</button>
          <button type="button" data-dir="en-de" class="${settings.direction === 'en-de' ? 'is-on' : ''}">EN → DE</button>
        </div>
        <p class="note">DE → EN shows the German word first. EN → DE shows English first.</p>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">Session size</p>
        <p class="note">Cap how many due cards a review starts with. Suggested now: ${suggested}. 0 / All means the whole due queue.</p>
        <label>Cards per session
          <input id="session-size" type="number" min="0" step="1" inputmode="numeric" value="${settings.sessionSize}" />
        </label>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">Install</p>
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
  bindTierChips(async (tier) => {
    await patchSettings({ tier })
    scheduleRender()
  })
  $('#dir').querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const direction = btn.dataset.dir as Direction
      await patchSettings({ direction })
      toast(direction === 'de-en' ? 'DE → EN' : 'EN → DE')
      scheduleRender()
    })
  })
  $('#session-size').addEventListener('change', async () => {
    const v = Math.floor(Number(($('#session-size') as HTMLInputElement).value))
    if (!Number.isFinite(v) || v < 0) return
    await patchSettings({ sessionSize: v })
    toast(v === 0 ? 'Session: all due' : `Session: ${v}`)
  })
  const sw = 'serviceWorker' in navigator
  $('#sw-status').textContent = sw
    ? 'Service worker APIs are available in this browser.'
    : 'Service worker is not available in this browser.'
}

async function renderSettings() {
  if (accountSignIn) return renderCloudSettings()
  return renderGithubSettings()
}

async function renderGithubSettings() {
  setTabbar('settings')
  const settings = await getSettings()
  const gh = loadGithubConfig()
  const connected = isGithubConfigured(gh)
  const dueByTier = await getDueByTier()
  const cards = await getAllCards()
  const counts = tierCounts(cards)
  const suggested = suggestSessionSize((await getDueCards(settings.tier)).length)
  const user = activeUser()
  const users = listUsers()
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar"><h1>Settings</h1><span class="badge">${esc(user.name)}</span></header>
      <div class="setting">
        <p class="kicker" style="margin:0">Profile</p>
        <p class="note">Each profile keeps its own review schedule, session settings and tier on this device, in <code>users/${esc(user.slug)}.json</code> in the repo. The word list is shared by everyone.</p>
        <div class="user-list" id="user-list">
          ${users
            .map(
              (u) => `<button type="button" class="user-row${u.slug === user.slug ? ' is-on' : ''}" data-user="${esc(u.slug)}">
                <span class="name">${esc(u.name)}</span>
                <span class="badge">${u.slug === user.slug ? 'current' : 'switch'}</span>
              </button>`,
            )
            .join('')}
        </div>
        <form class="form" id="user-form" style="padding:0" autocomplete="off">
          <label>Add a profile
            <input name="name" type="text" placeholder="Name" autocomplete="off" enterkeyhint="done" />
          </label>
          <button class="secondary" type="submit">Add and switch</button>
        </form>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">Deck tier</p>
        <div class="chips" id="tier-chips">${tierChips(settings.tier, dueByTier)}</div>
        <p class="note">${esc(TIER_NOTES[settings.tier])} Higher tiers include the lower ones, so tier 2 reviews everything in tier 1 too. ${counts[1]} / ${counts[1] + counts[2]} / ${cards.length} words.</p>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">Review direction</p>
        <div class="seg" id="dir">
          <button type="button" data-dir="de-en" class="${settings.direction === 'de-en' ? 'is-on' : ''}">DE → EN</button>
          <button type="button" data-dir="en-de" class="${settings.direction === 'en-de' ? 'is-on' : ''}">EN → DE</button>
        </div>
        <p class="note">DE → EN shows the German word first. EN → DE shows English first.</p>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">Session size</p>
        <p class="note">Cap how many due cards a review starts with. Suggested now: ${suggested}. 0 / All means the whole due queue.</p>
        <label>Cards per session
          <input id="session-size" type="number" min="0" step="1" inputmode="numeric" value="${settings.sessionSize}" />
        </label>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">GitHub sync</p>
        <p class="note">Backup: the repo holds the shared word list in <code>${esc(gh.path)}</code> and one file per profile in <code>users/</code>, so every browser (including iPhone Safari) shares progress without two profiles overwriting each other. Paste a <strong>personal access token</strong> (<code>github_pat_</code> or <code>ghp_</code>), not your GitHub password. Fine-grained PAT: Contents read/write on <code>german-flashcards-data</code> only. Token stays in this browser.</p>
        <form class="form" id="gh-form" style="padding:0" autocomplete="off">
          <label>Owner
            <input name="owner" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(gh.owner)}" />
          </label>
          <label>Repo
            <input name="repo" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(gh.repo)}" />
          </label>
          <label>Path
            <input name="path" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(gh.path)}" />
          </label>
          <label>Branch
            <input name="branch" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(gh.branch)}" />
          </label>
          <label>Token
            <input name="github_pat" id="github_pat" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="done" placeholder="${
              gh.token ? 'saved — paste a new token to replace' : 'github_pat_… or ghp_…'
            }" />
          </label>
          <button class="primary" type="submit" id="gh-connect">${connected ? 'Save and sync' : 'Connect and sync'}</button>
          ${connected ? `<button class="secondary" type="button" id="sync-now">Sync now</button>
          <button class="danger" type="button" id="gh-disconnect">Disconnect this browser</button>` : ''}
        </form>
        <p class="note" id="sync-line">${esc(syncLineText())}</p>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">Install</p>
        <p class="note">PWA: Chrome/Edge install, iPhone Safari share → Add to Home Screen. The app itself must be served over HTTPS for iPhone. Progress follows GitHub once connected, with IndexedDB as the offline cache.</p>
        <p class="note" id="sw-status"></p>
      </div>
      <div class="setting">
        <p class="kicker" style="margin:0">SRS</p>
        <p class="note">SM-2 with Again / Gender / Hard / Good / Easy. Gender is for nouns: you knew the word but missed der, die, or das. It requeues the card now with a smaller ease penalty than Again. Verbs and adjectives hide that button.</p>
      </div>
    </section>
  `
  bindTierChips(async (tier) => {
    await patchSettings({ tier })
    await renderSettings()
  })
  $('#user-list').querySelectorAll<HTMLButtonElement>('[data-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.dataset.user
      if (!slug || slug === user.slug) return
      setActiveUser(slug)
      toast(`Switched to ${slug}`)
      // Pull this profile's schedule, then populate any built-in cards that are
      // missing locally. The latter also gives a new profile a deck while offline.
      try {
        await syncNow()
      } catch {
        /* status already set */
      }
      await ensureSeed()
      await renderSettings()
    })
  })
  const userForm = $('#user-form') as HTMLFormElement
  userForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = String(new FormData(userForm).get('name') ?? '').trim()
    if (!name) {
      toast('Type a name first')
      return
    }
    try {
      const created = createUser(name)
      toast(created.slug === user.slug ? `Already on ${created.name}` : `Now on ${created.name}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add that profile')
      return
    }
    void (async () => {
      try {
        await syncNow()
      } catch {
        /* status already set */
      }
      await ensureSeed()
      await renderSettings()
    })()
  })
  $('#dir').querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const direction = btn.dataset.dir as Direction
      await patchSettings({ direction })
      await renderSettings()
      toast(direction === 'de-en' ? 'DE → EN' : 'EN → DE')
    })
  })
  $('#session-size').addEventListener('change', async () => {
    const v = Math.floor(Number(($('#session-size') as HTMLInputElement).value))
    if (!Number.isFinite(v) || v < 0) return
    await patchSettings({ sessionSize: v })
    toast(v === 0 ? 'Session: all due' : `Session: ${v}`)
  })
  const ghForm = $('#gh-form') as HTMLFormElement
  const inputVal = (name: string) => {
    const el = ghForm.elements.namedItem(name)
    return el instanceof HTMLInputElement ? el.value : ''
  }
  const connectGithub = async () => {
    ;(document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur()
    await new Promise((r) => window.setTimeout(r, 50))
    const typed = sanitizeToken(inputVal('github_pat'))
    const cfg: GithubConfig = {
      token: typed || loadGithubConfig().token,
      owner: inputVal('owner').trim(),
      repo: inputVal('repo').trim(),
      path: inputVal('path').trim() || 'data.json',
      branch: inputVal('branch').trim() || 'main',
    }
    saveGithubConfig(cfg)
    const missing: string[] = []
    if (!cfg.owner) missing.push('owner')
    if (!cfg.repo) missing.push('repo')
    if (!cfg.token) missing.push('token')
    if (missing.length) {
      toast(`Missing: ${missing.join(', ')}. Paste the token, then tap Connect.`)
      return
    }
    if (!/^(ghp_|github_pat_)/.test(cfg.token)) {
      toast('Token should start with github_pat_ or ghp_ — not your GitHub password')
      return
    }
    try {
      await syncNow()
      toast('GitHub synced')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Sync failed')
    }
    await renderSettings()
  }
  ghForm.addEventListener('submit', (e) => {
    e.preventDefault()
    void connectGithub()
  })
  $('#github_pat').addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.getData('text') ?? ''
    if (pasted) {
      e.preventDefault()
      ;($('#github_pat') as HTMLInputElement).value = sanitizeToken(pasted)
    }
  })
  document.getElementById('sync-now')?.addEventListener('click', async () => {
    try {
      await discoverRemoteUsers()
      await syncNow()
      toast('GitHub synced')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Sync failed')
    }
    await renderSettings()
  })
  document.getElementById('gh-disconnect')?.addEventListener('click', () => {
    saveGithubConfig(defaultGithubConfig())
    toast('Disconnected')
    void renderSettings()
  })
  const sw = 'serviceWorker' in navigator
  $('#sw-status').textContent = sw
    ? 'Service worker APIs are available in this browser.'
    : 'Service worker is not available in this browser.'
}

let renderChain: Promise<void> = Promise.resolve()

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
  else if (route.name === 'edit') await renderEdit(route.id)
  else if (route.name === 'import') await renderImport()
  else await renderSettings()
  if (!studyLockCurrent(lock)) return
  document.getElementById('db-block')?.remove()
}

async function boot() {
  onDatabaseEvent(showDatabaseNotice)
  await prepareAccount(accountHooks)
  markAccountBooted()
  let imported = 0
  let added = 0
  if (accountSignIn) {
    added = await ensureSeed()
  } else if (isGithubConfigured()) {
    // The pre-multi-user database holds the only copy of this profile's schedule,
    // so it moves into the active user's own database before anything reads it.
    imported = await importLegacyData()
    await bootSync()
    added = await ensureSeed()
  } else {
    imported = await importLegacyData()
    added = await ensureSeed()
  }
  scheduleRender()
  await renderChain
  if (!accountSignIn && imported > 0) toast(`Moved ${imported} cards into ${activeUser().name}'s profile`)
  else if (added > 0) toast(`Added ${added} new cards`)
  window.addEventListener('hashchange', () => {
    scheduleRender()
  })
  document.addEventListener('visibilitychange', () => {
    if (accountSignIn) {
      if (document.visibilityState === 'visible') scheduleRender()
      return
    }
    if (document.visibilityState !== 'visible') {
      pauseSync()
      return
    }
    void syncNow()
      .then(() => {
        const now = parseRoute().name
        if (now === 'home' || now === 'deck') scheduleRender()
      })
      .catch(() => {
        /* status already set */
      })
  })
  window.addEventListener('pagehide', () => {
    if (!accountSignIn) pauseSync()
  })
  const paintSyncLine = () => {
    const el = document.getElementById('sync-line')
    if (el) el.textContent = syncLineText()
  }
  onSyncStatus(paintSyncLine)
  onAccountSync(paintSyncLine)
}

void boot()

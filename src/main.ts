import './style.css'
import { registerSW } from 'virtual:pwa-register'
import type { Article, Card, Direction, GithubConfig, Grade, Settings } from './types.ts'
import { ARTICLES } from './types.ts'
import {
  deleteCard,
  getAllCards,
  getCard,
  getDueCards,
  getSettings,
  putCard,
  putCards,
  putSettings,
} from './db.ts'
import { seedCards } from './seed.ts'
import { newSrs, review } from './srs.ts'
import { importCsv } from './csv.ts'
import { $, esc, formatDue, germanHead, shuffle } from './dom.ts'
import { sessionCount, SESSION_PRESETS, suggestSessionSize } from './session.ts'
import {
  bootSync,
  flushPush,
  getSyncStatus,
  onSyncStatus,
  pullFromGithub,
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

async function ensureSeed(): Promise<number> {
  const existing = await getAllCards()
  const byId = new Set(existing.map((c) => c.id))
  const byKey = new Set(
    existing.map((c) => `${c.de.trim().toLowerCase()}|${c.en.trim().toLowerCase()}`),
  )
  const missing = seedCards().filter((c) => {
    const key = `${c.de.trim().toLowerCase()}|${c.en.trim().toLowerCase()}`
    return !byId.has(c.id) && !byKey.has(key)
  })
  if (missing.length) {
    await putCards(missing)
    schedulePush()
  }
  return missing.length
}

async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await putSettings(next)
  schedulePush()
  return next
}

function touch(card: Card): Card {
  return { ...card, updated_at: Date.now() }
}

function syncLineText(): string {
  const st = getSyncStatus()
  if (st.state === 'off') return 'This device only · connect GitHub in Settings'
  if (st.state === 'syncing') return st.message || 'Syncing…'
  if (st.state === 'error') return `Sync error: ${st.message}`
  if (st.state === 'ok' && st.at) {
    const sec = Math.max(0, Math.round((Date.now() - st.at) / 1000))
    if (sec < 10) return 'Synced just now'
    if (sec < 60) return `Synced ${sec}s ago`
    const min = Math.round(sec / 60)
    return `Synced ${min}m ago`
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
  setTabbar('home')
  const due = await getDueCards()
  const all = await getAllCards()
  const settings = await getSettings()
  const suggested = suggestSessionSize(due.length)
  const n = sessionCount(due.length, settings.sessionSize)
  const next = all
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
        <p class="kicker">Due now</p>
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
          <p class="kicker" style="margin:0">This session</p>
          <div class="chips" id="session-chips">${presets}</div>
          <label class="inline-num">Custom
            <input id="session-custom" type="number" min="1" step="1" inputmode="numeric" value="${
              settings.sessionSize > 0 ? settings.sessionSize : ''
            }" placeholder="${suggested}" />
          </label>
        </div>
        <button class="primary" id="start" data-session-count="${n}" ${ready ? '' : 'disabled'}>${esc(startLabel)}</button>
      </div>
    </section>
  `
  $('#start').addEventListener('click', () => {
    if (due.length) go('/review')
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
  setTabbar('none')
  const settings = await getSettings()
  const due = await getDueCards()
  const queue = shuffle(due).slice(0, sessionCount(due.length, settings.sessionSize))
  if (queue.length === 0) {
    go('/')
    return
  }

  const sessionTotal = queue.length
  const leftover = () => due.length - sessionTotal
  let flipped = false

  const paint = () => {
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
          <div class="review-meta"><span data-remaining>${remaining}</span> left</div>
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
    const card = queue.shift()
    if (!card) return
    card.srs = review(card.srs, g)
    const saved = touch(card)
    await putCard(saved)
    schedulePush()
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
  const cards = (await getAllCards()).sort((a, b) => a.de.localeCompare(b.de, 'de'))
  const now = Date.now()
  const list = (filter: string) => {
    const q = filter.trim().toLowerCase()
    return cards.filter((c) => {
      if (!q) return true
      return (
        c.de.toLowerCase().includes(q) ||
        c.en.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)) ||
        c.article.includes(q)
      )
    })
  }

  const paint = (filter = '') => {
    const shown = list(filter)
    main.innerHTML = `
      <section class="screen scroll">
        <header class="topbar"><h1>Deck</h1><span class="badge">${cards.length}</span></header>
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
                      <span class="badge ${due ? 'due' : ''}">${due ? 'due' : formatDue(c.srs.due, now)}</span>
                    </a>
                  </li>`
                })
                .join('')}</ul>`
        }
      </section>
    `
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
    if (!de || !en) {
      toast('German and English are required')
      return
    }
    const now = Date.now()
    const card: Card = c
      ? touch({ ...c, de, en, article, example_de, example_en, tags })
      : {
          id: crypto.randomUUID(),
          de,
          en,
          article,
          example_de,
          example_en,
          tags,
          created_at: now,
          updated_at: now,
          srs: newSrs(now),
        }
    await putCard(card)
    schedulePush()
    toast(c ? 'Saved' : 'Card added')
    go('/deck')
  })
  const del = document.getElementById('delete')
  del?.addEventListener('click', async () => {
    if (!c) return
    if (!confirm(`Delete ${germanHead(c.article, c.de)}?`)) return
    const settings = await getSettings()
    await deleteCard(c.id)
    await patchSettings({ deletedIds: { ...settings.deletedIds, [c.id]: Date.now() } })
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
      schedulePush()
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

async function renderSettings() {
  setTabbar('settings')
  const settings = await getSettings()
  const gh = loadGithubConfig()
  const connected = isGithubConfigured(gh)
  const suggested = suggestSessionSize((await getDueCards()).length)
  main.innerHTML = `
    <section class="screen scroll">
      <header class="topbar"><h1>Settings</h1></header>
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
        <p class="note">Single-user backup: a private repo file holds the deck and SRS so every browser (including iPhone Safari) shares progress. Paste a <strong>personal access token</strong> (<code>github_pat_</code> or <code>ghp_</code>), not your GitHub password. Fine-grained PAT: Contents read/write on <code>german-flashcards-data</code> only. Token stays in this browser.</p>
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

async function render() {
  unbindKeys?.()
  unbindKeys = null
  const route = parseRoute()
  if (route.name === 'home') return renderHome()
  if (route.name === 'review') return renderReview()
  if (route.name === 'deck') return renderDeck()
  if (route.name === 'edit') return renderEdit(route.id)
  if (route.name === 'import') return renderImport()
  if (route.name === 'settings') return renderSettings()
}

async function boot() {
  let added = 0
  if (isGithubConfigured()) {
    await bootSync()
    added = await ensureSeed()
    const st = getSyncStatus()
    if (st.message === 'No remote file yet') {
      try {
        await syncNow()
      } catch {
        /* status already set */
      }
    }
  } else {
    added = await ensureSeed()
  }
  await render()
  if (added > 0) toast(`Added ${added} new cards`)
  window.addEventListener('hashchange', () => {
    void render()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushPush()
      return
    }
    const name = parseRoute().name
    if (name === 'review' || name === 'settings' || name === 'edit' || name === 'import') return
    void pullFromGithub()
      .then(() => {
        const now = parseRoute().name
        if (now === 'home' || now === 'deck') void render()
      })
      .catch(() => {
        /* status already set */
      })
  })
  window.addEventListener('pagehide', () => {
    void flushPush()
  })
  onSyncStatus(() => {
    const el = document.getElementById('sync-line')
    if (el) el.textContent = syncLineText()
  })
}

void boot()

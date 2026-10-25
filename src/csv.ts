import type { Article, Card } from './types.ts'
import { ARTICLES } from './types.ts'
import { newSrs } from './srs.ts'
import { cardContentProblem } from './limits.ts'
import { parseWordTypeToken } from './word-types.ts'

export type CsvResult = {
  imported: Card[]
  skipped: number
  errors: string[]
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let inQuotes = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    if (row.length === 1 && row[0] === '' && !inQuotes) {
      row = []
      return
    }
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      pushField()
      i++
      continue
    }
    if (c === '\n') {
      pushField()
      pushRow()
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    field += c
    i++
  }
  if (field.length > 0 || row.length > 0) {
    pushField()
    pushRow()
  }
  return rows
}

function parseArticle(raw: string): Article | null {
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'none' || v === '-' || v === 'n/a') return 'none'
  if ((ARTICLES as string[]).includes(v)) return v as Article
  return null
}

function cardKey(de: string, en: string): string {
  return `${de.trim().toLowerCase()}|${en.trim().toLowerCase()}`
}

type Columns = {
  de: number
  en: number
  article: number
  example_de: number
  example_en: number
  type: number | null
  named: boolean
}

function columnsFor(header: string[] | null): Columns {
  const index = (name: string) => header?.indexOf(name) ?? -1
  const pick = (names: string[], fallback: number) => {
    const found = names.map(index).find(i => i >= 0)
    return found ?? fallback
  }
  const optional = (names: string[], position: number) => pick(names, header ? -1 : position)
  const type = index('type')
  return {
    de: pick(['de', 'front'], 0),
    en: pick(['en', 'back'], 1),
    article: optional(['article'], 2),
    example_de: optional(['example_de', 'example_front'], 3),
    example_en: optional(['example_en', 'example_back'], -1),
    type: type >= 0 ? type : null,
    named: header !== null,
  }
}

/** A blank type guesses noun from the article. `other` stays untyped. */
function tagsForImport(article: Article, typeCell: string | null): { tags: string[]; error?: string } {
  if (typeCell === null || typeCell.trim() === '') {
    return { tags: article === 'none' ? ['imported'] : ['noun', 'imported'] }
  }
  const parsed = parseWordTypeToken(typeCell)
  if (!parsed) return { tags: [], error: 'type must be noun, verb, adjective, or other' }
  if (parsed === 'other') return { tags: ['other', 'imported'] }
  return { tags: [parsed, 'imported'] }
}

/** When provided, deckId scopes duplicates and stamps newly parsed cards. */
export function importCsv(text: string, existing: Card[], now = Date.now(), deckId?: string): CsvResult {
  const rows = parseCsv(text)
  const errors: string[] = []
  const imported: Card[] = []
  let skipped = 0
  if (rows.length === 0) {
    return { imported, skipped, errors: ['CSV is empty'] }
  }

  const seen = new Set(existing.filter(c => deckId === undefined || c.deckId === deckId).map((c) => cardKey(c.de, c.en)))
  let start = 0
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const hasHeader = header.includes('de') || (header.includes('front') && header.includes('back')) || header.includes('article')
  if (hasHeader) start = 1
  const map = columnsFor(hasHeader ? header : null)

  for (let r = start; r < rows.length; r++) {
    const cols = rows[r]
    const line = r + 1
    const de = (cols[map.de] ?? '').trim()
    const en = (cols[map.en] ?? '').trim()
    const articleRaw = cols[map.article] ?? ''
    const example_de = (cols[map.example_de] ?? '').trim()
    if (!de && !en) {
      skipped++
      continue
    }
    if (!de || !en) {
      errors.push(`Line ${line}: need both de and en`)
      continue
    }
    const article = parseArticle(articleRaw)
    if (article === null) {
      errors.push(`Line ${line}: article must be a supported article token or none`)
      continue
    }
    let typeCell: string | null = null
    if (map.type !== null) {
      typeCell = cols[map.type] ?? ''
    } else if (!map.named && cols.length > 4) {
      const extra = (cols[4] ?? '').trim()
      if (extra && parseWordTypeToken(extra)) typeCell = extra
    }
    const tagged = tagsForImport(article, typeCell)
    if (tagged.error) {
      errors.push(`Line ${line}: ${tagged.error}`)
      continue
    }
    const example_en = (cols[map.example_en] ?? '').trim()
    const tooLong = cardContentProblem({ de, en, example_de, example_en, tags: tagged.tags })
    if (tooLong) {
      errors.push(`Line ${line}: ${tooLong}`)
      continue
    }
    const key = cardKey(de, en)
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    imported.push({
      ...(deckId === undefined ? {} : { deckId }),
      id: crypto.randomUUID(),
      de,
      en,
      article,
      example_de,
      example_en,
      tags: tagged.tags,
      created_at: now,
      updated_at: now,
      srs: { ...newSrs(now), updated_at: now },
    })
  }

  return { imported, skipped, errors }
}

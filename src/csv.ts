import type { Article, Card } from './types.ts'
import { ARTICLES } from './types.ts'
import { newSrs } from './srs.ts'

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

export function importCsv(text: string, existing: Card[], now = Date.now()): CsvResult {
  const rows = parseCsv(text)
  const errors: string[] = []
  const imported: Card[] = []
  let skipped = 0
  if (rows.length === 0) {
    return { imported, skipped, errors: ['CSV is empty'] }
  }

  const seen = new Set(existing.map((c) => cardKey(c.de, c.en)))
  let start = 0
  const header = rows[0].map((h) => h.trim().toLowerCase())
  if (header[0] === 'de' || header.includes('article')) start = 1

  for (let r = start; r < rows.length; r++) {
    const cols = rows[r]
    const line = r + 1
    const de = (cols[0] ?? '').trim()
    const en = (cols[1] ?? '').trim()
    const articleRaw = cols[2] ?? ''
    const example_de = (cols[3] ?? '').trim()
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
      errors.push(`Line ${line}: article must be der, die, das, or none`)
      continue
    }
    const key = cardKey(de, en)
    if (seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    imported.push({
      id: crypto.randomUUID(),
      de,
      en,
      article,
      example_de,
      example_en: '',
      tags: ['imported'],
      created_at: now,
      updated_at: now,
      srs: newSrs(now),
    })
  }

  return { imported, skipped, errors }
}

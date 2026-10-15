export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel)
  if (!el) throw new Error(`Missing element: ${sel}`)
  return el as HTMLElement
}

export function shuffle<T>(items: T[]): T[] {
  const a = items.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function formatDue(ts: number, now = Date.now()): string {
  const diff = ts - now
  if (diff <= 0) return 'due'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `in ${hours}h`
  const days = Math.round(hours / 24)
  return `in ${days}d`
}

export function germanHead(article: string, de: string): string {
  if (article === 'none' || !article) return de
  return `${article} ${de}`
}

// CSV seguro: neutraliza fórmulas (CSV injection) e usa ; para Excel pt-BR.
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[;"\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCSV(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const head = columns.map((c) => csvCell(c.label)).join(';')
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(';'))
  return '﻿' + [head, ...body].join('\r\n')
}

export function downloadText(name: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

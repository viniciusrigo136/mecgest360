// Formatação brasileira: reais em centavos inteiros, datas no fuso da oficina.

const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export function brl(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined || cents === '') return '—'
  return brlFmt.format(Number(cents) / 100)
}

/** "1.234,56" | "1234.56" | "R$ 10" → centavos inteiros (sem ponto flutuante acumulado). */
export function parseBRL(input: string): number | null {
  const s = input.replace(/[R$\s]/g, '').trim()
  if (!s) return null
  let normalized = s
  if (s.includes(',')) normalized = s.replace(/\./g, '').replace(',', '.')
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null
  const [int, dec = ''] = normalized.replace('-', '').split('.')
  const cents = Number(int) * 100 + Number(dec.padEnd(2, '0'))
  return normalized.startsWith('-') ? -cents : cents
}

export function centsToInput(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined) return ''
  return (Number(cents) / 100).toFixed(2).replace('.', ',')
}

export function fmtDate(v: string | Date | null | undefined, tz = 'America/Sao_Paulo'): string {
  if (!v) return '—'
  // datas sem hora (YYYY-MM-DD) são datas locais: não converter fuso
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-')
    return `${d}/${m}/${y}`
  }
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(v))
}

export function fmtDateTime(v: string | Date | null | undefined, tz = 'America/Sao_Paulo'): string {
  if (!v) return '—'
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(v))
}

export function fmtTime(v: string | Date, tz = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(v))
}

/** Data local (YYYY-MM-DD) "hoje" no fuso informado. */
export function todayLocal(tz = 'America/Sao_Paulo', offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/** Converte data local + hora local do fuso da oficina em instante ISO (UTC). */
export function localToISO(date: string, time: string, tz = 'America/Sao_Paulo'): string {
  const guess = new Date(`${date}T${time}:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asTz = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return new Date(guess.getTime() - (asTz - guess.getTime())).toISOString()
}

export function normPlate(p: string): string {
  return p.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function isValidPlate(p: string): boolean {
  return /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(normPlate(p))
}

export function fmtPlate(p: string | null | undefined): string {
  if (!p) return ''
  const n = normPlate(p)
  return /^[A-Z]{3}\d{4}$/.test(n) ? `${n.slice(0, 3)}-${n.slice(3)}` : n
}

/** Telefone brasileiro para formato internacional sem '+', igual ao banco. */
export function normPhone(p: string | null | undefined): string | null {
  let d = (p ?? '').replace(/\D/g, '')
  if (!d) return null
  if (d.startsWith('00')) d = d.slice(2)
  if (d.length === 10 || d.length === 11) d = '55' + d
  return d.length >= 12 && d.length <= 15 ? d : null
}

export function fmtPhone(p: string | null | undefined): string {
  const d = (p ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '')
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return p ?? ''
}

export function fmtQty(q: number | string, decimals = 3): string {
  return Number(q).toLocaleString('pt-BR', { maximumFractionDigits: decimals })
}

export function fmtKm(km: number | null | undefined): string {
  return km === null || km === undefined ? '—' : `${Number(km).toLocaleString('pt-BR')} km`
}

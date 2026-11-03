// Modo manual: abre o WhatsApp com texto preenchido. Não há confirmação de
// envio/entrega — o sistema registra apenas "conversa aberta".
import { normPhone } from './format'

export function waLink(phone: string | null | undefined, text: string): string | null {
  const n = normPhone(phone)
  if (!n) return null
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`
}

export function renderTemplate(body: string, vars: Record<string, string | number | null | undefined>): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = body.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    const v = vars[k]
    if (v === undefined || v === null || v === '') { missing.push(k); return `{${k}}` }
    return String(v)
  })
  return { text, missing }
}

export function maskPlate(p: string | null | undefined): string {
  if (!p) return ''
  const n = p.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return n.length >= 5 ? `${n.slice(0, 3)}-**${n.slice(-2)}` : n
}

export function portalUrl(token: string): string {
  // token no fragmento (#): não vai para logs de servidor nem cabeçalho Referer
  return `${window.location.origin}/portal#t=${token}`
}

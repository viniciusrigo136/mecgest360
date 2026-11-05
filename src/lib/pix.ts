// Pix "copia e cola" estático (BR Code / EMV) — padrão do Banco Central.
// O pagamento NÃO é confirmado automaticamente: a oficina registra ao receber.

function field(id: string, value: string) {
  return id + String(value.length).padStart(2, '0') + value
}

function clean(s: string, max: number) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-@]/g, '').trim().toUpperCase().slice(0, max)
}

/** CRC16/CCITT-FALSE (polinômio 0x1021, inicial 0xFFFF), exigido pelo BR Code. */
export function crc16(payload: string): string {
  let crc = 0xffff
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

/** Normaliza a chave: telefone vira +55..., CPF/CNPJ só dígitos; e-mail e aleatória como estão. */
export function normalizePixKey(key: string): string {
  const k = key.trim()
  if (k.includes('@') || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k)) return k
  const d = k.replace(/\D/g, '')
  if (k.startsWith('+')) return '+' + d
  if (d.length === 11 && /^\(?\d{2}\)?\s?9/.test(k)) return '+55' + d   // celular com DDD
  return d.length === 11 || d.length === 14 ? d : k
}

export function pixPayload({ key, name, city, amountCents, txid = '***' }: { key: string; name: string; city: string; amountCents?: number | null; txid?: string }) {
  const account = field('00', 'br.gov.bcb.pix') + field('01', normalizePixKey(key))
  let p = field('00', '01') + field('26', account) + field('52', '0000') + field('53', '986')
  if (amountCents && amountCents > 0) p += field('54', (amountCents / 100).toFixed(2))
  p += field('58', 'BR') + field('59', clean(name, 25) || 'OFICINA') + field('60', clean(city, 15) || 'BRASIL')
  p += field('62', field('05', clean(txid, 25) || '***'))
  p += '6304'
  return p + crc16(p)
}

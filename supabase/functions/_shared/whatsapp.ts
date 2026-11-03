// Adaptador da API oficial do WhatsApp Business (Cloud API da Meta).
// Sem credenciais, isConfigured() = false e nada é enviado.
// Referência: https://developers.facebook.com/docs/whatsapp/cloud-api — confira a
// versão da Graph API e as regras de templates/janela de 24h antes de ativar.

export type SendResult =
  | { outcome: 'accepted'; providerId: string; http: number }
  | { outcome: 'retry' | 'failed'; error: string; http?: number }
  | { outcome: 'uncertain'; error: string }

export function isConfigured() {
  return Boolean(Deno.env.get('WHATSAPP_TOKEN') && Deno.env.get('WHATSAPP_PHONE_NUMBER_ID'))
}

/**
 * Mensagens iniciadas pela empresa fora da janela de 24h exigem TEMPLATE aprovado.
 * Se o template do provedor estiver cadastrado, envia como template com o corpo
 * renderizado em um parâmetro; caso contrário envia texto (válido só dentro da janela).
 */
export async function sendWhatsApp(to: string, body: string, template?: { name: string; lang: string } | null): Promise<SendResult> {
  const version = Deno.env.get('WHATSAPP_API_VERSION') ?? 'v21.0'
  const url = `https://graph.facebook.com/${version}/${Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')}/messages`
  const payload = template
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template.name, language: { code: template.lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: body }] }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${Deno.env.get('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data?.messages?.[0]?.id) return { outcome: 'accepted', providerId: data.messages[0].id, http: res.status }
    const err = data?.error?.message ?? `HTTP ${res.status}`
    // 429/5xx: o provedor não aceitou — pode tentar de novo com espera
    if (res.status === 429 || res.status >= 500) return { outcome: 'retry', error: err, http: res.status }
    return { outcome: 'failed', error: err, http: res.status }
  } catch (e) {
    // timeout/queda de rede depois de enviar: a mensagem PODE ter saído → não reenviar às cegas
    return { outcome: 'uncertain', error: `Sem resposta do provedor: ${String(e)}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Valida X-Hub-Signature-256 (HMAC-SHA256 do corpo com o App Secret). */
export async function validSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get('WHATSAPP_APP_SECRET')
  if (!secret || !header?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)))
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('')
  const given = header.slice(7)
  if (given.length !== hex.length) return false
  let diff = 0
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}

// Webhook da API oficial do WhatsApp: status (sent/delivered/read/failed) e respostas.
// Assinatura validada; eventos duplicados e fora de ordem são tolerados no banco.
import { adminClient } from '../_shared/supabase.ts'
import { validSignature } from '../_shared/whatsapp.ts'

Deno.serve(async (req) => {
  const url = new URL(req.url)
  // Verificação inicial do endpoint pela Meta
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === Deno.env.get('WHATSAPP_VERIFY_TOKEN')
    return new Response(ok ? url.searchParams.get('hub.challenge') : 'forbidden', { status: ok ? 200 : 403 })
  }
  const raw = await req.text()
  if (!(await validSignature(raw, req.headers.get('x-hub-signature-256')))) return new Response('invalid signature', { status: 401 })
  const db = adminClient()
  const body = JSON.parse(raw)
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {}
      for (const s of v.statuses ?? []) {
        await db.rpc('apply_provider_status', { p_provider: 'whatsapp', p_event_id: `${s.id}:${s.status}:${s.timestamp}`, p_provider_message_id: s.id,
          p_status: s.status, p_payload: { status: s.status, timestamp: s.timestamp, error: s.errors?.[0]?.title ?? null } })
      }
      for (const m of v.messages ?? []) {
        // payload mínimo: não guardar mais dados pessoais que o necessário
        await db.rpc('apply_inbound_message', { p_provider: 'whatsapp', p_event_id: m.id, p_from: m.from, p_text: m.text?.body ?? m.button?.text ?? '',
          p_payload: { type: m.type, timestamp: m.timestamp } })
      }
    }
  }
  return new Response('ok')
})

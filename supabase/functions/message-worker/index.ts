// Worker de envio: chamado pelo pg_cron (ver supabase/setup/cron_worker.sql).
// Reserva mensagens com trava, refaz a checagem final no banco e envia.
import { adminClient, json } from '../_shared/supabase.ts'
import { isConfigured, sendWhatsApp } from '../_shared/whatsapp.ts'

Deno.serve(async (req) => {
  if (req.headers.get('x-worker-secret') !== Deno.env.get('WORKER_SECRET') || !Deno.env.get('WORKER_SECRET')) {
    return json({ error: 'não autorizado' }, 401)
  }
  const db = adminClient()
  const workerId = `edge-${crypto.randomUUID().slice(0, 8)}`
  const { data: run } = await db.from('job_runs').insert({ job: 'message-worker' }).select('id').single()
  const summary = { claimed: 0, sent: 0, skipped: 0, failed: 0, uncertain: 0, configured: isConfigured() }
  try {
    if (!isConfigured()) {
      // Sem credenciais: não reserva nada (as mensagens ficam pendentes e visíveis na fila).
      await db.from('job_runs').update({ finished_at: new Date().toISOString(), ok: true, detail: { ...summary, note: 'WhatsApp não configurado' } }).eq('id', run?.id)
      return json(summary)
    }
    const { data: batch, error } = await db.rpc('claim_messages', { p_worker: workerId, p_limit: 20 })
    if (error) throw error
    summary.claimed = batch?.length ?? 0
    for (const m of batch ?? []) {
      const { data: block } = await db.rpc('message_presend_check', { p_message: m.id })
      if (block) { summary.skipped++; continue }
      const { data: tpl } = await db.from('message_templates').select('provider_template_name, provider_template_lang')
        .eq('workshop_id', m.workshop_id).eq('key', m.template_key).maybeSingle()
      const r = await sendWhatsApp(m.to_phone, m.rendered_body, tpl?.provider_template_name ? { name: tpl.provider_template_name, lang: tpl.provider_template_lang ?? 'pt_BR' } : null)
      await db.rpc('message_send_result', {
        p_message: m.id, p_outcome: r.outcome, p_provider_id: r.outcome === 'accepted' ? r.providerId : null,
        p_error: r.outcome === 'accepted' ? null : r.error, p_http: 'http' in r ? r.http ?? null : null,
      })
      if (r.outcome === 'accepted') summary.sent++
      else if (r.outcome === 'uncertain') summary.uncertain++
      else summary.failed++
    }
    await db.from('job_runs').update({ finished_at: new Date().toISOString(), ok: true, detail: summary }).eq('id', run?.id)
    return json(summary)
  } catch (e) {
    await db.from('job_runs').update({ finished_at: new Date().toISOString(), ok: false, detail: { ...summary, error: String(e) } }).eq('id', run?.id)
    return json({ error: String(e) }, 500)
  }
})

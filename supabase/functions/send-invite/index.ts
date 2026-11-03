// Envia o e-mail de acesso de um convite já criado no banco (create_invite).
// Só funciona se quem chama enxerga o convite pendente (RLS exige team.manage).
import { adminClient, cors, json, userClient } from '../_shared/supabase.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { email, full_name, redirect_to } = await req.json()
    if (typeof email !== 'string' || typeof redirect_to !== 'string') return json({ error: 'parâmetros inválidos' }, 400)
    const appOrigin = Deno.env.get('APP_ORIGIN')
    if (appOrigin && !redirect_to.startsWith(appOrigin + '/convite')) return json({ error: 'redirect inválido' }, 400)

    const user = userClient(req)
    const { data: invites, error } = await user.from('invites').select('id').eq('email', email.toLowerCase().trim())
      .is('used_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString()).limit(1)
    if (error || !invites?.length) return json({ error: 'convite não encontrado ou sem permissão' }, 403)

    const admin = adminClient()
    const { error: invErr } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: redirect_to, data: { full_name } })
    if (invErr) {
      if (/already|registered|exists/i.test(invErr.message)) return json({ status: 'exists' })
      return json({ error: invErr.message }, 500)
    }
    return json({ status: 'invited' })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})

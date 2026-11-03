// URL temporária (5 min) para foto liberada ao cliente no portal.
// Validação do token e da liberação feita no banco (portal_photo_path).
import { adminClient, cors, json } from '../_shared/supabase.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { token, attachment_id } = await req.json()
    if (typeof token !== 'string' || typeof attachment_id !== 'string') return json({ error: 'parâmetros inválidos' }, 400)
    const admin = adminClient()
    const { data: path, error } = await admin.rpc('portal_photo_path', { p_token: token, p_attachment: attachment_id })
    if (error || !path) return json({ error: 'indisponível' }, 404)
    const { data, error: e2 } = await admin.storage.from('order-files').createSignedUrl(path as string, 300)
    if (e2) return json({ error: 'indisponível' }, 404)
    return json({ url: data.signedUrl })
  } catch {
    return json({ error: 'indisponível' }, 400)
  }
})

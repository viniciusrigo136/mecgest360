// Informa à interface se integrações estão configuradas, sem expor segredos.
import { cors, json, userClient } from '../_shared/supabase.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const { data } = await userClient(req).auth.getUser()
  if (!data.user) return json({ error: 'não autenticado' }, 401)
  return json({
    whatsapp_configured: Boolean(Deno.env.get('WHATSAPP_TOKEN') && Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') && Deno.env.get('WHATSAPP_APP_SECRET')),
  })
})

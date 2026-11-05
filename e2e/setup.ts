// Prepara o Supabase LOCAL: dono e mecânico de teste, oficina com Pix.
// Lê URL e chaves de `npx supabase status -o env` (ambiente local, nunca produção).
import { createClient } from '@supabase/supabase-js'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

export const E2E = { owner: 'dono.e2e@mecgest.test', mech: 'mecanico.e2e@mecgest.test', password: 'Teste-e2e-12345' }

function localEnv() {
  const out = execSync('npx supabase status -o env', { encoding: 'utf8' })
  const get = (k: string) => out.match(new RegExp(`^${k}="?([^"\\n]+)"?`, 'm'))?.[1]
  const url = get('API_URL'), anon = get('ANON_KEY') ?? get('PUBLISHABLE_KEY'), service = get('SERVICE_ROLE_KEY') ?? get('SECRET_KEY')
  if (!url || !anon || !service) throw new Error('Supabase local não está rodando (npx supabase start)')
  if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error('Os testes E2E só rodam contra o Supabase local')
  return { url, anon, service }
}

export default async function setup() {
  const { url, anon, service } = localEnv()
  writeFileSync('.env.e2e', `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\n`)
  const admin = createClient(url, service, { auth: { persistSession: false } })

  // recomeça do zero a cada execução (banco local de teste)
  execSync('npx supabase db reset --local --yes', { stdio: 'ignore' })

  const mk = async (email: string, name: string) => {
    const { data, error } = await admin.auth.admin.createUser({ email, password: E2E.password, email_confirm: true, user_metadata: { full_name: name } })
    if (error) throw error
    return data.user.id
  }
  const owner = await mk(E2E.owner, 'Dono Teste')
  const mech = await mk(E2E.mech, 'Mecânico Teste')
  const { data: ws, error } = await admin.rpc('provision_workshop', { p_name: 'Oficina Teste E2E', p_owner_user: owner, p_is_demo: true })
  if (error) throw error
  await admin.from('workshops').update({ pix_key: 'oficina@teste.com', pix_name: 'Oficina Teste', pix_city: 'Chapeco',
    business_hours: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [['00:00', '23:59']]])) }).eq('id', ws)
  // mecânico como a tela "Funcionários" cria: vê todos os carros, sem valores
  const { data: m } = await admin.from('memberships').insert({ workshop_id: ws, user_id: mech, role: 'mechanic', order_scope: 'all' }).select('id').single()
  await admin.from('member_permission_overrides').insert({ workshop_id: ws, membership_id: m!.id, permission: 'orders.view_all', granted: true })
  mkdirSync('e2e/.tmp', { recursive: true })
  writeFileSync('e2e/.tmp/ctx.json', JSON.stringify({ url, anon, service, ws }))
}

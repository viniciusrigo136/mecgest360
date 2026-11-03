// Dados FICTÍCIOS para ambiente de demonstração/teste. Nunca rode em produção.
// Cria duas oficinas de demonstração (a segunda serve para testar isolamento),
// usuários por perfil com senhas aleatórias e dados operando pelas RPCs reais.
// As credenciais geradas são gravadas em .tmp/demo-credentials.txt (fora do git).
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... npx tsx scripts/seed-demo.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const url = process.env.SUPABASE_URL!, service = process.env.SUPABASE_SERVICE_ROLE_KEY!, anon = process.env.SUPABASE_ANON_KEY!
if (!url || !service || !anon) { console.error('Defina SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e SUPABASE_ANON_KEY.'); process.exit(1) }
if (process.env.ALLOW_DEMO_SEED !== 'sim') { console.error('Proteção: defina ALLOW_DEMO_SEED=sim para confirmar que este é um ambiente de demonstração.'); process.exit(1) }

const admin = createClient(url, service, { auth: { persistSession: false } })
const creds: string[] = ['# Credenciais do ambiente de DEMONSTRAÇÃO (geradas aleatoriamente). Não use em produção.']
const stamp = Date.now().toString(36)

async function user(label: string, role: string) {
  const email = `demo.${role}.${stamp}@mecgest360.test`
  const password = randomBytes(9).toString('base64url')
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: label } })
  if (error) throw error
  creds.push(`${role.padEnd(10)} ${email}  ${password}`)
  const c = createClient(url, anon, { auth: { persistSession: false } })
  const { error: e2 } = await c.auth.signInWithPassword({ email, password })
  if (e2) throw e2
  return { id: data.user.id, email, client: c }
}

async function rpc<T = any>(c: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

async function invite(owner: SupabaseClient, ws: string, label: string, role: string, scope = 'all') {
  const u = await user(label, role)
  const [inv] = await rpc<any[]>(owner, 'create_invite', { p_workshop: ws, p_email: u.email, p_full_name: label, p_role: role, p_order_scope: scope })
  await rpc(u.client, 'accept_invite', { p_token: inv.token })
  const { data } = await admin.from('memberships').select('id').eq('workshop_id', ws).eq('user_id', u.id).single()
  return { ...u, membershipId: data!.id as string }
}

// ---------------- Oficina A ----------------
const ownerA = await user('Proprietário Demo', 'owner')
const wsA = await rpc<string>(admin, 'provision_workshop', { p_name: 'MecGest 360 — Demonstração', p_owner_user: ownerA.id, p_is_demo: true })
const reception = await invite(ownerA.client, wsA, 'Recepção Demo', 'reception')
const mech = await invite(ownerA.client, wsA, 'Mecânico Demo', 'mechanic', 'assigned')
await invite(ownerA.client, wsA, 'Financeiro Demo', 'finance')
const stock = await invite(ownerA.client, wsA, 'Estoque Demo', 'stock')
creds.push('')

await admin.from('service_catalog').insert([
  { workshop_id: wsA, name: 'Troca de óleo e filtro', duration_min: 45, base_price_cents: 9000, category: 'Revisão', maintenance_component: 'oleo_motor' },
  { workshop_id: wsA, name: 'Alinhamento e balanceamento', duration_min: 60, base_price_cents: 12000, category: 'Suspensão', maintenance_component: 'alinhamento' },
  { workshop_id: wsA, name: 'Troca de pastilhas dianteiras', duration_min: 90, base_price_cents: 15000, category: 'Freios', maintenance_component: 'freios' },
  { workshop_id: wsA, name: 'Diagnóstico eletrônico', duration_min: 60, base_price_cents: 18000, category: 'Elétrica' },
])
const { data: prods } = await stock.client.from('products').insert([
  { workshop_id: wsA, sku: 'OL-5W30', name: 'Óleo sintético 5W30 (litro)', unit: 'l', qty_decimals: 3, min_stock: 10, sale_price_cents: 6500 },
  { workshop_id: wsA, sku: 'FO-001', name: 'Filtro de óleo universal', min_stock: 5, sale_price_cents: 4500 },
  { workshop_id: wsA, sku: 'PF-D01', name: 'Pastilha de freio dianteira (jogo)', min_stock: 2, sale_price_cents: 22000 },
]).select('id, sku')
const { data: sup } = await stock.client.from('suppliers').insert({ workshop_id: wsA, name: 'Autopeças Exemplo Ltda (fictício)' }).select('id').single()
const po = await rpc<string>(stock.client, 'save_purchase', { p_workshop: wsA, p_supplier: sup!.id, p_expected: null, p_notes: 'Compra inicial (demo)', p_items: [
  { product_id: prods![0].id, description: 'Óleo 5W30', quantity: 40, unit_cost_cents: 3200 },
  { product_id: prods![1].id, description: 'Filtro de óleo', quantity: 12, unit_cost_cents: 1800 },
  { product_id: prods![2].id, description: 'Pastilha dianteira', quantity: 4, unit_cost_cents: 11000 }] })
const { data: poItems } = await admin.from('purchase_order_items').select('id, quantity').eq('purchase_id', po)
await rpc(stock.client, 'receive_purchase', { p_purchase: po, p_items: poItems!.map((i) => ({ po_item_id: i.id, quantity: Number(i.quantity) })), p_invoice: 'DEMO-001', p_due_date: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10), p_idem: `seed-${stamp}` })

const clients = [
  { name: 'Ana Pereira (fictícia)', phone: '11 90000-0001', plate: 'DEM1A11', brand: 'Chevrolet', model: 'Onix', km: 48200 },
  { name: 'Bruno Lima (fictício)', phone: '11 90000-0002', plate: 'DEM2B22', brand: 'Hyundai', model: 'HB20', km: 31500 },
  { name: 'Carla Souza (fictícia)', phone: '11 90000-0003', plate: 'DEM3C33', brand: 'Fiat', model: 'Argo', km: 72000 },
]
const reg: any[] = []
for (const c of clients) {
  const [r] = await rpc<any[]>(reception.client, 'quick_register', { p_workshop: wsA, p_client: { name: c.name, phone: c.phone }, p_vehicle: { plate: c.plate, brand: c.brand, model: c.model, year_model: '2021' }, p_km: c.km })
  reg.push({ ...c, ...r })
}
// OS em execução atribuída ao mecânico, com orçamento aprovado por telefone
const order = await rpc<string>(reception.client, 'open_order', { p_workshop: wsA, p_client: reg[0].client_id, p_vehicle: reg[0].vehicle_id, p_complaint: 'Revisão e barulho ao frear', p_km: reg[0].km + 300, p_mechanics: [mech.membershipId] })
const quote = await rpc<string>(reception.client, 'save_quote', { p_workshop: wsA, p_quote: null, p_client: reg[0].client_id, p_vehicle: reg[0].vehicle_id, p_order: order, p_valid_until: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), p_items: [
  { kind: 'service', description: 'Troca de óleo e filtro', quantity: 1, unit_price_cents: 9000, maintenance_component: 'oleo_motor' },
  { kind: 'part', description: 'Óleo sintético 5W30 (litro)', product_id: prods![0].id, quantity: 4, unit_price_cents: 6500 },
  { kind: 'service', description: 'Troca de pastilhas dianteiras', quantity: 1, unit_price_cents: 15000, group_key: 'freio', maintenance_component: 'freios' },
  { kind: 'part', description: 'Pastilha de freio dianteira (jogo)', product_id: prods![2].id, quantity: 1, unit_price_cents: 22000, group_key: 'freio' },
  { kind: 'service', description: 'Higienização do ar-condicionado', quantity: 1, unit_price_cents: 12000 }] })
await rpc(reception.client, 'send_quote', { p_quote: quote })
const { data: qItems } = await admin.from('quote_items').select('id, description').eq('version_id', (await admin.from('quotes').select('current_version_id').eq('id', quote).single()).data!.current_version_id)
await rpc(reception.client, 'record_quote_decision', { p_quote: quote, p_approved: qItems!.filter((i) => !i.description.startsWith('Higienização')).map((i) => i.id), p_channel: 'telefone', p_name: 'Ana', p_note: 'Demo: aprovou exceto higienização' })
await rpc(mech.client, 'order_transition', { p_order: order, p_to: 'in_progress' })
// Agendamento futuro e plano preventivo
const tomorrow = new Date(Date.now() + 864e5); tomorrow.setUTCHours(13, 0, 0, 0)
if (tomorrow.getUTCDay() === 0) tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
await rpc(reception.client, 'save_appointment', { p_workshop: wsA, p_id: null, p_client: reg[1].client_id, p_vehicle: reg[1].vehicle_id, p_service: null, p_description: 'Alinhamento e balanceamento',
  p_starts_at: tomorrow.toISOString(), p_ends_at: new Date(+tomorrow + 36e5).toISOString(), p_member: null, p_resource: null })
await rpc(ownerA.client, 'create_maintenance_plan', { p_vehicle: reg[2].vehicle_id, p_component: 'oleo_motor', p_component_label: 'Óleo do motor', p_action: 'troca', p_interval_months: 6, p_interval_days: 0,
  p_interval_km: 10000, p_rule: 'first', p_lead_days: 30, p_lead_km: 1000, p_source: 'Demo: manual do fabricante (exemplo)', p_notes: null,
  p_base_date: new Date(Date.now() - 170 * 864e5).toISOString().slice(0, 10), p_base_km: 64000 })

// ---------------- Oficina B (isolamento) ----------------
const ownerB = await user('Proprietário Oficina B', 'ownerB')
const wsB = await rpc<string>(admin, 'provision_workshop', { p_name: 'Oficina B — Demonstração (isolamento)', p_owner_user: ownerB.id, p_is_demo: true })
await rpc(ownerB.client, 'quick_register', { p_workshop: wsB, p_client: { name: 'Cliente exclusivo da B (fictício)', phone: '21 90000-9999' }, p_vehicle: { plate: 'BBB9B99', model: 'Gol' } })

mkdirSync('.tmp', { recursive: true })
writeFileSync('.tmp/demo-credentials.txt', creds.join('\n') + '\n')
console.log(`Demo criada. Oficina A: ${wsA}  Oficina B: ${wsB}`)
console.log('Credenciais (aleatórias) gravadas em .tmp/demo-credentials.txt — arquivo fora do git.')

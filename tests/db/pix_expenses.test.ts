// Pix no portal, gastos do serviço e histórico do carro no portal.
import { beforeAll, describe, expect, it } from 'vitest'
import { addMember, admin, as, createUser, expectError, provision, quickClient, rpc } from './helpers.ts'

let owner: string, ws: string, mech: { userId: string }, car: { client_id: string; vehicle_id: string }

async function delivered(desc: string, cents: number, km: number) {
  const o = await rpc(owner, 'open_order', { p_workshop: ws, p_client: car.client_id, p_vehicle: car.vehicle_id, p_complaint: desc, p_km: km })
  await rpc(owner, 'add_order_item', { p_order: o, p_kind: 'service', p_description: desc, p_qty: 1, p_unit_price_cents: cents,
    p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
  await rpc(owner, 'order_transition', { p_order: o, p_to: 'in_progress' })
  await rpc(owner, 'finish_service', { p_order: o })
  return o as string
}

beforeAll(async () => {
  owner = await createUser('Dono Pix')
  ws = await provision('Oficina Pix (teste)', owner)
  mech = await addMember(ws, owner, 'Mecânico Pix', 'mechanic', { scope: 'all', overrides: { 'orders.view_all': true } })
  car = await quickClient(owner, ws, 'Cliente Pix', 'PIX1A23')
  await admin((q) => q(`update workshops set pix_key = 'oficina@pix.com', pix_name = 'Oficina Pix', pix_city = 'Chapeco' where id = $1`, [ws]))
})

describe('gastos do serviço', () => {
  it('dono anota gastos e vê quanto sobrou; mecânico não vê nem anota', async () => {
    const o = await delivered('Troca de amortecedor', 80000, 10000)
    await as(owner, (q) => q(`insert into order_expenses(workshop_id, order_id, description, category, amount_cents) values ($1,$2,'Amortecedor (fornecedor)','peca',35000)`, [ws, o]))
    const p = await rpc<any>(owner, 'order_profit', { p_order: o })
    expect([Number(p.total_cents), Number(p.expenses_cents), Number(p.left_cents)]).toEqual([80000, 35000, 45000])
    expect(await as(mech.userId, (q) => q('select * from order_expenses'))).toHaveLength(0)
    await expectError(as(mech.userId, (q) => q(`insert into order_expenses(workshop_id, order_id, description, amount_cents) values ($1,$2,'x',100)`, [ws, o])), 'row-level security')
    await expectError(rpc(mech.userId, 'order_profit', { p_order: o }), 'Sem permissão')
  })
})

describe('portal: pix e histórico', () => {
  it('mostra o Pix com o valor em aberto e o histórico só do cliente atual', async () => {
    const o1 = await delivered('Revisão 10 mil', 30000, 20000)
    await rpc(owner, 'deliver_simple', { p_order: o1, p_mode: 'already_paid' })
    const o2 = await delivered('Troca de pastilhas', 25000, 30000)
    const l = await rpc<any>(owner, 'create_portal_link', { p_purpose: 'track', p_order: o2, p_quote: null })
    const pix = await rpc<any>(null, 'portal_pix', { p_token: l.token })
    expect(pix).toEqual({ key: 'oficina@pix.com', name: 'Oficina Pix', city: 'Chapeco', amount_cents: 25000 })
    const hist = await rpc<any>(null, 'portal_history', { p_token: l.token })
    expect(hist.map((h: any) => h.items)).toContainEqual(['Revisão 10 mil'])
    // carro vendido: o novo dono não vê o histórico do anterior
    const [novo] = await as(owner, (q) => q(`insert into clients(workshop_id, name) values ($1, 'Novo Dono Pix') returning id`, [ws]))
    await rpc(owner, 'transfer_vehicle', { p_vehicle: car.vehicle_id, p_new_client: novo.id, p_reason: 'venda' })
    const o3 = await rpc(owner, 'open_order', { p_workshop: ws, p_client: novo.id, p_vehicle: car.vehicle_id, p_complaint: 'Revisão', p_km: 40000 })
    const l3 = await rpc<any>(owner, 'create_portal_link', { p_purpose: 'track', p_order: o3, p_quote: null })
    expect(await rpc<any>(null, 'portal_history', { p_token: l3.token })).toEqual([])
  })
})

// Lembretes de retorno definidos pelo mecânico, item a item.
import { beforeAll, describe, expect, it } from 'vitest'
import { addMember, admin, createUser, expectError, provision, quickClient, rpc, rpcRows } from './helpers.ts'

let km = 50000

let owner: string, ws: string, mech: { userId: string }, car: { client_id: string; vehicle_id: string }

async function serviceWith(desc: string) {
  const o = await rpc(owner, 'open_order', { p_workshop: ws, p_client: car.client_id, p_vehicle: car.vehicle_id, p_complaint: desc, p_km: (km += 100) })
  await rpc(owner, 'add_order_item', { p_order: o, p_kind: 'service', p_description: desc, p_qty: 1, p_unit_price_cents: 40000,
    p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
  await rpc(mech.userId, 'order_transition', { p_order: o, p_to: 'in_progress' })
  return o as string
}

beforeAll(async () => {
  owner = await createUser('Dono Lembretes')
  ws = await provision('Oficina Lembretes (teste)', owner)
  mech = await addMember(ws, owner, 'Mecânico Lembretes', 'mechanic', { scope: 'all', overrides: { 'orders.view_all': true } })
  car = await quickClient(owner, ws, 'Cliente Lembrete', 'LMB1A23')
})

describe('lembretes de retorno', () => {
  it('mecânico finaliza com um lembrete por serviço feito', async () => {
    const o = await serviceWith('Troca de amortecedores')
    await rpc(mech.userId, 'finish_service_with_returns', { p_order: o, p_returns: [
      { label: 'Amortecedores', months: 12, km: 20000 }, { label: 'Alinhamento', months: 6, km: '' }] })
    const rows = await rpcRows(mech.userId, 'order_reminders', { p_order: o })
    expect(rows.map((x) => [x.label, x.interval_months, x.interval_km])).toEqual([['Alinhamento', 6, null], ['Amortecedores', 12, 20000]])
    const [s] = await admin((q) => q('select status, maintenance_decision from service_orders where id = $1', [o]))
    expect(s).toEqual({ status: 'ready', maintenance_decision: 'registered' })
  })

  it('serviço refeito renova o mesmo lembrete (sem duplicar)', async () => {
    const o2 = await serviceWith('Amortecedores de novo')
    await rpc(mech.userId, 'add_return_reminder', { p_order: o2, p_label: 'amortecedores', p_months: 24, p_km: null })
    const plans = await admin((q) => q(`select interval_months, interval_km, rule from maintenance_plans where vehicle_id = $1 and component = 'amortecedores'`, [car.vehicle_id]))
    expect(plans).toEqual([{ interval_months: 24, interval_km: null, rule: 'date_only' }])
    const cycles = await admin((q) => q(`select c.status from maintenance_cycles c join maintenance_plans p on p.id = c.plan_id
      where p.component = 'amortecedores' and p.vehicle_id = $1 order by seq`, [car.vehicle_id]))
    expect(cycles.map((c) => c.status)).toEqual(['closed', 'open'])
    await expectError(rpc(mech.userId, 'add_return_reminder', { p_order: o2, p_label: 'Amortecedores', p_months: 12, p_km: null }), 'Já existe')
  })

  it('exige o que foi feito e um prazo', async () => {
    const o3 = await serviceWith('Freios')
    await expectError(rpc(mech.userId, 'add_return_reminder', { p_order: o3, p_label: '', p_months: 6, p_km: null }), 'Diga o que foi feito')
    await expectError(rpc(mech.userId, 'add_return_reminder', { p_order: o3, p_label: 'Freios', p_months: null, p_km: null }), 'tempo ou km')
  })
})

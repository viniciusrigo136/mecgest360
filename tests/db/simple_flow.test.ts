// Fluxo simples (estilo ChapGest): receber → começar → pronto → entregar em poucos toques.
import { beforeAll, describe, expect, it } from 'vitest'
import { addMember, admin, as, createUser, expectError, provision, quickClient, rpc } from './helpers.ts'

let owner: string, ws: string, mech: { userId: string; membershipId: string }, rec: { userId: string }

async function newOrder(plate: string) {
  const c = await quickClient(owner, ws, 'Cliente Simples', plate)
  const o = await rpc(rec.userId, 'open_order', { p_workshop: ws, p_client: c.client_id, p_vehicle: c.vehicle_id, p_complaint: 'Troca de óleo', p_km: 40000 })
  return { order: o as string, vehicle: c.vehicle_id }
}

beforeAll(async () => {
  owner = await createUser('Dono Simples')
  ws = await provision('Oficina Simples (teste)', owner)
  // mecânico vendo todas as OS (padrão da tela simples de funcionários), sem valores
  mech = await addMember(ws, owner, 'Mecânico Simples', 'mechanic', { scope: 'all', overrides: { 'orders.view_all': true } })
  rec = await addMember(ws, owner, 'Atendente Simples', 'reception', { overrides: { 'payments.receive': true } })
})

describe('fluxo simples', () => {
  it('não começa sem serviço aprovado; com item aprovado no balcão começa direto', async () => {
    const { order } = await newOrder('SMP1A11')
    await expectError(rpc(mech.userId, 'order_transition', { p_order: order, p_to: 'in_progress' }), 'Adicione o serviço')
    await rpc(rec.userId, 'add_order_item', { p_order: order, p_kind: 'service', p_description: 'Troca de óleo', p_qty: 1,
      p_unit_price_cents: 15000, p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
    await rpc(mech.userId, 'order_transition', { p_order: order, p_to: 'in_progress' })
    const [o] = await admin((q) => q('select status from service_orders where id = $1', [order]))
    expect(o.status).toBe('in_progress')
  })

  it('mecânico vê todas as OS mas continua sem ver valores', async () => {
    const rows = await as(mech.userId, (q) => q('select id from service_orders'))
    expect(rows.length).toBeGreaterThan(0)
    expect(await as(mech.userId, (q) => q('select * from order_items'))).toHaveLength(0)
    expect(await as(mech.userId, (q) => q('select * from accounts'))).toHaveLength(0)
  })

  it('"pronto" em um toque marca itens, fecha apontamento e cria retorno quando pedido', async () => {
    const { order, vehicle } = await newOrder('SMP2B22')
    await rpc(rec.userId, 'add_order_item', { p_order: order, p_kind: 'service', p_description: 'Alinhamento', p_qty: 1,
      p_unit_price_cents: 12000, p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
    await rpc(mech.userId, 'order_transition', { p_order: order, p_to: 'in_progress' })
    await rpc(mech.userId, 'timer_start', { p_order: order })
    await rpc(mech.userId, 'finish_service', { p_order: order, p_return_months: 6, p_return_km: 10000 })
    const [o] = await admin((q) => q('select status, maintenance_decision from service_orders where id = $1', [order]))
    expect(o).toEqual({ status: 'ready', maintenance_decision: 'registered' })
    const [it] = await admin((q) => q('select status, executed_confirmed_at is not null ok from order_items where order_id = $1', [order]))
    expect(it).toEqual({ status: 'done', ok: true })
    const timers = await admin((q) => q('select * from time_entries where order_id = $1 and ended_at is null', [order]))
    expect(timers).toHaveLength(0)
    const [plan] = await admin((q) => q(`select rule, interval_months, interval_km from maintenance_plans where vehicle_id = $1`, [vehicle]))
    expect(plan).toEqual({ rule: 'first', interval_months: 6, interval_km: 10000 })
  })

  it('entregar: "pagou agora" cobra e quita; repetir não duplica', async () => {
    const { order } = await newOrder('SMP3C33')
    await rpc(rec.userId, 'add_order_item', { p_order: order, p_kind: 'service', p_description: 'Freio', p_qty: 1,
      p_unit_price_cents: 30000, p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
    await rpc(mech.userId, 'order_transition', { p_order: order, p_to: 'in_progress' })
    await rpc(mech.userId, 'finish_service', { p_order: order })
    await expectError(rpc(mech.userId, 'deliver_simple', { p_order: order, p_mode: 'paid_now', p_method: 'pix' }), 'Sem permissão')
    await rpc(rec.userId, 'deliver_simple', { p_order: order, p_mode: 'paid_now', p_method: 'dinheiro' })   // sem caixa aberto
    const [acc] = await admin((q) => q(`select status, total_cents from accounts where order_id = $1`, [order]))
    expect(acc).toEqual({ status: 'paid', total_cents: '30000' })
    const [o] = await admin((q) => q('select status, delivery_payment_note from service_orders where id = $1', [order]))
    expect(o).toEqual({ status: 'delivered', delivery_payment_note: 'Pago na entrega' })
    await expectError(rpc(rec.userId, 'deliver_simple', { p_order: order, p_mode: 'paid_now', p_method: 'dinheiro' }), 'pronta')
    const pays = await admin((q) => q(`select p.* from account_payments p join account_installments i on i.id = p.installment_id
      join accounts a on a.id = i.account_id where a.order_id = $1`, [order]))
    expect(pays).toHaveLength(1)
  })

  it('entregar: "vai pagar depois" deixa a cobrança em aberto com vencimento', async () => {
    const { order } = await newOrder('SMP4D44')
    await rpc(rec.userId, 'add_order_item', { p_order: order, p_kind: 'service', p_description: 'Revisão', p_qty: 1,
      p_unit_price_cents: 20000, p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
    await rpc(mech.userId, 'order_transition', { p_order: order, p_to: 'in_progress' })
    await rpc(mech.userId, 'finish_service', { p_order: order })
    await rpc(rec.userId, 'deliver_simple', { p_order: order, p_mode: 'later', p_due: '2099-01-10' })
    const [inst] = await admin((q) => q(`select i.due_date::text due, i.paid_cents from account_installments i join accounts a on a.id = i.account_id where a.order_id = $1`, [order]))
    expect(inst).toEqual({ due: '2099-01-10', paid_cents: '0' })
  })

  it('resumo do dia e indicadores respondem e escondem valores de quem não pode ver', async () => {
    const s = await rpc<any>(mech.userId, 'day_summary', { p_workshop: ws })
    expect(s.received_yesterday_cents).toBeNull()
    expect(Number(s.services_7d)).toBeGreaterThanOrEqual(4)
    const i = await rpc<any>(owner, 'indicators', { p_workshop: ws, p_days: 30 })
    expect(Number(i.services.cur)).toBeGreaterThanOrEqual(4)
    expect(Number(i.sales.cur)).toBeGreaterThan(0)
    expect(i.daily).toHaveLength(30)
    await expectError(rpc(mech.userId, 'indicators', { p_workshop: ws, p_days: 30 }), 'Sem permissão')
  })
})

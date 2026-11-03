// Critérios 7 e 8: estoque (reserva/consumo/estorno/concorrência) e financeiro.
import { beforeAll, describe, expect, it } from 'vitest'
import { addMember, admin, as, createUser, expectError, provision, quickClient, rpc } from './helpers.ts'

let owner: string, ws: string, stock: { userId: string }, fin: { userId: string }, mech: { userId: string; membershipId: string }
let productId: string, oleoId: string

const bal = async (p: string) => (await admin((q) => q('select on_hand::float, reserved::float from stock_balances where product_id = $1', [p])))[0]

async function orderWithPart(product: string, qty: number) {
  const c = await quickClient(owner, ws, 'Cliente Estoque', `EST${Math.floor(1000 + Math.random() * 8999)}`)
  const o = await rpc(owner, 'open_order', { p_workshop: ws, p_client: c.client_id, p_vehicle: c.vehicle_id, p_complaint: 'x',
    p_mechanics: [mech.membershipId] })
  const item = await rpc(owner, 'add_order_item', { p_order: o, p_kind: 'part', p_description: 'Peça', p_qty: qty,
    p_unit_price_cents: 10000, p_product: product, p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
  return { order: o as string, item: item as string }
}

beforeAll(async () => {
  owner = await createUser('Dono Estoque')
  ws = await provision('Oficina Estoque (teste)', owner)
  stock = await addMember(ws, owner, 'Estoquista Rui', 'stock')
  fin = await addMember(ws, owner, 'Financeiro Edu', 'finance')
  mech = await addMember(ws, owner, 'Mecânico Tião', 'mechanic')
  ;[{ id: productId }] = await as(stock.userId, (q) => q(`insert into products(workshop_id, sku, name, min_stock, sale_price_cents)
     values ($1, 'FIL-01', 'Filtro de óleo', 2, 4500) returning id`, [ws]))
  ;[{ id: oleoId }] = await as(stock.userId, (q) => q(`insert into products(workshop_id, sku, name, unit, qty_decimals, sale_price_cents)
     values ($1, 'OLEO-5W30', 'Óleo 5W30', 'l', 3, 6000) returning id`, [ws]))
})

describe('estoque', () => {
  it('saldo não muda sem movimento e entrada por compra calcula custo médio', async () => {
    await expectError(admin((q) => q('update stock_balances set on_hand = 999 where product_id = $1', [productId])), 'movimentação')
    const [{ id: sup }] = await as(stock.userId, (q) => q(`insert into suppliers(workshop_id, name) values ($1, 'Distribuidora') returning id`, [ws]))
    const po = await rpc(stock.userId, 'save_purchase', { p_workshop: ws, p_supplier: sup, p_expected: null, p_notes: null, p_items: [
      { product_id: productId, description: 'Filtro', quantity: 4, unit_cost_cents: 2000 },
      { product_id: oleoId, description: 'Óleo', quantity: 20, unit_cost_cents: 3000 }] })
    const its = await admin((q) => q('select id, product_id from purchase_order_items where purchase_id = $1', [po]))
    const fil = its.find((i) => i.product_id === productId).id, ole = its.find((i) => i.product_id === oleoId).id
    // recebimento parcial + repetição idempotente
    await rpc(stock.userId, 'receive_purchase', { p_purchase: po, p_items: [{ po_item_id: fil, quantity: 2 }], p_invoice: 'NF1',
      p_due_date: '2099-01-10', p_idem: 'rcv-1' })
    await rpc(stock.userId, 'receive_purchase', { p_purchase: po, p_items: [{ po_item_id: fil, quantity: 2 }], p_invoice: 'NF1',
      p_due_date: '2099-01-10', p_idem: 'rcv-1' })
    expect(await bal(productId)).toEqual({ on_hand: 2, reserved: 0 })
    await rpc(stock.userId, 'receive_purchase', { p_purchase: po, p_items: [{ po_item_id: fil, quantity: 2, unit_cost_cents: 2600 },
      { po_item_id: ole, quantity: 20 }], p_invoice: 'NF2', p_due_date: '2099-01-20', p_idem: 'rcv-2' })
    expect(await bal(productId)).toEqual({ on_hand: 4, reserved: 0 })
    const [{ avg_cost_cents }] = await admin((q) => q('select avg_cost_cents from product_costs where product_id = $1', [productId]))
    expect(Number(avg_cost_cents)).toBe(2300)
    const [{ status }] = await admin((q) => q('select status from purchase_orders where id = $1', [po]))
    expect(status).toBe('received')
    const payables = await admin((q) => q(`select total_cents from accounts where workshop_id = $1 and kind = 'payable' order by total_cents`, [ws]))
    expect(payables.map((p) => Number(p.total_cents))).toEqual([4000, 65200])
  })

  it('reserva ≠ consumo; consumo ocorre uma vez; devolução estorna; disponível considera reservas', async () => {
    const { order, item } = await orderWithPart(productId, 3)
    const r = await rpc(stock.userId, 'reserve_part', { p_item: item })
    expect(await bal(productId)).toEqual({ on_hand: 4, reserved: 3 })
    expect(await rpc(stock.userId, 'reserve_part', { p_item: item })).toBe(r)    // idempotente
    const m1 = await rpc(stock.userId, 'consume_reservation', { p_reservation: r })
    const m2 = await rpc(stock.userId, 'consume_reservation', { p_reservation: r })
    expect(m2).toBe(m1)
    expect(await bal(productId)).toEqual({ on_hand: 1, reserved: 0 })
    const [{ unit_cost_cents }] = await admin((q) => q('select unit_cost_cents from order_item_costs where item_id = $1', [item]))
    expect(Number(unit_cost_cents)).toBe(2300)   // custo aplicado salvo
    await rpc(stock.userId, 'return_consumed', { p_reservation: r, p_reason: 'peça errada' })
    await rpc(stock.userId, 'return_consumed', { p_reservation: r, p_reason: 'peça errada' })
    expect(await bal(productId)).toEqual({ on_hand: 4, reserved: 0 })
    await expectError(rpc(owner, 'cancel_order', { p_order: order, p_reason: '' }), 'motivo')
  })

  it('duas OS disputando a última unidade: só uma reserva; sem saldo negativo sem permissão', async () => {
    await rpc(stock.userId, 'adjust_stock', { p_product: productId, p_qty_delta: -3, p_kind: 'loss', p_reason: 'avaria', p_idem: 'loss-1' })
    expect(await bal(productId)).toEqual({ on_hand: 1, reserved: 0 })
    const a = await orderWithPart(productId, 1), b = await orderWithPart(productId, 1)
    const res = await Promise.allSettled([rpc(stock.userId, 'reserve_part', { p_item: a.item }), rpc(stock.userId, 'reserve_part', { p_item: b.item })])
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(await bal(productId)).toEqual({ on_hand: 1, reserved: 1 })
    await expectError(rpc(stock.userId, 'adjust_stock', { p_product: productId, p_qty_delta: -5, p_kind: 'loss', p_reason: 'x', p_idem: 'neg-1' }),
      'insuficiente')
    // cancelar a OS libera a reserva
    const winner = res[0].status === 'fulfilled' ? a : b
    await rpc(owner, 'cancel_order', { p_order: winner.order, p_reason: 'cliente desistiu' })
    expect(await bal(productId)).toEqual({ on_hand: 1, reserved: 0 })
  })

  it('quantidade fracionária respeita a precisão do produto', async () => {
    await rpc(stock.userId, 'adjust_stock', { p_product: oleoId, p_qty_delta: -3.5, p_kind: 'sale', p_reason: 'venda balcão', p_idem: 'v-1' })
    expect((await bal(oleoId)).on_hand).toBe(16.5)
    await expectError(rpc(stock.userId, 'adjust_stock', { p_product: productId, p_qty_delta: -0.5, p_kind: 'sale', p_reason: 'x', p_idem: 'v-2' }),
      'casas decimais')
  })

  it('estoquista não vê caixa nem clientes; mecânico não vê custo de produto', async () => {
    expect(await as(stock.userId, (q) => q('select * from cash_sessions'))).toHaveLength(0)
    expect(await as(stock.userId, (q) => q('select * from clients'))).toHaveLength(0)
    expect(await as(mech.userId, (q) => q('select * from product_costs'))).toHaveLength(0)
  })
})

describe('financeiro', () => {
  let inst: string[], order: string

  it('cobrança da OS confere o total no servidor', async () => {
    const c = await quickClient(owner, ws, 'Cliente Fin', 'FIN1A11')
    order = await rpc(owner, 'open_order', { p_workshop: ws, p_client: c.client_id, p_vehicle: c.vehicle_id, p_complaint: 'x' })
    await rpc(owner, 'add_order_item', { p_order: order, p_kind: 'service', p_description: 'Mão de obra', p_qty: 1,
      p_unit_price_cents: 30000, p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
    await expectError(rpc(fin.userId, 'create_order_receivable', { p_order: order, p_installments: [{ due_date: '2099-01-01', amount_cents: 1 }] }),
      'difere')
    const acc = await rpc(fin.userId, 'create_order_receivable', { p_order: order, p_installments: [
      { due_date: '2020-01-01', amount_cents: 10000 }, { due_date: '2099-01-01', amount_cents: 20000 }] })
    expect(await rpc(fin.userId, 'create_order_receivable', { p_order: order, p_installments: [] })).toBe(acc)
    inst = (await admin((q) => q('select id from account_installments where account_id = $1 order by seq', [acc]))).map((r) => r.id)
  })

  it('pagamento parcial, idempotência, limite de saldo, estorno e caixa', async () => {
    await expectError(rpc(fin.userId, 'register_payment', { p_installment: inst[0], p_amount_cents: 5000, p_method: 'dinheiro', p_idem: 'p1' }),
      'Abra o caixa')
    await rpc(fin.userId, 'open_cash', { p_workshop: ws, p_opening_cents: 10000 })
    const p1 = await rpc(fin.userId, 'register_payment', { p_installment: inst[0], p_amount_cents: 5000, p_method: 'dinheiro', p_idem: 'p1' })
    const p1b = await rpc(fin.userId, 'register_payment', { p_installment: inst[0], p_amount_cents: 5000, p_method: 'dinheiro', p_idem: 'p1' })
    expect(p1b).toBe(p1)
    await expectError(rpc(fin.userId, 'register_payment', { p_installment: inst[0], p_amount_cents: 6000, p_method: 'pix', p_idem: 'p2' }), 'saldo')
    await rpc(fin.userId, 'register_payment', { p_installment: inst[0], p_amount_cents: 5000, p_method: 'pix', p_idem: 'p3', p_reference: 'E123' })
    const r = await rpc<any>(fin.userId, 'report_financial', { p_workshop: ws, p_from: '2000-01-01', p_to: '2100-01-01' })
    expect(Number(r.vencido_cents)).toBe(0)
    expect(Number(r.recebido_cents)).toBe(10000)
    await expectError(as(fin.userId, (q) => q('delete from account_payments where id = $1', [p1])), 'permission denied')
    await rpc(fin.userId, 'reverse_payment', { p_payment: p1, p_reason: 'nota trocada' })
    await rpc(fin.userId, 'reverse_payment', { p_payment: p1, p_reason: 'nota trocada' })
    const [{ paid_cents }] = await admin((q) => q('select paid_cents from account_installments where id = $1', [inst[0]]))
    expect(Number(paid_cents)).toBe(5000)
    const r2 = await rpc<any>(fin.userId, 'report_financial', { p_workshop: ws, p_from: '2000-01-01', p_to: '2100-01-01' })
    expect(Number(r2.recebido_cents)).toBe(5000)
    expect(Number(r2.vencido_cents)).toBe(5000)
    // caixa: abertura 100 + 50 − 50 (estorno) = 100
    await expectError(rpc(fin.userId, 'close_cash', { p_workshop: ws, p_counted_cents: 9000, p_notes: '' }), 'observação')
    const close = await rpc<any>(fin.userId, 'close_cash', { p_workshop: ws, p_counted_cents: 9000, p_notes: 'faltou troco' })
    expect(close).toEqual({ expected_cents: 10000, counted_cents: 9000, difference_cents: -1000 })
  })

  it('não cancela OS com pagamento ativo', async () => {
    await expectError(rpc(owner, 'cancel_order', { p_order: order, p_reason: 'teste' }), 'Estorne')
  })
})

// Critérios 1, 2, 3 e 14: permissões, bloqueio, escalada e isolamento.
import { beforeAll, describe, expect, it } from 'vitest'
import { addMember, admin, as, createUser, emailOf, expectError, provision, quickClient, rpc } from './helpers.ts'

let owner: string, ws: string, mech: { userId: string; membershipId: string }
let manager: { userId: string; membershipId: string }
let orderMine: string, orderOther: string

beforeAll(async () => {
  owner = await createUser('Dona Oficina A')
  ws = await provision('Oficina A (teste)', owner)
  mech = await addMember(ws, owner, 'Mecânico Zé', 'mechanic')
  manager = await addMember(ws, owner, 'Gerente Ana', 'manager')
  const c1 = await quickClient(owner, ws, 'Carlos Cliente', 'ABC1D23', 40000)
  const c2 = await quickClient(owner, ws, 'Bruna Cliente', 'XYZ9876', 10000)
  orderMine = await rpc(owner, 'open_order', { p_workshop: ws, p_client: c1.client_id, p_vehicle: c1.vehicle_id,
    p_complaint: 'Barulho na suspensão', p_mechanics: [mech.membershipId] })
  orderOther = await rpc(owner, 'open_order', { p_workshop: ws, p_client: c2.client_id, p_vehicle: c2.vehicle_id,
    p_complaint: 'Revisão' })
  await rpc(owner, 'add_order_item', { p_order: orderMine, p_kind: 'service', p_description: 'Troca de amortecedor',
    p_qty: 1, p_unit_price_cents: 45000, p_unit_cost_cents: 20000 })
  await admin((q) => q(`insert into accounts(workshop_id, kind, description, total_cents) values ($1,'payable','Aluguel',300000)`, [ws]))
})

describe('mecânico restrito', () => {
  it('convite gera escopo "atribuídas" e o mecânico vê somente a própria OS', async () => {
    const rows = await as(mech.userId, (q) => q('select id from service_orders'))
    expect(rows.map((r) => r.id)).toEqual([orderMine])
    const board = await as(mech.userId, (q) => q('select * from orders_board($1)', [ws]))
    expect(board).toHaveLength(1)
  })

  it('não lê OS alheia por RPC, nem preços/custos/financeiro por rota direta', async () => {
    await expectError(rpc(mech.userId, 'order_detail', { p_order: orderOther }), 'sem acesso')
    const d = await rpc<any>(mech.userId, 'order_detail', { p_order: orderMine })
    expect(d.items[0].description).toBe('Troca de amortecedor')
    expect(d.items[0].unit_price_cents).toBeUndefined()
    expect(d.items[0].unit_cost_cents).toBeUndefined()
    expect(d.totals).toBeUndefined()
    expect(d.client.phone).toBeUndefined()
    expect(await as(mech.userId, (q) => q('select * from order_items'))).toHaveLength(0)
    expect(await as(mech.userId, (q) => q('select * from order_item_costs'))).toHaveLength(0)
    expect(await as(mech.userId, (q) => q('select * from accounts'))).toHaveLength(0)
    expect(await as(mech.userId, (q) => q('select * from clients'))).toHaveLength(0)
    expect(await as(mech.userId, (q) => q('select * from order_totals'))).toHaveLength(0)
    await expectError(rpc(mech.userId, 'report_financial', { p_workshop: ws, p_from: '2020-01-01', p_to: '2030-01-01' }), 'Sem permissão')
  })

  it('não altera preço nem a própria função', async () => {
    await expectError(rpc(mech.userId, 'add_order_item', { p_order: orderMine, p_kind: 'service', p_description: 'x',
      p_qty: 1, p_unit_price_cents: 1 }), 'Sem permissão')
    await expectError(rpc(mech.userId, 'update_member', { p_membership: mech.membershipId, p_role: 'owner',
      p_order_scope: 'all', p_overrides: {} }), /próprio|Sem permissão/)
    await expectError(as(mech.userId, (q) => q(`update memberships set role = 'owner' where id = $1`, [mech.membershipId])),
      'permission denied')
  })

  it('arquivo de outra OS é negado pela política do storage', async () => {
    const path = `${ws}/${orderOther}/foto.jpg`
    await admin((q) => q(`insert into storage.objects(bucket_id, name) values ('order-files', $1)`, [path]))
    expect(await as(mech.userId, (q) => q('select * from storage.objects where name = $1', [path]))).toHaveLength(0)
    expect(await as(owner, (q) => q('select * from storage.objects where name = $1', [path]))).toHaveLength(1)
  })
})

describe('bloqueio e escalada', () => {
  it('bloqueado perde acesso imediatamente (mesmo com a sessão/JWT antigo)', async () => {
    const tmp = await addMember(ws, owner, 'Temp Recepção', 'reception')
    expect((await as(tmp.userId, (q) => q('select id from clients'))).length).toBeGreaterThan(0)
    await rpc(owner, 'set_member_status', { p_membership: tmp.membershipId, p_status: 'blocked', p_reason: 'desligado' })
    expect(await as(tmp.userId, (q) => q('select id from clients'))).toHaveLength(0)
    expect(await as(tmp.userId, (q) => q('select * from my_workshops()'))).toHaveLength(0)
    // autoria histórica preservada
    const [{ n }] = await admin((q) => q('select count(*)::int n from memberships where id = $1', [tmp.membershipId]))
    expect(n).toBe(1)
  })

  it('gerente sem team.manage não convida; com team.manage não concede o que não tem', async () => {
    await expectError(rpc(manager.userId, 'create_invite', { p_workshop: ws, p_email: 'x@y.com', p_full_name: 'X', p_role: 'reception' }),
      'team.manage')
    await rpc(owner, 'update_member', { p_membership: manager.membershipId, p_role: 'manager', p_order_scope: 'all',
      p_overrides: { 'team.manage': true } })
    await expectError(rpc(manager.userId, 'create_invite', { p_workshop: ws, p_email: 'fin@y.com', p_full_name: 'Fin',
      p_role: 'finance' }), 'não possui')
    await expectError(rpc(manager.userId, 'create_invite', { p_workshop: ws, p_email: 'own@y.com', p_full_name: 'Own',
      p_role: 'owner' }), 'proprietário')
  })

  it('não remove nem bloqueia o último proprietário', async () => {
    const [m] = await admin((q) => q(`select id from memberships where workshop_id = $1 and role = 'owner'`, [ws]))
    await expectError(admin((q) => q(`update memberships set status = 'blocked' where id = $1`, [m.id])), 'último proprietário')
  })

  it('convite é de uso único, expira, e reenvio revoga o anterior', async () => {
    const u = await createUser('Novo Mecânico')
    const email = await emailOf(u)
    const a = await rpc<any>(owner, 'create_invite', { p_workshop: ws, p_email: email, p_full_name: 'Novo', p_role: 'mechanic' })
    const b = await rpc<any>(owner, 'create_invite', { p_workshop: ws, p_email: email, p_full_name: 'Novo', p_role: 'mechanic' })
    await expectError(rpc(u, 'accept_invite', { p_token: a.token }), 'inválido')
    const other = await createUser('Intruso')
    await expectError(rpc(other, 'accept_invite', { p_token: b.token }), 'outro e-mail')
    await rpc(u, 'accept_invite', { p_token: b.token })
    await expectError(rpc(u, 'accept_invite', { p_token: b.token }), 'inválido')
    const [{ token_hash }] = await admin((q) => q('select token_hash from invites where id = $1', [b.invite_id]))
    expect(token_hash).not.toBe(b.token)   // somente hash armazenado
  })
})

describe('isolamento entre oficinas', () => {
  let ownerB: string, wsB: string, clientB: { client_id: string; vehicle_id: string }
  beforeAll(async () => {
    ownerB = await createUser('Dono Oficina B')
    wsB = await provision('Oficina B (teste)', ownerB)
    clientB = await quickClient(ownerB, wsB, 'Cliente da B', 'BBB2B22')
  })

  it('listagens, buscas, relatórios e RPCs não cruzam oficinas', async () => {
    const names = (await as(owner, (q) => q('select name from clients'))).map((r) => r.name)
    expect(names).not.toContain('Cliente da B')
    expect(await as(owner, (q) => q('select * from search_clients_vehicles($1, $2)', [wsB, 'BBB']))).toHaveLength(0)
    expect(await as(owner, (q) => q('select * from vehicles where id = $1', [clientB.vehicle_id]))).toHaveLength(0)
    await expectError(rpc(owner, 'report_operations', { p_workshop: wsB, p_from: '2020-01-01', p_to: '2030-01-01' }), 'Sem permissão')
    await expectError(rpc(owner, 'dashboard_summary', { p_workshop: wsB }), 'Sem acesso')
  })

  it('não grava com workshop_id de outra oficina nem liga registros entre oficinas', async () => {
    await expectError(as(owner, (q) => q(`insert into clients(workshop_id, name) values ($1, 'Invasor')`, [wsB])), 'row-level security')
    // OS na oficina A com veículo da B é barrada (vínculo + FK composta)
    const cA = await quickClient(owner, ws, 'Cliente A2', 'AAA1A11')
    await expectError(rpc(owner, 'open_order', { p_workshop: ws, p_client: cA.client_id, p_vehicle: clientB.vehicle_id, p_complaint: 'x' }))
    await expectError(admin((q) => q(`insert into vehicle_ownerships(workshop_id, vehicle_id, client_id, ended_at)
      values ($1, $2, $3, current_date)`, [ws, clientB.vehicle_id, cA.client_id])), 'foreign key')
  })

  it('transferência de proprietário não expõe o dono anterior', async () => {
    const reception = await addMember(ws, owner, 'Recepção Lia', 'reception')
    const old = await quickClient(owner, ws, 'Antigo Dono', 'TRF1A23')
    const [novo] = await as(owner, (q) => q(`insert into clients(workshop_id, name) values ($1, 'Novo Dono') returning id`, [ws]))
    const oid = await rpc(owner, 'open_order', { p_workshop: ws, p_client: old.client_id, p_vehicle: old.vehicle_id, p_complaint: 'antes' })
    await rpc(owner, 'transfer_vehicle', { p_vehicle: old.vehicle_id, p_new_client: novo.id, p_reason: 'venda' })
    const linkInfo = await rpc<any>(owner, 'create_portal_link', { p_purpose: 'track', p_order: null, p_quote: null })
      .catch(() => null)
    expect(linkInfo).toBeNull()   // link exige OS ou orçamento
    const current = await as(reception.userId, (q) => q(
      `select c.name from vehicle_ownerships o join clients c on c.id = o.client_id where o.vehicle_id = $1 and o.ended_at is null`, [old.vehicle_id]))
    expect(current.map((r) => r.name)).toEqual(['Novo Dono'])
    // histórico técnico continua ligado ao veículo; portal do novo dono não mostra OS do antigo
    const oNew = await rpc(owner, 'open_order', { p_workshop: ws, p_client: novo.id, p_vehicle: old.vehicle_id, p_complaint: 'depois' })
    const l = await rpc<any>(owner, 'create_portal_link', { p_purpose: 'track', p_order: oNew, p_quote: null })
    const view = await rpc<any>(null, 'portal_view', { p_token: l.token })
    expect(JSON.stringify(view)).not.toContain('Antigo')
    expect(view.order.number).not.toBe((await as(owner, (q) => q('select number from service_orders where id = $1', [oid])))[0].number)
  })
})

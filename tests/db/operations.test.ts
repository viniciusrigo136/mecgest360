// Critérios 4, 5, 6 e 13: recepção, agenda, OS, orçamento, aprovação e portal.
import { beforeAll, describe, expect, it } from 'vitest'
import { addMember, admin, as, createUser, expectError, provision, rpc } from './helpers.ts'

let owner: string, ws: string, rec: { userId: string; membershipId: string }
let mech: { userId: string; membershipId: string }
let clientId: string, car1: string, car2: string, box1: string

// Segunda-feira 10/11/2025 10:00 em São Paulo (13:00 UTC)
const MON_10H = '2025-11-10T13:00:00Z'
const MON_11H = '2025-11-10T14:00:00Z'
const MON_1030 = '2025-11-10T13:30:00Z'
const MON_1130 = '2025-11-10T14:30:00Z'

beforeAll(async () => {
  owner = await createUser('Dono Ops')
  ws = await provision('Oficina Ops (teste)', owner)
  rec = await addMember(ws, owner, 'Recepção Bia', 'reception')
  mech = await addMember(ws, owner, 'Mecânico Léo', 'mechanic')
  const [r] = await admin((q) => q(`select id from resources where workshop_id = $1 and name = 'Box 1'`, [ws]))
  box1 = r.id
})

describe('recepção e agenda', () => {
  it('recepção cadastra cliente com dois carros', async () => {
    const a = await rpc<any>(rec.userId, 'quick_register', { p_workshop: ws, p_client: { name: 'Marta Souza', phone: '11 97777-1111' },
      p_vehicle: { plate: 'MRT-1A23', model: 'Onix', brand: 'Chevrolet' }, p_km: 52000 })
    clientId = a.client_id; car1 = a.vehicle_id
    const b = await rpc<any>(rec.userId, 'quick_register', { p_workshop: ws, p_client: { id: clientId },
      p_vehicle: { plate: 'mrt9z88', model: 'HB20', brand: 'Hyundai' } })
    car2 = b.vehicle_id
    expect(b.client_id).toBe(clientId)
    const vs = await as(rec.userId, (q) => q(`select plate_norm from vehicles v join vehicle_ownerships o on o.vehicle_id = v.id
       where o.client_id = $1 order by plate_norm`, [clientId]))
    expect(vs.map((v) => v.plate_norm)).toEqual(['MRT1A23', 'MRT9Z88'])
  })

  it('placa inválida é recusada; exceção justificada é aceita; sem placa gera código interno', async () => {
    await expectError(as(rec.userId, (q) => q(`insert into vehicles(workshop_id, plate, model) values ($1, 'AB-12', 'X')`, [ws])), 'check')
    await as(rec.userId, (q) => q(`insert into vehicles(workshop_id, plate, plate_exception, model) values ($1, 'AR123XY', 'Placa argentina', 'Gol')`, [ws]))
    const [v] = await as(rec.userId, (q) => q(`insert into vehicles(workshop_id, model) values ($1, 'Sem placa') returning internal_code`, [ws]))
    expect(v.internal_code).toMatch(/^TMP-\d{5}$/)
  })

  it('bloqueia sobreposição de box e fora do horário; exceção exige permissão', async () => {
    const a1 = await rpc(rec.userId, 'save_appointment', { p_workshop: ws, p_id: null, p_client: clientId, p_vehicle: car1,
      p_service: null, p_description: 'Revisão', p_starts_at: MON_10H, p_ends_at: MON_11H, p_member: null, p_resource: box1 })
    expect(a1).toBeTruthy()
    await expectError(rpc(rec.userId, 'save_appointment', { p_workshop: ws, p_id: null, p_client: clientId, p_vehicle: car2,
      p_service: null, p_description: 'Outro', p_starts_at: MON_1030, p_ends_at: MON_1130, p_member: null, p_resource: box1 }), 'Conflito')
    await expectError(rpc(rec.userId, 'save_appointment', { p_workshop: ws, p_id: null, p_client: clientId, p_vehicle: car2,
      p_service: null, p_description: 'Madrugada', p_starts_at: '2025-11-10T05:00:00Z', p_ends_at: '2025-11-10T06:00:00Z',
      p_member: null, p_resource: null }), 'horário de funcionamento')
    await expectError(rpc(rec.userId, 'save_appointment', { p_workshop: ws, p_id: null, p_client: clientId, p_vehicle: car2,
      p_service: null, p_description: 'Encaixe', p_starts_at: MON_1030, p_ends_at: MON_1130, p_member: null, p_resource: box1,
      p_override_reason: 'cliente urgente' }), 'Sem permissão')
    const enc = await rpc(owner, 'save_appointment', { p_workshop: ws, p_id: null, p_client: clientId, p_vehicle: car2,
      p_service: null, p_description: 'Encaixe', p_starts_at: MON_1030, p_ends_at: MON_1130, p_member: null, p_resource: box1,
      p_override_reason: 'cliente urgente, autorizado' })
    expect(enc).toBeTruthy()
  })

  it('converte agendamento em OS uma única vez (cliques repetidos)', async () => {
    const [a] = await as(rec.userId, (q) => q(`select id from appointments where description = 'Revisão'`))
    const [o1, o2] = await Promise.all([
      rpc(rec.userId, 'convert_appointment', { p_appointment: a.id, p_km: 52100 }),
      rpc(rec.userId, 'convert_appointment', { p_appointment: a.id, p_km: 52100 }).catch((e) => e.message),
    ])
    const o3 = await rpc(rec.userId, 'convert_appointment', { p_appointment: a.id, p_km: 52100 })
    expect(o3).toBe(o1)
    const n = await admin((q) => q('select count(*)::int n from service_orders where appointment_id = $1', [a.id]))
    expect(n[0].n).toBe(1)
    expect([o1, o2].filter((x) => typeof x === 'string' && x.length === 36).every((x) => x === o1)).toBe(true)
  })

  it('reagendamento preserva histórico e cancelamento exige motivo', async () => {
    const [a] = await as(rec.userId, (q) => q(`select * from appointments where description = 'Encaixe'`))
    await expectError(rpc(rec.userId, 'set_appointment_status', { p_id: a.id, p_status: 'cancelled' }), 'motivo')
    await rpc(rec.userId, 'set_appointment_status', { p_id: a.id, p_status: 'cancelled', p_reason: 'cliente desistiu' })
    const [after] = await as(rec.userId, (q) => q('select status, cancel_reason from appointments where id = $1', [a.id]))
    expect(after).toEqual({ status: 'cancelled', cancel_reason: 'cliente desistiu' })
  })
})

describe('orçamento, aprovação e OS', () => {
  let orderId: string, quoteId: string, items: any[]

  it('orçamento parcial preserva recusados como recomendação e aprovação repetida não duplica', async () => {
    orderId = await rpc(rec.userId, 'open_order', { p_workshop: ws, p_client: clientId, p_vehicle: car2, p_complaint: 'Freio chiando',
      p_km: 30000, p_mechanics: [mech.membershipId] })
    quoteId = await rpc(rec.userId, 'save_quote', { p_workshop: ws, p_quote: null, p_client: clientId, p_vehicle: car2, p_order: orderId,
      p_valid_until: '2099-12-31', p_items: [
        { kind: 'service', description: 'Troca pastilhas', quantity: 1, unit_price_cents: 18000 },
        { kind: 'part', description: 'Pastilha dianteira', quantity: 1, unit_price_cents: 22000 },
        { kind: 'service', description: 'Troca fluido de freio', quantity: 1, unit_price_cents: 9000 }] })
    await rpc(rec.userId, 'send_quote', { p_quote: quoteId })
    items = await as(rec.userId, (q) => q(`select i.* from quote_items i join quotes q on q.current_version_id = i.version_id
       where q.id = $1 order by sort, description`, [quoteId]))
    const approve = items.filter((i) => i.description !== 'Troca fluido de freio').map((i) => i.id)
    const d1 = await rpc(rec.userId, 'record_quote_decision', { p_quote: quoteId, p_approved: approve, p_channel: 'telefone',
      p_name: 'Marta', p_note: 'ligou às 10h' })
    expect(d1).toBe('partially_approved')
    const d2 = await rpc(rec.userId, 'record_quote_decision', { p_quote: quoteId, p_approved: approve, p_channel: 'telefone',
      p_name: 'Marta', p_note: 'repetido' })
    expect(d2).toBe('partially_approved')
    await expectError(rpc(rec.userId, 'record_quote_decision', { p_quote: quoteId, p_approved: [], p_channel: 'telefone',
      p_name: 'Marta', p_note: 'contraditório' }), 'decisão diferente')
    const oi = await admin((q) => q(`select description, status from order_items where order_id = $1 order by description`, [orderId]))
    expect(oi).toEqual([{ description: 'Pastilha dianteira', status: 'approved' }, { description: 'Troca pastilhas', status: 'approved' }])
    const recs = await admin((q) => q(`select description from recommendations where order_id = $1`, [orderId]))
    expect(recs.map((r) => r.description)).toEqual(['Troca fluido de freio'])
    const [o] = await admin((q) => q('select status from service_orders where id = $1', [orderId]))
    expect(o.status).toBe('approved')
  })

  it('versão enviada é imutável; alterar preço cria nova versão e a antiga não pode mais ser aprovada', async () => {
    const q2 = await rpc(rec.userId, 'save_quote', { p_workshop: ws, p_quote: null, p_client: clientId, p_vehicle: car1, p_order: null,
      p_valid_until: '2099-12-31', p_items: [{ kind: 'service', description: 'Alinhamento', quantity: 1, unit_price_cents: 12000 }] })
    await rpc(rec.userId, 'send_quote', { p_quote: q2 })
    const link = await rpc<any>(rec.userId, 'create_portal_link', { p_purpose: 'approve', p_order: null, p_quote: q2 })
    await expectError(admin((q) => q(`update quote_items set unit_price_cents = 1 where version_id =
       (select current_version_id from quotes where id = $1)`, [q2])), 'imutável')
    await rpc(rec.userId, 'save_quote', { p_workshop: ws, p_quote: q2, p_client: clientId, p_vehicle: car1, p_order: null,
      p_valid_until: '2099-12-31', p_items: [{ kind: 'service', description: 'Alinhamento', quantity: 1, unit_price_cents: 15000 }] })
    const vs = await admin((q) => q(`select version_no, status, total_cents from quote_versions where quote_id = $1 order by version_no`, [q2]))
    expect(vs).toEqual([{ version_no: 1, status: 'superseded', total_cents: '12000' }, { version_no: 2, status: 'draft', total_cents: '15000' }])
    // link antigo revogado ao substituir
    await expectError(rpc(null, 'portal_decide', { p_token: link.token, p_code: link.code, p_approved: [], p_name: 'X', p_confirm: true }), 'inválido')
  })

  it('portal: código errado bloqueia após 5 tentativas; código certo aprova; vencido não aprova', async () => {
    const q3 = await rpc(rec.userId, 'save_quote', { p_workshop: ws, p_quote: null, p_client: clientId, p_vehicle: car1, p_order: null,
      p_valid_until: '2099-12-31', p_items: [{ kind: 'service', description: 'Higienização', quantity: 1, unit_price_cents: 8000 }] })
    await rpc(rec.userId, 'send_quote', { p_quote: q3 })
    const link = await rpc<any>(rec.userId, 'create_portal_link', { p_purpose: 'approve', p_order: null, p_quote: q3 })
    const view = await rpc<any>(null, 'portal_view', { p_token: link.token })
    expect(view.quote.can_decide).toBe(true)
    const itemId = view.quote.items[0].id
    const wrong = await rpc<any>(null, 'portal_decide', { p_token: link.token, p_code: '000000', p_approved: [itemId], p_name: 'Marta', p_confirm: true })
    expect(wrong).toEqual({ ok: false, error: 'codigo_incorreto', attempts_left: 4 })
    const d = await rpc<any>(null, 'portal_decide', { p_token: link.token, p_code: link.code, p_approved: [itemId], p_name: 'Marta', p_confirm: true })
    expect(d).toEqual({ ok: true, decision: 'approved' })
    const [dec] = await admin((q) => q(`select channel, evidence from quote_decisions d join quotes q on q.current_version_id = d.version_id where q.id = $1`, [q3]))
    expect(dec.channel).toBe('portal')
    expect(dec.evidence.code_verified).toBe(true)
    // brute force
    const q4 = await rpc(rec.userId, 'save_quote', { p_workshop: ws, p_quote: null, p_client: clientId, p_vehicle: car1, p_order: null,
      p_valid_until: '2099-12-31', p_items: [{ kind: 'service', description: 'Polimento', quantity: 1, unit_price_cents: 30000 }] })
    await rpc(rec.userId, 'send_quote', { p_quote: q4 })
    const l4 = await rpc<any>(rec.userId, 'create_portal_link', { p_purpose: 'approve', p_order: null, p_quote: q4 })
    for (let i = 0; i < 5; i++) await rpc(null, 'portal_decide', { p_token: l4.token, p_code: 'errado', p_approved: [], p_name: 'X', p_confirm: true }).catch(() => {})
    await expectError(rpc(null, 'portal_decide', { p_token: l4.token, p_code: l4.code, p_approved: [], p_name: 'X', p_confirm: true }), 'inválido')
    // vencido
    const q5 = await rpc(rec.userId, 'save_quote', { p_workshop: ws, p_quote: null, p_client: clientId, p_vehicle: car1, p_order: null,
      p_valid_until: new Date().toISOString().slice(0, 10), p_items: [{ kind: 'service', description: 'Vencido', quantity: 1, unit_price_cents: 100 }] })
    await rpc(rec.userId, 'send_quote', { p_quote: q5 })
    await admin((q) => q(`alter table quote_versions disable trigger trg_quote_version_guard;
      update quote_versions set valid_until = current_date - 2 where quote_id = '${q5}';
      alter table quote_versions enable trigger trg_quote_version_guard;`))
    await expectError(rpc(rec.userId, 'record_quote_decision', { p_quote: q5, p_approved: [], p_channel: 'telefone', p_name: 'X', p_note: '' }), 'vencido')
  })

  it('portal de acompanhamento nunca expõe notas internas, custos ou outros atendimentos', async () => {
    await rpc(owner, 'update_order', { p_order: orderId, p_expected_version: (await admin((q) => q('select version from service_orders where id = $1', [orderId])))[0].version,
      p_fields: { notes_internal: 'SEGREDO-INTERNO cliente difícil', notes_client: 'Previsão amanhã' } })
    const l = await rpc<any>(rec.userId, 'create_portal_link', { p_purpose: 'track', p_order: orderId, p_quote: null })
    const v = await rpc<any>(null, 'portal_view', { p_token: l.token })
    const s = JSON.stringify(v)
    expect(s).not.toContain('SEGREDO-INTERNO')
    expect(s).not.toContain('cost')
    expect(s).not.toContain('MRT9Z88')     // placa mascarada
    expect(v.order.notes_client).toBe('Previsão amanhã')
    await rpc(rec.userId, 'revoke_portal_link', { p_link: l.link_id })
    await expectError(rpc(null, 'portal_view', { p_token: l.token }), 'inválido')
    await expectError(rpc(null, 'portal_view', { p_token: 'curto' }), 'inválido')
    // anon não acessa tabelas
    await expectError(as(null, (q) => q('select * from service_orders')), 'permission denied')
  })

  it('edição concorrente da OS gera conflito (sem sobrescrita silenciosa)', async () => {
    const [{ version }] = await admin((q) => q('select version from service_orders where id = $1', [orderId]))
    await rpc(owner, 'update_order', { p_order: orderId, p_expected_version: version, p_fields: { diagnosis: 'Disco empenado' } })
    await expectError(rpc(rec.userId, 'update_order', { p_order: orderId, p_expected_version: version, p_fields: { complaint: 'outra' } }),
      'outra pessoa')
  })

  it('execução: mecânico não executa item não aprovado; "pronta" exige revisão, checklist e decisão preventiva', async () => {
    await rpc(mech.userId, 'order_transition', { p_order: orderId, p_to: 'in_progress' })
    const d = await rpc<any>(mech.userId, 'order_detail', { p_order: orderId })
    for (const it of d.items) await rpc(mech.userId, 'set_item_progress', { p_item: it.id, p_status: 'done' })
    // aditivo após aprovação fica pendente
    const add = await rpc(owner, 'add_order_item', { p_order: orderId, p_kind: 'service', p_description: 'Sangria extra', p_qty: 1, p_unit_price_cents: 5000 })
    await expectError(rpc(mech.userId, 'set_item_progress', { p_item: add, p_status: 'done' }), 'não aprovado')
    await rpc(owner, 'cancel_order_item', { p_item: add, p_reason: 'cliente não quis' })
    // timer único
    const t = await rpc(mech.userId, 'timer_start', { p_order: orderId })
    await expectError(rpc(mech.userId, 'timer_start', { p_order: orderId }), 'apontamento em andamento')
    await rpc(mech.userId, 'order_transition', { p_order: orderId, p_to: 'quality_check' })
    await expectError(rpc(mech.userId, 'order_transition', { p_order: orderId, p_to: 'ready' }), /Confirme|checklist|apontamento|preventivo/)
    await rpc(mech.userId, 'timer_stop', { p_entry: t })
    await rpc(mech.userId, 'confirm_items_review', { p_order: orderId })
    const ck = (await rpc<any>(mech.userId, 'order_detail', { p_order: orderId })).checklists.quality
    await expectError(rpc(mech.userId, 'save_checklist', { p_order: orderId, p_kind: 'quality', p_items: ck.items, p_belongings: null, p_complete: true }), 'Preencha')
    await rpc(mech.userId, 'save_checklist', { p_order: orderId, p_kind: 'quality', p_items: ck.items.map((i: any) => ({ ...i, state: 'ok' })),
      p_belongings: null, p_complete: true, p_test_notes: 'Rodou 5 km ok' })
    await expectError(rpc(mech.userId, 'order_transition', { p_order: orderId, p_to: 'ready' }), 'preventivo')
    const [{ version }] = await admin((q) => q('select version from service_orders where id = $1', [orderId]))
    await rpc(owner, 'update_order', { p_order: orderId, p_expected_version: version, p_fields: { maintenance_decision: 'not_applicable' } })
    await rpc(mech.userId, 'order_transition', { p_order: orderId, p_to: 'ready' })
    // entrega exige cobrança ou registro de saldo
    await expectError(rpc(rec.userId, 'deliver_order', { p_order: orderId, p_notes: 'ok', p_payment_note: null }), 'cobrança')
    await expectError(rpc(owner, 'deliver_order', { p_order: orderId, p_notes: 'ok', p_payment_note: '', p_allow_balance: true }), 'situação de pagamento')
    await rpc(owner, 'deliver_order', { p_order: orderId, p_notes: 'ok', p_payment_note: 'Cliente paga na sexta (combinado)', p_allow_balance: true })
    // reabertura exige permissão e justificativa
    await expectError(rpc(rec.userId, 'reopen_order', { p_order: orderId, p_reason: 'x' }), 'Sem permissão')
    await expectError(rpc(owner, 'reopen_order', { p_order: orderId, p_reason: '' }), 'justificativa')
  })
})

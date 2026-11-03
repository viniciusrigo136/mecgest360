// Critérios 9, 10, 11 e 12: preventiva, km, consentimento e motor de envios.
import { beforeAll, describe, expect, it } from 'vitest'
import { admin, createUser, expectError, provision, quickClient, rpc } from './helpers.ts'

let owner: string, ws: string, car: { client_id: string; vehicle_id: string }

const techStatus = async (cycle: string) =>
  (await admin((q) => q('select * from cycle_technical_status($1)', [cycle])))[0]
const openCycle = async (plan: string) =>
  (await admin((q) => q(`select * from maintenance_cycles where plan_id = $1 and status = 'open'`, [plan])))[0]
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

async function deliverWith(component: string, km: number) {
  const o = await rpc(owner, 'open_order', { p_workshop: ws, p_client: car.client_id, p_vehicle: car.vehicle_id, p_complaint: 'Revisão',
    p_km: km })
  const it = await rpc(owner, 'add_order_item', { p_order: o, p_kind: 'service', p_description: `Serviço ${component}`, p_qty: 1,
    p_unit_price_cents: 10000, p_maintenance_component: component, p_onsite_authorization: { channel: 'presencial', authorized_by: 'Cliente' } })
  await rpc(owner, 'order_transition', { p_order: o, p_to: 'diagnosis' })
  await rpc(owner, 'order_transition', { p_order: o, p_to: 'approved' })
  await rpc(owner, 'order_transition', { p_order: o, p_to: 'in_progress' })
  await rpc(owner, 'set_item_progress', { p_item: it, p_status: 'done' })
  await rpc(owner, 'order_transition', { p_order: o, p_to: 'quality_check' })
  await rpc(owner, 'confirm_items_review', { p_order: o })
  const ck = (await rpc<any>(owner, 'order_detail', { p_order: o })).checklists.quality
  await rpc(owner, 'save_checklist', { p_order: o, p_kind: 'quality', p_items: ck.items.map((i: any) => ({ ...i, state: 'ok' })), p_belongings: null, p_complete: true })
  const [{ version }] = await admin((q) => q('select version from service_orders where id = $1', [o]))
  await rpc(owner, 'update_order', { p_order: o, p_expected_version: version, p_fields: { maintenance_decision: 'not_applicable' } })
  await rpc(owner, 'order_transition', { p_order: o, p_to: 'ready' })
  await rpc(owner, 'deliver_order', { p_order: o, p_notes: 'ok', p_payment_note: 'pago na hora', p_allow_balance: true })
  return o as string
}

beforeAll(async () => {
  owner = await createUser('Dono Preventiva')
  ws = await provision('Oficina Preventiva (teste)', owner)
  car = await quickClient(owner, ws, 'Paula Preventiva', 'PRV1A23')
  await admin((q) => q(`update clients set whatsapp = '11 91234-5678' where id = $1`, [car.client_id]))
})

describe('datas e quilometragem', () => {
  it('fim de mês e virada de ano têm cálculo definido', async () => {
    const r = await admin((q) => q(`select maintenance_target_date('2025-01-31', 1, 0) a, maintenance_target_date('2024-01-31', 1, 0) b,
      maintenance_target_date('2025-11-30', 3, 0) c, maintenance_target_date('2025-12-31', 6, 0) d, maintenance_target_date('2025-03-31', 0, 0) e`))
    expect(r[0].a.toISOString().slice(0, 10)).toBe('2025-02-28')
    expect(r[0].b.toISOString().slice(0, 10)).toBe('2024-02-29')
    expect(r[0].c.toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(r[0].d.toISOString().slice(0, 10)).toBe('2026-06-30')
    expect(r[0].e).toBeNull()
  })

  it('leitura regressiva exige justificativa e não apaga a anterior', async () => {
    await admin((q) => q(`insert into odometer_readings(workshop_id, vehicle_id, km, source, read_on) values ($1, $2, 50000, 'manual', $3)`,
      [ws, car.vehicle_id, daysAgo(200)]))
    await expectError(admin((q) => q(`insert into odometer_readings(workshop_id, vehicle_id, km, source) values ($1, $2, 40000, 'manual')`,
      [ws, car.vehicle_id])), 'menor que a última')
    await admin((q) => q(`insert into odometer_readings(workshop_id, vehicle_id, km, source, read_on, regression_justification)
      values ($1, $2, 49000, 'manual', $3, 'troca de painel')`, [ws, car.vehicle_id, daysAgo(199)]))
    await expectError(admin((q) => q(`update odometer_readings set km = 1 where vehicle_id = $1`, [car.vehicle_id])), 'não podem ser editadas')
  })

  it('km projetado aparece como "estimado", nunca como vencido', async () => {
    // 2 leituras reais: 50.000 há 200 dias e 54.000 há 100 dias → 40 km/dia
    await admin((q) => q(`update odometer_readings set invalidated_at = now(), invalidated_reason = 'teste' where vehicle_id = $1 and km = 49000`, [car.vehicle_id]))
    await admin((q) => q(`insert into odometer_readings(workshop_id, vehicle_id, km, source, read_on) values ($1, $2, 54000, 'manual', $3)`,
      [ws, car.vehicle_id, daysAgo(100)]))
    const plan = await rpc(owner, 'create_maintenance_plan', { p_vehicle: car.vehicle_id, p_component: 'correia', p_component_label: 'Correia dentada',
      p_action: 'inspecao', p_interval_months: 0, p_interval_days: 0, p_interval_km: 4000, p_rule: 'km_only', p_lead_days: 15, p_lead_km: 500,
      p_source: 'Avaliação do mecânico', p_notes: null, p_base_date: daysAgo(100), p_base_km: 54000 })
    const c = await openCycle(plan)
    const st = await techStatus(c.id)
    expect(st.projected_km).toBeGreaterThanOrEqual(57900)        // ~ 54.000 + 100 × 40; alvo 58.000, antecedência 500
    expect(st.status).toBe('estimated')
    expect(st.ask_km).toBe(true)
    // com leitura real acima do alvo → vencido por km confirmado
    await admin((q) => q(`insert into odometer_readings(workshop_id, vehicle_id, km, source) values ($1, $2, 59100, 'reception')`, [ws, car.vehicle_id]))
    expect((await techStatus(c.id)).status).toBe('overdue_km')
    // leitura informada pelo cliente (não confirmada) não conta
    await admin((q) => q(`insert into odometer_readings(workshop_id, vehicle_id, km, source, confirmed) values ($1, $2, 99000, 'client_portal', false)`, [ws, car.vehicle_id]))
    expect((await techStatus(c.id)).last_km).toBe(59100)
  })
})

describe('ciclos', () => {
  let plan: string

  it('agendamento ou pagamento não concluem; nova execução encerra o ciclo e cancela lembretes pendentes', async () => {
    plan = await rpc(owner, 'create_maintenance_plan', { p_vehicle: car.vehicle_id, p_component: 'oleo_motor', p_component_label: 'Óleo do motor',
      p_action: 'troca', p_interval_months: 6, p_interval_days: 0, p_interval_km: 10000, p_rule: 'first', p_lead_days: 30, p_lead_km: 1000,
      p_source: 'Manual do fabricante informado pelo cliente', p_notes: null, p_base_date: daysAgo(170), p_base_km: 50000 })
    const c1 = await openCycle(plan)
    expect((await techStatus(c1.id)).status).toBe('due_soon')
    // enfileira manualmente uma mensagem pendente do ciclo
    const [m] = await admin((q) => q(`insert into message_queue(workshop_id, client_id, purpose, template_key, rendered_body, to_phone, idempotency_key)
      values ($1, $2, 'maintenance_reminders', 'retorno_preventivo', 'oi', '5511912345678', 'k1') returning id`, [ws, car.client_id]))
    await admin((q) => q('insert into message_queue_cycles(message_id, cycle_id, step) values ($1, $2, 1)', [m.id, c1.id]))
    // um alinhamento NÃO reinicia o óleo
    await deliverWith('alinhamento', 59500)
    expect((await openCycle(plan)).id).toBe(c1.id)
    // a troca de óleo encerra o ciclo e abre o próximo com data/km reais
    const o = await deliverWith('oleo_motor', 59600)
    const c2 = await openCycle(plan)
    expect(c2.id).not.toBe(c1.id)
    expect(c2.base_km).toBe(59600)
    expect(c2.target_km).toBe(69600)
    expect(c2.base_order_id).toBe(o)
    const [old] = await admin((q) => q('select status, close_kind, closed_by_order_id from maintenance_cycles where id = $1', [c1.id]))
    expect(old).toEqual({ status: 'closed', close_kind: 'executed_here', closed_by_order_id: o })
    const [msg] = await admin((q) => q('select status from message_queue where id = $1', [m.id]))
    expect(msg.status).toBe('cancelled')
    await expectError(admin((q) => q(`update maintenance_cycles set status = 'open' where id = $1`, [c1.id])), 'imutável')
  })

  it('feito em outra oficina registra origem sem fabricar OS ou receita', async () => {
    const c = await openCycle(plan)
    const before = await admin((q) => q('select count(*)::int n from service_orders where workshop_id = $1', [ws]))
    await rpc(owner, 'cycle_done_elsewhere', { p_cycle: c.id, p_date: daysAgo(1), p_km: 61000, p_note: 'Posto X', p_confirmed: false })
    const after = await admin((q) => q('select count(*)::int n from service_orders where workshop_id = $1', [ws]))
    expect(after[0].n).toBe(before[0].n)
    const n = await openCycle(plan)
    expect(n.base_source).toBe('external')
    expect(n.base_confirmed).toBe(false)
  })
})

describe('motor de envios', () => {
  let car2: { client_id: string; vehicle_id: string }, plan2: string

  beforeAll(async () => {
    await admin((q) => q(`update workshops set messaging_mode = 'automatic',
      reminder_policy = reminder_policy || '{"business_days_only": false, "window_start": "00:00", "window_end": "23:59"}' where id = $1`, [ws]))
    car2 = await quickClient(owner, ws, 'Rafa Envio', 'ENV1A23')
    await admin((q) => q(`update clients set whatsapp = '11 95555-4444' where id = $1`, [car2.client_id]))
    plan2 = await rpc(owner, 'create_maintenance_plan', { p_vehicle: car2.vehicle_id, p_component: 'revisao', p_component_label: 'Revisão geral',
      p_action: 'inspecao', p_interval_months: 12, p_interval_days: 0, p_interval_km: null, p_rule: 'date_only', p_lead_days: 30, p_lead_km: 0,
      p_source: 'Política da oficina', p_notes: null, p_base_date: daysAgo(400), p_base_km: null })
  })

  it('enfileira de forma idempotente e dois workers não pegam a mesma mensagem', async () => {
    await admin((q) => q('select enqueue_maintenance_reminders()'))
    await admin((q) => q('select enqueue_maintenance_reminders()'))
    const msgs = await admin((q) => q('select * from message_queue where client_id = $1', [car2.client_id]))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].rendered_body).toContain('Rafa')
    expect(msgs[0].rendered_body).toContain('Revisão geral')
    const [a, b] = await Promise.all([admin((q) => q(`select * from claim_messages('w1', 10)`)), admin((q) => q(`select * from claim_messages('w2', 10)`))])
    const ids = [...a, ...b].map((m) => m.id).filter((id) => id === msgs[0].id)
    expect(ids).toHaveLength(1)
  })

  it('consentimento revogado entre enfileiramento e envio impede a mensagem', async () => {
    const [m] = await admin((q) => q('select id from message_queue where client_id = $1', [car2.client_id]))
    await admin((q) => q(`insert into contact_consents(workshop_id, client_id, purpose, granted, source) values ($1, $2, 'maintenance_reminders', false, 'telefone')`,
      [ws, car2.client_id]))
    const [{ r }] = await admin((q) => q('select message_presend_check($1) r', [m.id]))
    expect(r).toMatch(/Consentimento|status cancelled/)
    const [after] = await admin((q) => q('select status from message_queue where id = $1', [m.id]))
    expect(after.status).toBe('cancelled')
  })

  it('cliente já agendado não recebe cobrança de retorno', async () => {
    await admin((q) => q(`insert into contact_consents(workshop_id, client_id, purpose, granted, source) values ($1, $2, 'maintenance_reminders', true, 'balcao')`,
      [ws, car2.client_id]))
    await admin((q) => q(`update maintenance_cycles set contact_status = 'not_contacted' where plan_id = $1 and status = 'open'`, [plan2]))
    await admin((q) => q(`insert into appointments(workshop_id, client_id, vehicle_id, description, starts_at, ends_at, status)
      values ($1, $2, $3, 'Revisão', now() + interval '3 days', now() + interval '3 days 1 hour', 'confirmed')`, [ws, car2.client_id, car2.vehicle_id]))
    const c = await openCycle(plan2)
    const [{ r }] = await admin((q) => q('select private.cycle_contact_block_reason($1) r', [c.id]))
    expect(r).toBe('cliente já agendado')
  })

  it('webhooks duplicados/fora de ordem não regridem status; envio incerto não é reenviado', async () => {
    const [m] = await admin((q) => q(`insert into message_queue(workshop_id, client_id, purpose, template_key, rendered_body, to_phone, idempotency_key, status, provider_message_id)
      values ($1, $2, 'service_updates', 'veiculo_pronto', 'pronto', '5511955554444', 'wh-1', 'accepted', 'wamid.1') returning id`, [ws, car2.client_id]))
    await admin((q) => q(`select apply_provider_status('whatsapp', 'e-read', 'wamid.1', 'read', '{}')`))
    await admin((q) => q(`select apply_provider_status('whatsapp', 'e-deliv', 'wamid.1', 'delivered', '{}')`))
    const [{ r }] = await admin((q) => q(`select apply_provider_status('whatsapp', 'e-read', 'wamid.1', 'read', '{}') r`))
    expect(r).toBe('duplicado')
    const [s] = await admin((q) => q('select status from message_queue where id = $1', [m.id]))
    expect(s.status).toBe('read')
    // trava expirada durante envio → incerto, fora da fila automática
    const [u] = await admin((q) => q(`insert into message_queue(workshop_id, client_id, purpose, template_key, rendered_body, to_phone, idempotency_key, status, locked_until)
      values ($1, $2, 'service_updates', 'x', 'x', '5511955554444', 'unc-1', 'processing', now() - interval '1 minute') returning id`, [ws, car2.client_id]))
    const claimed = await admin((q) => q(`select * from claim_messages('w3', 10)`))
    expect(claimed.map((x) => x.id)).not.toContain(u.id)
    const [us] = await admin((q) => q('select status, needs_review from message_queue where id = $1', [u.id]))
    expect(us).toEqual({ status: 'uncertain', needs_review: true })
  })

  it('comando PARAR pelo WhatsApp retira o consentimento', async () => {
    await admin((q) => q(`select apply_inbound_message('whatsapp', 'in-1', '5511955554444', 'PARAR', '{}')`))
    const [{ ok }] = await admin((q) => q(`select client_consent($1, 'maintenance_reminders') ok`, [car2.client_id]))
    expect(ok).toBe(false)
  })
})

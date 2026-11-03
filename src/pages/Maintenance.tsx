import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Badge, Button, Card, Checkbox, ErrorBox, Input, Loading, Modal, PageHeader, Select, StatusBadge, Table, Textarea, useToast } from '@/components/ui'
import { fmtDate, fmtDateTime, fmtKm, todayLocal } from '@/lib/format'
import { COMPONENTS, contactStatus, techStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'
import { maskPlate, renderTemplate, waLink } from '@/lib/whatsapp'

export function MaintenancePage() {
  const { wsId, can, ws } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [tech, setTech] = useState('acao')
  const [contact, setContact] = useState('')
  const [component, setComponent] = useState('')
  const [modal, setModal] = useState<{ kind: string; row: any } | null>(null)
  const techFilter = tech === 'acao' ? ['due_soon', 'overdue_date', 'overdue_km', 'estimated', 'awaiting_km'] : tech ? [tech] : null
  const q = useQuery({ queryKey: ['maint-board', wsId, tech, contact, component], queryFn: () => rpc<any[]>('maintenance_board', {
    p_workshop: wsId, p_tech_status: techFilter, p_contact_status: contact ? [contact] : null, p_component: component || null, p_limit: 200 }) })
  const tpl = useQuery({ queryKey: ['templates', wsId], enabled: can('contacts.view'), queryFn: async () => (await supabase.from('message_templates').select('*').eq('workshop_id', wsId)).data ?? [] })

  function openWhatsApp(r: any) {
    const t = tpl.data?.find((x) => x.key === (r.ask_km || r.tech_status === 'estimated' ? 'solicitar_km' : 'retorno_preventivo'))
    const { text } = renderTemplate(t?.body ?? 'Olá, {nome}! Aqui é da {oficina}.', { nome: r.client_name?.split(' ')[0], oficina: ws?.name, veiculo: r.vehicle_label,
      placa: maskPlate(r.plate), servico: r.component_label, telefone: '', data: '', km: '', link: '' })
    const url = waLink(r.client_whatsapp, text.replace(/\{[a-z_]+\}/g, '').trim())
    if (!url) return toast.error({ message: 'Cliente sem WhatsApp/telefone válido' })
    window.open(url, '_blank', 'noopener,noreferrer')
    rpc('log_contact', { p_workshop: wsId, p_client: r.client_id, p_channel: 'whatsapp', p_kind: 'conversation_opened', p_message: text, p_outcome: null, p_cycle: r.cycle_id })
      .then(() => qc.invalidateQueries({ queryKey: ['maint-board'] })).catch((e) => toast.error(e))
  }

  return (
    <div>
      <PageHeader title="Manutenção preventiva" subtitle="Situação técnica e situação de contato são independentes. Km projetado é estimativa — nunca vencimento confirmado." />
      <div className="card mb-3 grid gap-3 p-3 sm:grid-cols-3">
        <Select label="Situação técnica" value={tech} onChange={(e) => setTech(e.target.value)}>
          <option value="acao">Precisam de ação</option><option value="">Todas</option>{Object.entries(techStatus).filter(([k]) => !['completed', 'cancelled'].includes(k)).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Select label="Situação do contato" value={contact} onChange={(e) => setContact(e.target.value)}><option value="">Todas</option>{Object.entries(contactStatus).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select label="Serviço / componente" value={component} onChange={(e) => setComponent(e.target.value)}><option value="">Todos</option>{COMPONENTS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
      </div>
      {q.error ? <ErrorBox error={q.error} /> : q.isLoading ? <Loading /> : (
        <div className="card">
          <Table head={['Veículo / cliente', 'Item', 'Prazo', 'Última km', 'Técnico', 'Contato', '']} empty={!q.data?.length}>
            {q.data?.map((r) => (
              <tr key={r.cycle_id} className="align-top">
                <td className="td"><Link className="font-medium text-brand" to={`/veiculos/${r.vehicle_id}`}>{r.plate}</Link> {r.vehicle_label}<br /><span className="text-slate-500">{r.client_name}</span></td>
                <td className="td">{r.component_label}<br /><span className="text-xs text-slate-500">base {fmtDate(r.base_date)} · {fmtKm(r.base_km)}</span></td>
                <td className="td">{r.target_date && <>{fmtDate(r.target_date)}<br /></>}{r.target_km && <span className="text-xs">{fmtKm(r.target_km)}</span>}</td>
                <td className="td">{fmtKm(r.last_km)}<br /><span className="text-xs text-slate-500">{fmtDate(r.last_km_on)}</span>
                  {r.projected_km && <span className="block text-xs text-violet-700">estimado {fmtKm(r.projected_km)} ({r.rate_confidence})</span>}</td>
                <td className="td"><StatusBadge map={techStatus} value={r.tech_status} />{r.ask_km && <span className="mt-1 block text-xs text-cyan-700">confirmar km</span>}</td>
                <td className="td"><StatusBadge map={contactStatus} value={r.contact_status} />{r.last_contact_at && <span className="block text-xs text-slate-500">{fmtDateTime(r.last_contact_at)}</span>}
                  {r.block_reason && <span className="block text-xs text-slate-400" title="Motivo pelo qual o envio automático não ocorre">{r.block_reason}</span>}</td>
                <td className="td"><div className="flex flex-wrap justify-end gap-1">
                  {can('messages.send') && r.client_whatsapp && <Button size="sm" variant="secondary" onClick={() => openWhatsApp(r)}><MessageCircle className="size-4" />WhatsApp</Button>}
                  {can('contacts.edit') && <Button size="sm" variant="secondary" onClick={() => setModal({ kind: 'response', row: r })}>Resposta</Button>}
                  {can('schedule.create') && <Link className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 px-2 text-sm" to={`/agenda?novo=1`}><CalendarPlus className="size-4" />Agendar</Link>}
                  {can('maintenance.edit') && <Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'elsewhere', row: r })}>Feito fora</Button>}
                  {can('maintenance.edit') && <Button size="sm" variant="ghost" onClick={() => setModal({ kind: 'evidence', row: r })}>Concluir</Button>}
                  {can('maintenance.edit') && <Button size="sm" variant="ghost" onClick={async () => { const m = prompt('Motivo da suspensão:'); if (m) { try { await rpc('set_plan_status', { p_plan: r.plan_id, p_status: 'suspended', p_reason: m }); qc.invalidateQueries({ queryKey: ['maint-board'] }) } catch (e) { toast.error(e) } } }}>Suspender</Button>}
                </div></td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      <ResponseModal ctx={modal?.kind === 'response' ? modal.row : null} onClose={() => setModal(null)} />
      <CloseCycleModal ctx={modal && modal.kind !== 'response' ? modal : null} onClose={() => setModal(null)} />
    </div>
  )
}

function ResponseModal({ ctx, onClose }: { ctx: any; onClose: () => void }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ channel: 'whatsapp', kind: 'response', outcome: 'respondeu', message: '', until: '', km: '' })
  async function save() {
    try {
      if (f.km) await supabase.from('odometer_readings').insert({ workshop_id: wsId, vehicle_id: ctx.vehicle_id, km: Number(f.km), source: 'client_message', confirmed: false, regression_justification: 'informada pelo cliente' }).throwOnError()
      await rpc('log_contact', { p_workshop: wsId, p_client: ctx.client_id, p_channel: f.channel, p_kind: f.kind, p_message: f.message, p_outcome: f.outcome, p_cycle: ctx.cycle_id, p_postpone_until: f.until || null })
      toast.success('Contato registrado'); qc.invalidateQueries({ queryKey: ['maint-board'] }); onClose()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={!!ctx} onClose={onClose} title="Registrar contato / resposta" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={save}>Salvar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Canal" value={f.channel} onChange={(e) => setF((s) => ({ ...s, channel: e.target.value }))}><option value="whatsapp">WhatsApp</option><option value="telefone">Telefone</option><option value="presencial">Presencial</option><option value="email">E-mail</option></Select>
        <Select label="Tipo" value={f.kind} onChange={(e) => setF((s) => ({ ...s, kind: e.target.value }))}><option value="response">Resposta do cliente</option><option value="manual_sent_confirmed">Confirmo que enviei a mensagem</option><option value="call">Ligação</option><option value="note">Anotação</option></Select>
        <Select label="Resultado" value={f.outcome} onChange={(e) => setF((s) => ({ ...s, outcome: e.target.value }))}>
          <option value="respondeu">Respondeu</option><option value="agendou">Agendou</option><option value="adiou">Adiou</option><option value="recusou">Recusou</option><option value="sem_resposta">Sem resposta</option><option value="pediu_pausa">Pediu para parar lembretes</option>
        </Select>
        {f.outcome === 'adiou' && <Input label="Retomar contato em" type="date" value={f.until} onChange={(e) => setF((s) => ({ ...s, until: e.target.value }))} />}
        <Input label="Km informada pelo cliente (opcional)" inputMode="numeric" value={f.km} onChange={(e) => setF((s) => ({ ...s, km: e.target.value.replace(/\D/g, '') }))} hint="Fica como leitura do cliente, a validar." />
        <Textarea className="sm:col-span-2" label="Mensagem / observação" value={f.message} onChange={(e) => setF((s) => ({ ...s, message: e.target.value }))} />
      </div>
    </Modal>
  )
}

function CloseCycleModal({ ctx, onClose }: { ctx: { kind: string; row: any } | null; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { tz } = useAuth()
  const [f, setF] = useState({ date: todayLocal(tz), km: '', note: '', confirmed: false })
  async function save() {
    try {
      if (ctx!.kind === 'elsewhere') await rpc('cycle_done_elsewhere', { p_cycle: ctx!.row.cycle_id, p_date: f.date, p_km: f.km ? Number(f.km) : null, p_note: f.note, p_confirmed: f.confirmed })
      else await rpc('cycle_complete_with_evidence', { p_cycle: ctx!.row.cycle_id, p_date: f.date, p_km: f.km ? Number(f.km) : null, p_evidence: f.note })
      toast.success('Ciclo encerrado e próximo ciclo criado'); qc.invalidateQueries({ queryKey: ['maint-board'] }); onClose()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={!!ctx} onClose={onClose} title={ctx?.kind === 'elsewhere' ? 'Serviço feito em outra oficina' : 'Concluir com evidência'} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={save} disabled={ctx?.kind === 'evidence' && !f.note}>Salvar</Button></>}>
      <p className="mb-3 text-sm text-slate-600">{ctx?.kind === 'elsewhere' ? 'Registra a origem externa sem criar OS nem receita.' : 'Agendamento, pagamento ou orçamento não concluem manutenção: informe a evidência da execução.'}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Data da execução" type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} />
        <Input label="Km na execução" inputMode="numeric" value={f.km} onChange={(e) => setF((s) => ({ ...s, km: e.target.value.replace(/\D/g, '') }))} />
        <Textarea className="sm:col-span-2" label={ctx?.kind === 'elsewhere' ? 'Onde / observação' : 'Evidência (nº OS, nota, foto…)'} value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} />
        {ctx?.kind === 'elsewhere' && <Checkbox label="Dados conferidos (nota/comprovante visto)" checked={f.confirmed} onChange={(v) => setF((s) => ({ ...s, confirmed: v }))} />}
      </div>
    </Modal>
  )
}

/** Planos de um veículo (usado na ficha do veículo). */
export function VehiclePlans({ vehicleId, onNew }: { vehicleId: string; onNew?: () => void }) {
  const q = useQuery({ queryKey: ['vehicle-plans', vehicleId], queryFn: async () => {
    const { data, error } = await supabase.from('maintenance_plans').select('*, maintenance_cycles(*)').eq('vehicle_id', vehicleId).order('created_at')
    if (error) throw error
    const open = (data ?? []).flatMap((p: any) => p.maintenance_cycles.filter((c: any) => c.status === 'open').map((c: any) => c.id))
    const sts = await Promise.all(open.map((id: string) => rpc<any[]>('cycle_technical_status', { p_cycle: id }).then((r) => [id, r[0]] as const)))
    return { plans: data ?? [], status: Object.fromEntries(sts) }
  } })
  return (
    <Card title="Planos preventivos" actions={onNew && <Button size="sm" onClick={onNew}>Novo plano</Button>}>
      {q.isLoading ? <Loading /> : q.data?.plans.length ? (
        <ul className="divide-y divide-slate-100">{q.data.plans.map((p: any) => {
          const c = p.maintenance_cycles.find((x: any) => x.status === 'open')
          const st = c && q.data.status[c.id]
          return (
            <li key={p.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2"><strong>{p.component_label}</strong><span className="text-slate-500">({p.action})</span>
                {p.status !== 'active' ? <Badge>{p.status}</Badge> : st && <StatusBadge map={techStatus} value={st.status} />}
                {c && <StatusBadge map={contactStatus} value={c.contact_status} />}</div>
              <p className="text-xs text-slate-500">
                Intervalo: {[p.interval_months && `${p.interval_months} meses`, p.interval_days && `${p.interval_days} dias`, p.interval_km && fmtKm(p.interval_km)].filter(Boolean).join(' ou ')}
                {p.rule === 'first' ? ' (o que vier primeiro)' : p.rule === 'km_only' ? ' (somente km)' : ' (somente data)'} · fonte: {p.source}</p>
              {c && <p className="text-xs">Ciclo {c.seq}: base {fmtDate(c.base_date)} {fmtKm(c.base_km)} → alvo {fmtDate(c.target_date)} {c.target_km ? fmtKm(c.target_km) : ''} {!c.base_confirmed && <Badge tone="amber">base a confirmar</Badge>}</p>}
              <details className="text-xs text-slate-500"><summary className="cursor-pointer">Histórico de ciclos ({p.maintenance_cycles.length})</summary>
                <ul>{p.maintenance_cycles.sort((a: any, b: any) => b.seq - a.seq).map((x: any) => <li key={x.id}>#{x.seq} {fmtDate(x.base_date)} {fmtKm(x.base_km)} · {x.status}{x.close_evidence && ` · ${x.close_evidence}`}</li>)}</ul></details>
            </li>
          )
        })}</ul>
      ) : <p className="text-sm text-slate-500">Nenhum plano. Os intervalos são definidos pelo profissional conforme veículo, fabricante e uso — o sistema não aplica intervalos universais.</p>}
    </Card>
  )
}

export function MaintenancePlanModal({ open, onClose, vehicleId, orderId, defaults, baseKm }: { open: boolean; onClose: () => void; vehicleId: string; orderId?: string; defaults?: any; baseKm?: number | null }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { tz } = useAuth()
  const [f, setF] = useState({ component: '', label: '', action: 'troca', months: '', days: '', km: '', rule: 'first', leadDays: '15', leadKm: '500', source: '', notes: '', baseDate: todayLocal(tz), baseKm: '', policy: 'auto' })
  useEffect(() => {
    if (!open) return
    const comp = COMPONENTS.find((c) => c.key === defaults?.maintenance_component)
    setF((s) => ({ ...s, component: comp?.key ?? '', label: comp?.label ?? '', baseKm: baseKm ? String(baseKm) : '', baseDate: todayLocal(tz) }))
  }, [open, defaults, baseKm, tz])
  async function save() {
    try {
      await rpc('create_maintenance_plan', { p_vehicle: vehicleId, p_component: f.component, p_component_label: f.label || COMPONENTS.find((c) => c.key === f.component)?.label,
        p_action: f.action, p_interval_months: f.months ? Number(f.months) : 0, p_interval_days: f.days ? Number(f.days) : 0, p_interval_km: f.km ? Number(f.km) : null,
        p_rule: f.rule, p_lead_days: Number(f.leadDays || 0), p_lead_km: Number(f.leadKm || 0), p_source: f.source, p_notes: f.notes || null,
        p_base_date: f.baseDate, p_base_km: f.baseKm ? Number(f.baseKm) : null, p_order: orderId ?? null, p_contact_policy: f.policy })
      toast.success('Plano preventivo cadastrado'); qc.invalidateQueries({ queryKey: ['vehicle-plans', vehicleId] }); onClose()
    } catch (e) { toast.error(e) }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))
  return (
    <Modal open={open} onClose={onClose} title="Novo plano preventivo" wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!f.component || !f.source || (!f.km && !f.months && !f.days)} onClick={save}>Cadastrar plano</Button></>}>
      <p className="mb-3 rounded-md bg-blue-50 p-2 text-sm text-blue-900">Informe o intervalo recomendado para <strong>este</strong> veículo e uso (manual do fabricante, avaliação do mecânico). Nada é preenchido automaticamente.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Componente / serviço *" value={f.component} onChange={(e) => setF((s) => ({ ...s, component: e.target.value, label: COMPONENTS.find((c) => c.key === e.target.value)?.label ?? '' }))}>
          <option value="">Selecione</option>{COMPONENTS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </Select>
        <Select label="Ação" value={f.action} onChange={set('action')}><option value="troca">Troca</option><option value="inspecao">Inspeção</option><option value="avaliacao">Avaliação</option><option value="limpeza">Limpeza</option><option value="outro">Outro</option></Select>
        <Select label="Regra de vencimento" value={f.rule} onChange={set('rule')}><option value="first">O que vier primeiro (data ou km)</option><option value="date_only">Somente data</option><option value="km_only">Somente km</option></Select>
        {f.rule !== 'km_only' && <><Input label="Intervalo (meses)" inputMode="numeric" value={f.months} onChange={set('months')} /><Input label="+ dias" inputMode="numeric" value={f.days} onChange={set('days')} /></>}
        {f.rule !== 'date_only' && <Input label="Intervalo (km)" inputMode="numeric" value={f.km} onChange={set('km')} />}
        <Input label="Antecedência (dias)" inputMode="numeric" value={f.leadDays} onChange={set('leadDays')} />
        {f.rule !== 'date_only' && <Input label="Antecedência (km)" inputMode="numeric" value={f.leadKm} onChange={set('leadKm')} />}
        <Select label="Contato" value={f.policy} onChange={set('policy')}><option value="auto">Automático quando ativado</option><option value="manual">Somente manual</option><option value="none">Não contatar</option></Select>
        <Input label="Data base (execução real)" type="date" value={f.baseDate} onChange={set('baseDate')} />
        <Input label="Km base (execução real)" inputMode="numeric" value={f.baseKm} onChange={set('baseKm')} />
        <Input className="sm:col-span-3" label="Fonte da recomendação *" value={f.source} onChange={set('source')} placeholder="Ex.: manual do proprietário, uso severo; avaliação do mecânico João" />
        <Textarea className="sm:col-span-3" label="Observações" value={f.notes} onChange={set('notes')} />
      </div>
    </Modal>
  )
}

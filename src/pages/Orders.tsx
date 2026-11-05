import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Camera, CheckCircle2, ChevronDown, ChevronLeft, Link2, MessageCircle, Pause, Play, Plus, Printer } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { ClientVehiclePicker, useTeam, type Picked } from '@/components/pickers'
import {
  Badge, Button, Card, Checkbox, ErrorBox, Input, Loading, Modal, MoneyInput, PageHeader, Pager, Select, StatusBadge, Tabs, Textarea, useToast, useUnsavedWarning,
} from '@/components/ui'
import { isConflict } from '@/lib/errors'
import { brl, fmtDate, fmtDateTime, fmtKm, fmtQty, localToISO, todayLocal } from '@/lib/format'
import { COMPONENTS, fuelLabels, itemStatus, kindLabel, orderStatus, quoteStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'
import { portalUrl, waLink } from '@/lib/whatsapp'
import { Plate } from '@/components/Plate'
import { RemindersCard, ReturnPicker } from '@/components/ReturnReminder'
import { CarCard } from './Dashboard'
import { MaintenancePlanModal } from './Maintenance'

const PAGE = 30
const ACTIVE = ['open', 'diagnosis', 'awaiting_approval', 'approved', 'in_progress', 'quality_check', 'ready']

export function OrdersPage() {
  const { wsId, can } = useAuth()
  const [params, setParams] = useSearchParams()
  const filter = params.get('f') ?? 'ativas'
  const [q, setQ] = useState(params.get('q') ?? '')
  const [page, setPage] = useState(0)
  const status = filter === 'ativas' ? ACTIVE : filter === 'todas' ? null : [filter]
  const list = useQuery({
    queryKey: ['orders', wsId, filter, q, page],
    queryFn: () => rpc<any[]>('orders_board', { p_workshop: wsId, p_status: status, p_q: q || null, p_limit: PAGE, p_offset: page * PAGE }),
  })
  const { tz } = useAuth()
  const setFilter = (f: string) => { const p = new URLSearchParams(params); p.set('f', f); setParams(p, { replace: true }); setPage(0) }
  const filters: [string, string][] = [['ativas', 'Na oficina'], ['awaiting_approval', 'Esperando aprovação'], ['in_progress', 'Em serviço'],
    ['ready', 'Prontos'], ['delivered', 'Entregues'], ['todas', 'Todos']]
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-extrabold">Serviços</h1>
        {can('orders.create') && <Link to="/receber" className="inline-flex h-11 items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-semibold text-white shadow-sm shadow-brand/25"><Plus className="size-4" />Receber carro</Link>}
      </div>
      <input className="input rounded-full" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Buscar placa, cliente ou nº da OS" aria-label="Buscar serviços" />
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {filters.map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className={clsx('min-h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium',
            filter === k ? 'border-brand bg-brand text-white' : 'border-slate-300 bg-card text-slate-700')}>{l}</button>
        ))}
      </div>
      {list.error ? <ErrorBox error={list.error} /> : list.isLoading ? <Loading /> : list.data?.length ? <>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{list.data.map((o) => <CarCard key={o.id} o={o} tz={tz} />)}</div>
        <Pager page={page} pageSize={PAGE} total={Number(list.data?.[0]?.total_count ?? 0)} onPage={setPage} />
      </> : <div className="card p-8 text-center text-sm text-slate-500">Nenhum serviço {filter === 'ativas' ? 'na oficina agora' : 'nesta situação'}.</div>}
    </div>
  )
}

export function NewOrder() {
  const { wsId, tz } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const team = useTeam()
  const [picked, setPicked] = useState<Picked | null>(null)
  const [f, setF] = useState({ complaint: '', km: '', fuel: '', date: '', time: '18:00', responsible: '', mechanics: [] as string[], kmJust: '', warrantyOf: params.get('garantia') ?? '' })
  const [needJust, setNeedJust] = useState(false)
  const [busy, setBusy] = useState(false)
  useUnsavedWarning(!!(picked || f.complaint))
  useEffect(() => {
    const c = params.get('client'), v = params.get('vehicle')
    if (c) supabase.from('clients').select('name').eq('id', c).single().then(({ data }) => setPicked({ clientId: c, clientName: data?.name ?? '', vehicleId: v, vehicleLabel: '' }))
  }, [params])
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!picked?.vehicleId || busy) return
    setBusy(true)
    try {
      const id = await rpc<string>('open_order', {
        p_workshop: wsId, p_client: picked.clientId, p_vehicle: picked.vehicleId, p_complaint: f.complaint, p_km: f.km ? Number(f.km) : null,
        p_fuel: f.fuel === '' ? null : Number(f.fuel), p_expected_delivery: f.date ? localToISO(f.date, f.time, tz) : null,
        p_responsible: f.responsible || null, p_mechanics: f.mechanics, p_warranty_of: f.warrantyOf || null, p_km_justification: f.kmJust || null,
      })
      toast.success('OS aberta'); nav(`/os/${id}`, { replace: true })
    } catch (err: any) {
      if (err?.code === 'P0002') setNeedJust(true)
      toast.error(err)
    } finally { setBusy(false) }
  }
  const mechs = (team.data ?? []).filter((m) => m.status === 'active')
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={f.warrantyOf ? 'Nova OS de retorno em garantia' : 'Novo atendimento / OS'} />
      <form onSubmit={submit} className="space-y-4">
        <Card title="1. Cliente e veículo"><ClientVehiclePicker value={picked} onChange={setPicked} /></Card>
        <Card title="2. Recepção do veículo">
          <div className="grid gap-3 sm:grid-cols-2">
            <Textarea className="sm:col-span-2" label="Queixa / solicitação do cliente *" required value={f.complaint} onChange={(e) => setF((s) => ({ ...s, complaint: e.target.value }))} />
            <Input label="Quilometragem de entrada" inputMode="numeric" value={f.km} onChange={(e) => setF((s) => ({ ...s, km: e.target.value.replace(/\D/g, '') }))} />
            <Select label="Combustível aproximado" value={f.fuel} onChange={(e) => setF((s) => ({ ...s, fuel: e.target.value }))}>
              <option value="">Não informado</option>{fuelLabels.map((l, i) => <option key={i} value={i}>{l}</option>)}
            </Select>
            {needJust && <Textarea className="sm:col-span-2" label="Justificativa da km menor que a anterior" value={f.kmJust} onChange={(e) => setF((s) => ({ ...s, kmJust: e.target.value }))} />}
            <Input label="Previsão de entrega (data)" type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} />
            <Input label="Hora" type="time" value={f.time} onChange={(e) => setF((s) => ({ ...s, time: e.target.value }))} />
          </div>
        </Card>
        <Card title="3. Responsáveis">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Responsável pela OS" value={f.responsible} onChange={(e) => setF((s) => ({ ...s, responsible: e.target.value }))}>
              <option value="">—</option>{mechs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            <div><p className="label">Mecânicos atribuídos</p><div className="flex flex-col gap-1">{mechs.filter((m) => m.role === 'mechanic' || m.role === 'manager' || m.role === 'owner').map((m) => (
              <Checkbox key={m.id} label={m.name} checked={f.mechanics.includes(m.id)} onChange={(v) => setF((s) => ({ ...s, mechanics: v ? [...s.mechanics, m.id] : s.mechanics.filter((x) => x !== m.id) }))} />
            ))}</div></div>
          </div>
        </Card>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => nav(-1)}>Cancelar</Button><Button type="submit" loading={busy} disabled={!picked?.vehicleId}>Abrir OS</Button></div>
      </form>
    </div>
  )
}

export function OrderDetail() {
  const { id } = useParams()
  const { wsId, can, tz, ws } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const nav = useNavigate()
  const team = useTeam()
  const [tab, setTab] = useState('itens')
  const [modal, setModal] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['order', id], queryFn: () => rpc<any>('order_detail', { p_order: id }), refetchInterval: 30_000 })
  const o = q.data
  const reload = () => { qc.invalidateQueries({ queryKey: ['order', id] }); qc.invalidateQueries({ queryKey: ['orders'] }) }
  const name = (mid: string) => team.data?.find((m) => m.id === mid)?.name ?? '—'

  async function act(fn: () => Promise<unknown>, ok?: string) {
    try { await fn(); if (ok) toast.success(ok); reload() } catch (e) { toast.error(e); if (isConflict(e)) reload() }
  }
  const transition = (to: string) => act(() => rpc('order_transition', { p_order: id, p_to: to, p_expected_version: o.version }), `OS: ${orderStatus[to][0]}`)

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const closed = ['delivered', 'cancelled'].includes(o.status)
  const approvedItems = o.items.filter((i: any) => ['approved', 'in_progress', 'done'].includes(i.status))
  const before = ['open', 'diagnosis', 'awaiting_approval', 'approved'].includes(o.status)
  const waText = `Olá, ${o.client?.name?.split(' ')[0] ?? ''}! Atualização do seu ${o.vehicle?.model ?? 'veículo'} na ${ws?.name}: ${orderStatus[o.status][0]}.`
  const wa = o.client?.whatsapp_norm && waLink(o.client.whatsapp_norm, waText)
  const canAdd = can('orders.edit') && can('prices.view')

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="no-print flex items-center gap-2">
        <button onClick={() => nav(-1)} aria-label="Voltar" className="flex size-10 items-center justify-center rounded-full text-slate-600 active:bg-slate-100"><ChevronLeft className="size-6" /></button>
        <span className="text-sm text-slate-500">Serviço {o.number}</span>
      </div>

      {/* Carro, etapa e a próxima ação (um botão por vez) */}
      <section className="card p-4">
        <div className="flex flex-wrap items-start gap-3">
          <Plate value={o.vehicle?.plate ?? o.vehicle?.internal_code} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold uppercase">{can('clients.view') ? <Link className="text-ink" to={`/clientes/${o.client.id}`}>{o.client.name}</Link> : o.client.name}</p>
            <p className="text-sm text-slate-600">{[o.vehicle?.brand, o.vehicle?.model, o.vehicle?.year_model].filter(Boolean).join(' ')}{o.km_entry ? ` · ${fmtKm(o.km_entry)}` : ''}</p>
            <p className="text-xs text-slate-500">Chegou {fmtDateTime(o.entry_at, tz)}{o.expected_delivery_at && ` · entrega ${fmtDateTime(o.expected_delivery_at, tz)}`}</p>
          </div>
        </div>
        {o.complaint && <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm"><b>Pedido:</b> {o.complaint}</p>}
        {o.status === 'cancelled' ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">Cancelado: {o.cancel_reason}</p> : <StageBar status={o.status} />}
        <div className="no-print mt-3 grid gap-2">
          {before && approvedItems.length === 0 && canAdd && <Button size="lg" onClick={() => setModal('simple-item')}><Plus className="size-5" />Adicionar serviço</Button>}
          {before && approvedItems.length > 0 && can('orders.execute') && <Button size="lg" onClick={() => transition('in_progress')}>Começar serviço</Button>}
          {before && can('quotes.create') && <Button size="lg" variant="secondary" onClick={() => nav(`/orcamentos/novo?order=${id}`)}>Fazer orçamento para o cliente aprovar</Button>}
          {['in_progress', 'quality_check'].includes(o.status) && can('orders.execute') && <Button size="lg" onClick={() => setModal('finish')}><CheckCircle2 className="size-5" />Pronto para entrega</Button>}
          {o.status === 'ready' && can('orders.deliver') && <Button size="lg" onClick={() => setModal('deliver-simple')}>Entregar o carro</Button>}
        </div>
        <div className="no-print mt-2 flex flex-wrap gap-2">
          {wa && can('messages.send') && <a className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-wa px-3 text-sm font-medium text-white" target="_blank" rel="noopener noreferrer" href={wa}
            onClick={() => rpc('log_contact', { p_workshop: wsId, p_client: o.client.id, p_channel: 'whatsapp', p_kind: 'conversation_opened', p_message: waText, p_outcome: null, p_order: id }).catch(() => {})}><MessageCircle className="size-4" />WhatsApp</a>}
          {(can('messages.send') || can('orders.edit')) && <Button variant="secondary" onClick={() => setModal('portal')}><Link2 className="size-4" />Link do cliente</Button>}
          {can('orders.print') && <Button variant="secondary" onClick={() => window.print()}><Printer className="size-4" />Imprimir</Button>}
        </div>
      </section>

      {!closed && (can('orders.edit') || can('orders.execute')) && <ClientMessage o={o} reload={reload} />}

      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Serviços e peças</h2>
          {canAdd && !closed && o.status !== 'ready' && <Button size="sm" variant="secondary" onClick={() => setModal('simple-item')}><Plus className="size-4" />Adicionar</Button>}</div>
        {o.items.filter((i: any) => i.status !== 'cancelled').length === 0 ? <p className="text-sm text-slate-500">Nenhum serviço ainda.</p> : (
          <ul className="divide-y divide-slate-100">{o.items.filter((i: any) => i.status !== 'cancelled').map((i: any) => (
            <li key={i.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{i.description}</p>
                <p className="text-xs text-slate-500">{kindLabel[i.kind]}{Number(i.quantity) !== 1 && ` · ${fmtQty(i.quantity)}x`}</p></div>
              {o.perms.prices && <span className="font-semibold">{brl(i.total_cents)}</span>}
              <StatusBadge map={itemStatus} value={i.status} />
            </li>
          ))}</ul>
        )}
        {o.totals && <p className="mt-2 flex justify-between border-t border-slate-100 pt-2 font-heading text-lg font-extrabold"><span>Total</span><span>{brl(o.totals.approved_total_cents)}</span></p>}
      </section>

      {o.status !== 'cancelled' && <RemindersCard orderId={o.id} items={o.items.filter((i: any) => i.kind !== 'part' && i.status !== 'cancelled').map((i: any) => i.description)} />}

      <PhotosTab o={o} reload={reload} />

      <details className="card group p-4">
        <summary className="cursor-pointer list-none font-medium text-slate-600"><span className="inline-flex items-center gap-1">Mais detalhes <ChevronDown className="size-4 transition-transform group-open:rotate-180" /></span></summary>
        <div className="mt-3 space-y-4">
          <Tabs value={tab} onChange={setTab} tabs={[{ key: 'itens', label: 'Itens (avançado)' }, { key: 'diag', label: 'Diagnóstico' }, { key: 'check', label: 'Checklists' },
            { key: 'tempo', label: 'Tempo' }, { key: 'linha', label: 'Histórico' }]} />
          {tab === 'itens' && <ItemsTab o={o} act={act} name={name} onAdd={() => setModal('item')} />}
          {tab === 'diag' && <DiagnosisTab o={o} reload={reload} />}
          {tab === 'check' && <ChecklistTab o={o} act={act} />}
          {tab === 'tempo' && <TimeTab o={o} act={act} name={name} />}
          {tab === 'linha' && <TimelineTab o={o} reload={reload} />}
          <SummaryCard o={o} name={name} reload={reload} onPlan={() => setModal('plan')} />
          {o.quotes && o.quotes.length > 0 && (
            <Card title="Orçamentos deste serviço">
              <ul className="space-y-1 text-sm">{o.quotes.map((qq: any) => <li key={qq.id} className="flex items-center gap-2"><Link className="text-brand" to={`/orcamentos/${qq.id}`}>{qq.number}</Link>{qq.is_addendum && <Badge tone="violet">aditivo</Badge>}<span className="ml-auto"><StatusBadge map={quoteStatus} value={qq.status} /></span></li>)}</ul>
            </Card>
          )}
          {(o.totals || o.margin) && <MoneyCard o={o} reload={reload} />}
          <div className="no-print flex flex-wrap gap-2">
            {['in_progress', 'quality_check'].includes(o.status) && can('orders.execute') && <Button variant="secondary" onClick={() => transition('approved')}>Pausar serviço</Button>}
            {['ready', 'delivered'].includes(o.status) && can('orders.reopen') && <Button variant="ghost" onClick={() => { const r = prompt('Por que reabrir?'); if (r) act(() => rpc('reopen_order', { p_order: id, p_reason: r }), 'Serviço reaberto') }}>Reabrir</Button>}
            {o.status === 'delivered' && can('orders.create') && <Link className="inline-flex h-10 items-center rounded-md px-3 text-sm text-slate-700 hover:bg-slate-100" to={`/os/nova?client=${o.client.id}&vehicle=${o.vehicle_id}&garantia=${id}`}>Retorno em garantia</Link>}
            {!closed && can('orders.cancel') && <Button variant="ghost" className="text-red-600" onClick={() => { const r = prompt('Motivo do cancelamento:'); if (r) act(() => rpc('cancel_order', { p_order: id, p_reason: r }), 'Serviço cancelado') }}>Cancelar serviço</Button>}
          </div>
        </div>
      </details>

      <SimpleItemModal open={modal === 'simple-item'} onClose={() => setModal(null)} o={o} reload={reload} />
      <FinishModal open={modal === 'finish'} onClose={() => setModal(null)} o={o} reload={reload} />
      <DeliverSimpleModal open={modal === 'deliver-simple'} onClose={() => setModal(null)} o={o} reload={reload} />
      <AddItemModal open={modal === 'item'} onClose={() => setModal(null)} o={o} reload={reload} />
      <PortalLinkModal open={modal === 'portal'} onClose={() => setModal(null)} orderId={id!} clientPhone={o.client?.whatsapp_norm} clientName={o.client?.name} clientId={o.client?.id} />
      <MaintenancePlanModal open={modal === 'plan'} onClose={() => { setModal(null); reload() }} vehicleId={o.vehicle_id} orderId={id}
        defaults={o.items.find((i: any) => i.maintenance_component && i.status !== 'cancelled')} baseKm={o.km_entry} />
    </div>
  )
}

/** Adicionar serviço/peça em poucos campos. */
function SimpleItemModal({ open, onClose, o, reload }: { open: boolean; onClose: () => void; o: any; reload: () => void }) {
  const { wsId, can } = useAuth()
  const toast = useToast()
  const [desc, setDesc] = useState('')
  const [price, setPrice] = useState<number | null>(null)
  const [qty, setQty] = useState('1')
  const [kind, setKind] = useState<'service' | 'part'>('service')
  const [approved, setApproved] = useState(true)
  const [busy, setBusy] = useState(false)
  const canApprove = can('quotes.approve_onsite')
  const services = useQuery({ queryKey: ['catalog', wsId], enabled: open, queryFn: async () => (await supabase.from('service_catalog').select('*').eq('workshop_id', wsId).is('archived_at', null).order('name')).data ?? [] })
  useEffect(() => { if (open) { setDesc(''); setPrice(null); setQty('1'); setKind('service'); setApproved(canApprove) } }, [open, canApprove])
  async function save() {
    setBusy(true)
    try {
      const sv = services.data?.find((s) => s.name === desc)
      await rpc('add_order_item', { p_order: o.id, p_kind: kind, p_description: desc.trim(), p_qty: Number(qty.replace(',', '.')) || 1, p_unit_price_cents: price ?? 0,
        p_service: sv?.id ?? null, p_onsite_authorization: approved ? { channel: 'presencial', authorized_by: o.client?.name ?? 'Cliente' } : null })
      toast.success('Adicionado'); reload(); onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Adicionar serviço ou peça">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {([['service', 'Serviço'], ['part', 'Peça']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setKind(v)} aria-pressed={kind === v} className={clsx('h-11 rounded-xl border font-medium', kind === v ? 'border-brand bg-brand-soft text-brand-strong' : 'border-slate-300')}>{l}</button>
          ))}
        </div>
        <div>
          <label htmlFor="si-desc" className="label">O que é?</label>
          <input id="si-desc" className="input" list="si-cat" value={desc} autoFocus placeholder={kind === 'service' ? 'Ex.: Troca de óleo' : 'Ex.: Filtro de óleo'}
            onChange={(e) => { setDesc(e.target.value); const sv = services.data?.find((s) => s.name === e.target.value); if (sv) setPrice(Number(sv.base_price_cents)) }} />
          <datalist id="si-cat">{services.data?.map((s) => <option key={s.id} value={s.name} />)}</datalist>
        </div>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <MoneyInput label="Valor (R$)" cents={price} onCents={setPrice} />
          <Input label="Qtd" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
        {canApprove && <Checkbox label="O cliente já aprovou este valor" checked={approved} onChange={setApproved} />}
        {!approved && <p className="text-xs text-slate-500">Fica aguardando aprovação. Mande o orçamento para o cliente aprovar pelo link.</p>}
        <Button size="lg" className="w-full" loading={busy} disabled={!desc.trim() || price === null} onClick={save}>Adicionar</Button>
      </div>
    </Modal>
  )
}

/** "Pronto para entrega": para cada serviço feito, quando o cliente deve voltar. */
function FinishModal({ open, onClose, o, reload }: { open: boolean; onClose: () => void; o: any; reload: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const done = o.items.filter((i: any) => ['approved', 'in_progress', 'done'].includes(i.status) && i.kind !== 'part')
  const [rows, setRows] = useState<Record<string, { label: string; months: number; km: number }>>({})
  const [extra, setExtra] = useState({ label: '', months: 0, km: 0 })
  useEffect(() => {
    if (open) { setRows(Object.fromEntries(done.map((i: any) => [i.id, { label: i.description, months: 0, km: 0 }]))); setExtra({ label: '', months: 0, km: 0 }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const chosen = [...Object.values(rows), extra].filter((r) => r.label.trim() && (r.months || r.km))
  async function go() {
    setBusy(true)
    try {
      await rpc('finish_service_with_returns', { p_order: o.id, p_returns: chosen.map((r) => ({ label: r.label.trim(), months: r.months || '', km: r.km || '' })) })
      toast.success(chosen.length ? `Pronto! ${chosen.length} lembrete(s) de retorno criado(s)` : 'Carro pronto para entrega!')
      qc.invalidateQueries({ queryKey: ['order-reminders', o.id] }); reload(); onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Pronto para entrega">
      <div className="space-y-4">
        <p className="text-slate-600">Quando o cliente deve voltar para conferir o que foi feito? Toque no tempo e/ou km. Deixe em branco se não precisar.</p>
        {done.map((i: any) => (
          <div key={i.id} className="rounded-2xl border border-slate-200 p-3">
            <input className="input mb-2 font-semibold" aria-label="Serviço" value={rows[i.id]?.label ?? i.description}
              onChange={(e) => setRows((s) => ({ ...s, [i.id]: { ...s[i.id], label: e.target.value } }))} />
            <ReturnPicker value={rows[i.id] ?? { months: 0, km: 0 }} onChange={(v) => setRows((s) => ({ ...s, [i.id]: { ...s[i.id], ...v } }))} />
          </div>
        ))}
        <div className="rounded-2xl border border-dashed border-slate-300 p-3">
          <input className="input mb-2" aria-label="Outro lembrete" placeholder="Outro lembrete (ex.: Revisão dos freios)" value={extra.label} onChange={(e) => setExtra((s) => ({ ...s, label: e.target.value }))} />
          <ReturnPicker value={extra} onChange={(v) => setExtra((s) => ({ ...s, ...v }))} />
        </div>
        <Button size="lg" className="w-full" loading={busy} onClick={go}>{chosen.length ? `Pronto e criar ${chosen.length} lembrete(s)` : 'Pronto, sem lembrete'}</Button>
      </div>
    </Modal>
  )
}

/** "Entregar o carro": como foi pago? */
function DeliverSimpleModal({ open, onClose, o, reload }: { open: boolean; onClose: () => void; o: any; reload: () => void }) {
  const { can, tz } = useAuth()
  const toast = useToast()
  const [mode, setMode] = useState<'' | 'paid_now' | 'already_paid' | 'later'>('')
  const [method, setMethod] = useState('pix')
  const [due, setDue] = useState(todayLocal(tz, 7))
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setMode('') }, [open])
  const canCharge = can('payments.receive')
  async function go() {
    setBusy(true)
    try { await rpc('deliver_simple', { p_order: o.id, p_mode: mode, p_method: mode === 'paid_now' ? method : null, p_due: mode === 'later' ? due : null }); toast.success('Carro entregue'); reload(); onClose() }
    catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  const opt = (v: typeof mode, l: string, sub: string) => (
    <button onClick={() => setMode(v)} aria-pressed={mode === v} className={clsx('w-full rounded-2xl border p-4 text-left', mode === v ? 'border-brand bg-brand-soft' : 'border-slate-200')}>
      <span className="block font-semibold">{l}</span><span className="text-sm text-slate-500">{sub}</span>
    </button>
  )
  return (
    <Modal open={open} onClose={onClose} title="Entregar o carro">
      <div className="space-y-2">
        {o.totals && <p className="mb-1 font-heading text-2xl font-extrabold">{brl(o.totals.approved_total_cents)}</p>}
        <p className="text-slate-600">Como foi pago?</p>
        {canCharge && opt('paid_now', 'Pagou agora', 'Registrar o pagamento')}
        {mode === 'paid_now' && (
          <div className="grid grid-cols-2 gap-2">{[['pix', 'Pix'], ['dinheiro', 'Dinheiro'], ['cartao_debito', 'Débito'], ['cartao_credito', 'Crédito']].map(([v, l]) => (
            <button key={v} onClick={() => setMethod(v)} aria-pressed={method === v} className={clsx('h-11 rounded-xl border font-medium', method === v ? 'border-brand bg-brand text-white' : 'border-slate-300')}>{l}</button>
          ))}</div>
        )}
        {opt('already_paid', 'Já tinha pago', 'Sem lançar valor agora')}
        {canCharge && opt('later', 'Vai pagar depois', 'Fica em aberto no financeiro')}
        {mode === 'later' && <Input label="Paga até" type="date" value={due} onChange={(e) => setDue(e.target.value)} />}
        <Button size="lg" className="mt-2 w-full" disabled={!mode} loading={busy} onClick={go}>Confirmar entrega</Button>
      </div>
    </Modal>
  )
}

// Etapas como o cliente e o mecânico entendem: 4 passos.
const STEPS: [string, string[]][] = [
  ['Recebido', ['open', 'diagnosis', 'awaiting_approval', 'approved']],
  ['Em serviço', ['in_progress', 'quality_check']],
  ['Pronto', ['ready']],
  ['Entregue', ['delivered']],
]

function StageBar({ status }: { status: string }) {
  const idx = STEPS.findIndex(([, list]) => list.includes(status))
  return (
    <ol className="mt-4 grid grid-cols-4 gap-1.5" aria-label="Etapas">
      {STEPS.map(([label], i) => (
        <li key={label} className="text-center">
          <span className={clsx('block h-1.5 rounded-full', i <= idx ? 'bg-brand' : 'bg-slate-200')} />
          <span className={clsx('mt-1 block text-[11px] font-medium', i === idx ? 'text-brand-strong' : 'text-slate-500')}>{label}</span>
        </li>
      ))}
      {status === 'awaiting_approval' && <li className="col-span-4 mt-1 text-center text-xs text-amber-700">Esperando o cliente aprovar o orçamento</li>}
    </ol>
  )
}

/** Recado curto que aparece na página do cliente (portal), como no ChapGest. */
function ClientMessage({ o, reload }: { o: any; reload: () => void }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const last = o.events.find((e: any) => e.visible_to_client && e.kind === 'note')
  async function send() {
    setBusy(true)
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('order_events').insert({ workshop_id: wsId, order_id: o.id, kind: 'note', message: text.trim(), visible_to_client: true, author_id: u.user?.id })
    setBusy(false)
    if (error) return toast.error(error)
    setText(''); toast.success('Recado publicado na página do cliente'); reload()
  }
  return (
    <section className="card no-print mb-4 p-4">
      <h2 className="font-bold">Recado para o cliente</h2>
      <p className="mb-2 text-sm text-slate-500">Aparece na página de acompanhamento dele.{last && <> Último: <i>"{last.message}"</i></>}</p>
      <div className="flex gap-2">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Ex.: A peça chegou, começamos a montagem hoje." aria-label="Recado para o cliente" />
        <Button loading={busy} disabled={!text.trim()} onClick={send}>Enviar</Button>
      </div>
    </section>
  )
}

function ItemsTab({ o, act, name, onAdd }: { o: any; act: (fn: () => Promise<unknown>, ok?: string) => void; name: (id: string) => string; onAdd: () => void }) {
  const { can } = useAuth()
  const exec = o.status === 'in_progress' || o.status === 'quality_check'
  const reservation = (itemId: string) => o.reservations.find((r: any) => r.item_id === itemId && ['reserved', 'consumed'].includes(r.status))
  return (
    <Card title="Itens" actions={can('orders.edit') && can('prices.view') && !['delivered', 'cancelled', 'ready'].includes(o.status) && <Button size="sm" onClick={onAdd}><Plus className="size-4" />Item</Button>}>
      {o.items.length === 0 ? <p className="text-sm text-slate-500">Nenhum item. Monte um orçamento ou adicione itens com autorização registrada.</p> : (
        <div className="-mx-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50"><tr><th className="th">Item</th><th className="th">Qtd</th>{o.perms.prices && <th className="th text-right">Total</th>}{o.perms.costs && <th className="th no-print text-right">Custo</th>}<th className="th">Situação</th><th className="th no-print" /></tr></thead>
            <tbody className="divide-y divide-slate-100">{o.items.map((i: any) => {
              const r = reservation(i.id)
              return (
                <tr key={i.id} className={i.status === 'cancelled' || i.status === 'declined' ? 'text-slate-400' : ''}>
                  <td className="td"><span className="text-xs text-slate-500">{kindLabel[i.kind]}{i.is_addendum && ' · aditivo'}{i.approval_source === 'onsite' && ' · autorização presencial'}</span><br />{i.description}
                    {i.assigned_membership_id && <span className="block text-xs text-slate-500">{name(i.assigned_membership_id)}</span>}
                    {i.part_origin !== 'stock' && i.kind === 'part' && <span className="block text-xs text-amber-700">{i.part_origin === 'client_supplied' ? 'Peça fornecida pelo cliente' : 'Compra direta para a OS'}</span>}
                    {i.not_done_reason && <span className="block text-xs text-red-600">{i.not_done_reason}</span>}
                    {r && <span className="block text-xs text-slate-500">Estoque: {r.status === 'reserved' ? 'reservada' : 'consumida'}</span>}</td>
                  <td className="td">{fmtQty(i.quantity)}</td>
                  {o.perms.prices && <td className="td text-right">{brl(i.total_cents)}{Number(i.discount_cents) > 0 && <span className="block text-xs text-slate-500">desc. {brl(i.discount_cents)}</span>}</td>}
                  {o.perms.costs && <td className="td no-print text-right text-slate-500">{i.total_cost_cents !== undefined ? brl(i.total_cost_cents) : '—'}</td>}
                  <td className="td"><StatusBadge map={itemStatus} value={i.status} />{i.executed_confirmed_at && <span className="block text-xs text-emerald-700">revisado</span>}</td>
                  <td className="td no-print"><div className="flex flex-wrap justify-end gap-1">
                    {exec && can('orders.execute') && ['approved', 'in_progress', 'not_done'].includes(i.status) && <>
                      {i.status === 'approved' && <Button size="sm" variant="secondary" onClick={() => act(() => rpc('set_item_progress', { p_item: i.id, p_status: 'in_progress' }))}>Iniciar</Button>}
                      <Button size="sm" onClick={() => act(() => rpc('set_item_progress', { p_item: i.id, p_status: 'done' }), 'Item executado')}>Feito</Button>
                      <Button size="sm" variant="ghost" onClick={() => { const r2 = prompt('Por que não foi executado?'); if (r2) act(() => rpc('set_item_progress', { p_item: i.id, p_status: 'not_done', p_reason: r2 })) }}>Não feito</Button>
                    </>}
                    {exec && can('orders.execute') && i.status === 'done' && <Button size="sm" variant="ghost" onClick={() => act(() => rpc('set_item_progress', { p_item: i.id, p_status: 'in_progress' }))}>Desfazer</Button>}
                    {i.kind === 'part' && i.product_id && i.part_origin === 'stock' && !r && can('inventory.edit') && !['cancelled', 'declined', 'done'].includes(i.status) &&
                      <Button size="sm" variant="secondary" onClick={() => act(() => rpc('reserve_part', { p_item: i.id }), 'Peça reservada')}>Reservar</Button>}
                    {r?.status === 'reserved' && (can('inventory.edit') || can('orders.execute')) && <Button size="sm" variant="secondary" onClick={() => act(() => rpc('consume_reservation', { p_reservation: r.id }), 'Peça consumida')}>Consumir</Button>}
                    {r?.status === 'reserved' && can('inventory.edit') && <Button size="sm" variant="ghost" onClick={() => act(() => rpc('release_reservation', { p_reservation: r.id }))}>Liberar</Button>}
                    {r?.status === 'consumed' && can('inventory.edit') && o.status !== 'delivered' && <Button size="sm" variant="ghost" onClick={() => { const m = prompt('Motivo da devolução ao estoque:'); if (m) act(() => rpc('return_consumed', { p_reservation: r.id, p_reason: m })) }}>Devolver</Button>}
                    {can('orders.edit') && !['done', 'cancelled', 'declined'].includes(i.status) && o.status !== 'delivered' && <Button size="sm" variant="ghost" onClick={() => { const m = prompt('Motivo do cancelamento do item:'); if (m) act(() => rpc('cancel_order_item', { p_item: i.id, p_reason: m })) }}>Cancelar</Button>}
                  </div></td>
                </tr>
              )
            })}</tbody>
          </table>
        </div>
      )}
      {o.status === 'quality_check' && can('orders.execute') && o.items.some((i: any) => i.status === 'done' && !i.executed_confirmed_at) &&
        <div className="mt-3 rounded-md bg-blue-50 p-3 text-sm">Revise os itens executados antes de liberar. <Button size="sm" className="ml-2" onClick={() => act(() => rpc('confirm_items_review', { p_order: o.id }), 'Itens revisados')}>Confirmar revisão dos itens</Button></div>}
    </Card>
  )
}

function SummaryCard({ o, name, reload, onPlan }: { o: any; name: (id: string) => string; reload: () => void; onPlan: () => void }) {
  const { can, tz } = useAuth()
  const toast = useToast()
  const team = useTeam()
  const [assign, setAssign] = useState(false)
  const [sel, setSel] = useState<string[]>(o.assignments)
  async function update(fields: Record<string, unknown>) {
    try { await rpc('update_order', { p_order: o.id, p_expected_version: o.version, p_fields: fields }); reload() } catch (e) { toast.error(e); if (isConflict(e)) reload() }
  }
  return (
    <Card title="Resumo">
      <dl className="space-y-2 text-sm">
        <div><dt className="text-slate-500">Previsão de entrega</dt><dd>{o.expected_delivery_at ? fmtDateTime(o.expected_delivery_at, tz) : '—'}</dd></div>
        <div><dt className="text-slate-500">Combustível</dt><dd>{o.fuel_level !== null ? fuelLabels[o.fuel_level] : '—'}</dd></div>
        <div><dt className="text-slate-500">Responsável</dt><dd>{o.responsible_membership_id ? name(o.responsible_membership_id) : '—'}</dd></div>
        <div><dt className="text-slate-500">Mecânicos</dt><dd>{o.assignments.map(name).join(', ') || '—'} {can('orders.assign') && <button className="no-print text-xs text-brand" onClick={() => setAssign(true)}>alterar</button>}</dd></div>
        <div className="flex items-center justify-between"><dt className="text-slate-500">Pendência de peças</dt>
          <dd>{(can('orders.execute') || can('orders.edit')) && !['delivered', 'cancelled'].includes(o.status)
            ? <Checkbox label={o.parts_pending ? 'Sim' : 'Não'} checked={o.parts_pending} onChange={(v) => update({ parts_pending: v, parts_pending_note: v ? (prompt('Qual peça está pendente?') ?? '') : null })} />
            : o.parts_pending ? 'Sim' : 'Não'}</dd></div>
        {o.parts_pending_note && <p className="text-xs text-amber-700">{o.parts_pending_note}</p>}
        <div><dt className="text-slate-500">Retorno preventivo</dt><dd>
          {o.maintenance_decision === 'registered' ? <Badge tone="green">Plano cadastrado</Badge> : o.maintenance_decision === 'not_applicable' ? <Badge>Não aplicável</Badge> : <Badge tone="amber">A definir</Badge>}
          {!o.maintenance_decision && can('orders.edit') && <div className="no-print mt-1 flex gap-1">
            {can('maintenance.edit') && <Button size="sm" variant="secondary" onClick={onPlan}>Cadastrar plano</Button>}
            <Button size="sm" variant="ghost" onClick={() => update({ maintenance_decision: 'not_applicable', maintenance_decision_note: prompt('Observação (opcional):') ?? '' })}>Não aplicável</Button>
          </div>}
        </dd></div>
        {o.delivered_at && <div><dt className="text-slate-500">Entregue</dt><dd>{fmtDateTime(o.delivered_at, tz)}<br /><span className="text-xs">{o.delivery_payment_note}</span></dd></div>}
      </dl>
      <Modal open={assign} onClose={() => setAssign(false)} title="Mecânicos atribuídos" footer={<Button onClick={async () => { try { await rpc('set_order_assignments', { p_order: o.id, p_members: sel }); setAssign(false); reload() } catch (e) { toast.error(e) } }}>Salvar</Button>}>
        <div className="flex flex-col gap-2">{team.data?.filter((m) => m.status === 'active').map((m) => <Checkbox key={m.id} label={`${m.name}`} checked={sel.includes(m.id)} onChange={(v) => setSel((s) => v ? [...s, m.id] : s.filter((x) => x !== m.id))} />)}</div>
      </Modal>
    </Card>
  )
}

function MoneyCard({ o, reload }: { o: any; reload: () => void }) {
  const { can } = useAuth()
  const [recv, setRecv] = useState(false)
  const fin = useQuery({ queryKey: ['order-account', o.id], enabled: can('finance.view'), queryFn: async () => {
    const { data } = await supabase.from('accounts').select('id, status, total_cents, account_installments(id, seq, due_date, amount_cents, paid_cents)').eq('order_id', o.id).eq('kind', 'receivable').neq('status', 'cancelled').maybeSingle()
    return data
  } })
  const t = o.totals ?? {}
  const balance = fin.data?.account_installments?.reduce((s: number, i: any) => s + Number(i.amount_cents) - Number(i.paid_cents), 0)
  return (
    <Card title="Valores">
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between"><dt>Aprovado</dt><dd className="font-semibold">{brl(t.approved_total_cents ?? 0)}</dd></div>
        {Number(t.pending_total_cents) > 0 && <div className="flex justify-between text-amber-700"><dt>Aguardando aprovação</dt><dd>{brl(t.pending_total_cents)}</dd></div>}
        {Number(t.discount_cents) > 0 && <div className="flex justify-between text-slate-500"><dt>Descontos incluídos</dt><dd>{brl(t.discount_cents)}</dd></div>}
        {o.margin && <div className="no-print mt-2 border-t border-slate-100 pt-2" title={o.margin.definicao}>
          <div className="flex justify-between text-slate-500"><dt>Custos (peças/terceiros)</dt><dd>{brl(o.margin.cost_cents)}</dd></div>
          <div className="flex justify-between"><dt>Margem gerencial</dt><dd>{brl(o.margin.margin_cents)}</dd></div>
          <p className="text-xs text-slate-400">Não é lucro líquido: despesas gerais não alocadas.</p>
        </div>}
      </dl>
      {can('finance.view') && (
        <div className="no-print mt-3 border-t border-slate-100 pt-3 text-sm">
          {fin.data ? <p>Cobrança: {fin.data.status === 'paid' ? <Badge tone="green">Paga</Badge> : <>saldo <strong>{brl(balance)}</strong></>} <Link className="text-brand" to={`/financeiro?conta=${fin.data.id}`}>abrir</Link></p>
            : can('finance.edit') && Number(t.approved_total_cents) > 0 ? <Button size="sm" variant="secondary" onClick={() => setRecv(true)}>Gerar cobrança</Button> : <p className="text-slate-500">Sem cobrança gerada.</p>}
        </div>
      )}
      <ReceivableModal open={recv} onClose={() => { setRecv(false); fin.refetch(); reload() }} orderId={o.id} total={Number(t.approved_total_cents ?? 0)} />
    </Card>
  )
}

function ReceivableModal({ open, onClose, orderId, total }: { open: boolean; onClose: () => void; orderId: string; total: number }) {
  const toast = useToast()
  const [n, setN] = useState(1)
  const [first, setFirst] = useState(new Date().toISOString().slice(0, 10))
  const parts = useMemo(() => Array.from({ length: n }, (_, i) => {
    const base = Math.floor(total / n)
    const d = new Date(`${first}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i)
    return { due_date: d.toISOString().slice(0, 10), amount_cents: i === n - 1 ? total - base * (n - 1) : base }
  }), [n, first, total])
  async function save() {
    try { await rpc('create_order_receivable', { p_order: orderId, p_installments: parts }); toast.success('Cobrança gerada'); onClose() } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Gerar cobrança da OS" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={save}>Gerar</Button></>}>
      <p className="mb-3 text-sm">Total aprovado: <strong>{brl(total)}</strong> (recalculado no servidor).</p>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Parcelas" type="number" min={1} max={12} value={n} onChange={(e) => setN(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} />
        <Input label="1º vencimento" type="date" value={first} onChange={(e) => setFirst(e.target.value)} />
      </div>
      <ul className="mt-3 text-sm">{parts.map((p, i) => <li key={i}>{i + 1}ª — {fmtDate(p.due_date)} — {brl(p.amount_cents)}</li>)}</ul>
    </Modal>
  )
}

function DiagnosisTab({ o, reload }: { o: any; reload: () => void }) {
  const { can } = useAuth()
  const toast = useToast()
  const [f, setF] = useState({ diagnosis: o.diagnosis ?? '', notes_internal: o.notes_internal ?? '', notes_client: o.notes_client ?? '', complaint: o.complaint ?? '' })
  const dirty = f.diagnosis !== (o.diagnosis ?? '') || f.notes_internal !== (o.notes_internal ?? '') || f.notes_client !== (o.notes_client ?? '') || f.complaint !== (o.complaint ?? '')
  useUnsavedWarning(dirty)
  const editTech = (can('orders.execute') || can('orders.edit')) && !['delivered', 'cancelled'].includes(o.status)
  const editCom = can('orders.edit') && !['delivered', 'cancelled'].includes(o.status)
  async function save() {
    const fields: Record<string, string> = {}
    if (f.diagnosis !== (o.diagnosis ?? '')) fields.diagnosis = f.diagnosis
    if (f.notes_internal !== (o.notes_internal ?? '')) fields.notes_internal = f.notes_internal
    if (editCom && f.notes_client !== (o.notes_client ?? '')) fields.notes_client = f.notes_client
    if (editCom && f.complaint !== (o.complaint ?? '')) fields.complaint = f.complaint
    try { await rpc('update_order', { p_order: o.id, p_expected_version: o.version, p_fields: fields }); toast.success('Salvo'); reload() }
    catch (e) { toast.error(e); if (isConflict(e)) reload() }
  }
  return (
    <Card title="Diagnóstico e observações">
      <div className="space-y-3">
        <Textarea label="Queixa do cliente" value={f.complaint} disabled={!editCom} onChange={(e) => setF((s) => ({ ...s, complaint: e.target.value }))} />
        <Textarea label="Diagnóstico técnico" rows={5} value={f.diagnosis} disabled={!editTech} onChange={(e) => setF((s) => ({ ...s, diagnosis: e.target.value }))} />
        <Textarea label="Observações internas (nunca vão para o cliente)" value={f.notes_internal} disabled={!editTech} onChange={(e) => setF((s) => ({ ...s, notes_internal: e.target.value }))} />
        <Textarea label="Observações visíveis ao cliente (portal)" value={f.notes_client} disabled={!editCom} onChange={(e) => setF((s) => ({ ...s, notes_client: e.target.value }))} />
        {(editTech || editCom) && <div className="flex justify-end"><Button disabled={!dirty} onClick={save}>Salvar</Button></div>}
      </div>
    </Card>
  )
}

function ChecklistTab({ o, act }: { o: any; act: (fn: () => Promise<unknown>, ok?: string) => void }) {
  return (
    <div className="space-y-4">
      {(['entry', 'quality'] as const).map((k) => o.checklists[k] && <ChecklistCard key={k} o={o} kind={k} ck={o.checklists[k]} act={act} />)}
      {!o.checklists.entry && !o.checklists.quality && <p className="text-sm text-slate-500">Nenhum modelo de checklist configurado.</p>}
    </div>
  )
}

function ChecklistCard({ o, kind, ck, act }: { o: any; kind: 'entry' | 'quality'; ck: any; act: (fn: () => Promise<unknown>, ok?: string) => void }) {
  const { can, tz } = useAuth()
  const [items, setItems] = useState<any[]>(ck.items)
  const [belongings, setBelongings] = useState(ck.belongings ?? '')
  const [ack, setAck] = useState(ck.client_ack_name ?? '')
  const [test, setTest] = useState(ck.test_notes ?? '')
  const editable = can('orders.execute') && !['delivered', 'cancelled'].includes(o.status)
  const save = (complete: boolean) => act(() => rpc('save_checklist', { p_order: o.id, p_kind: kind, p_items: items, p_belongings: belongings || null, p_complete: complete,
    p_client_ack_name: ack || null, p_test_notes: test || null }), complete ? 'Checklist concluído' : 'Checklist salvo')
  return (
    <Card title={kind === 'entry' ? 'Checklist de entrada' : 'Controle de qualidade e teste'} actions={ck.completed_at ? <Badge tone="green">Concluído {fmtDateTime(ck.completed_at, tz)}</Badge> : <Badge tone="amber">Pendente</Badge>}>
      <ul className="divide-y divide-slate-100">{items.map((it, idx) => (
        <li key={it.key} className="grid gap-2 py-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
          <span className="text-sm">{it.label}</span>
          <div className="flex gap-1" role="radiogroup" aria-label={it.label}>
            {[['ok', 'OK'], ['avaria', kind === 'entry' ? 'Avaria' : 'Problema'], ['na', 'N/A']].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={it.state === v} disabled={!editable}
                className={clsx('min-w-14 rounded border px-2 py-1.5 text-xs', it.state === v ? (v === 'ok' ? 'border-emerald-600 bg-emerald-50 text-emerald-800' : v === 'avaria' ? 'border-red-500 bg-red-50 text-red-700' : 'border-slate-500 bg-slate-100') : 'border-slate-300')}
                onClick={() => setItems((s) => s.map((x, j) => j === idx ? { ...x, state: v } : x))}>{l}</button>
            ))}
          </div>
          <input className="input" aria-label={`Observação: ${it.label}`} placeholder="Observação" value={it.note ?? ''} disabled={!editable} onChange={(e) => setItems((s) => s.map((x, j) => j === idx ? { ...x, note: e.target.value } : x))} />
        </li>
      ))}</ul>
      {kind === 'entry' && <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Textarea label="Objetos deixados no veículo" value={belongings} disabled={!editable} onChange={(e) => setBelongings(e.target.value)} />
        <Input label="Ciência do cliente (nome)" value={ack} disabled={!editable || !!ck.client_ack_at} onChange={(e) => setAck(e.target.value)}
          hint={ck.client_ack_at ? `Registrado em ${fmtDateTime(ck.client_ack_at, tz)}. É um registro de ciência, não certificação jurídica.` : 'Registro de ciência das condições, não é certificação jurídica.'} />
      </div>}
      {kind === 'quality' && <Textarea className="mt-3" label="Teste realizado / observações da liberação" value={test} disabled={!editable} onChange={(e) => setTest(e.target.value)} />}
      {editable && <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={() => save(false)}>Salvar rascunho</Button><Button onClick={() => save(true)}>Concluir checklist</Button></div>}
    </Card>
  )
}

function PhotosTab({ o, reload }: { o: any; reload: () => void }) {
  const { wsId, can } = useAuth()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('diagnostico')
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    const paths = o.attachments.map((a: any) => a.storage_path)
    if (!paths.length) return
    // URLs temporárias (expiram em 10 min): arquivos nunca ficam públicos
    supabase.storage.from('order-files').createSignedUrls(paths, 600).then(({ data }) => {
      const m: Record<string, string> = {}
      data?.forEach((d) => { if (d.signedUrl && d.path) m[d.path] = d.signedUrl })
      setUrls(m)
    })
  }, [o.attachments])
  async function upload(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    try {
      for (const file of Array.from(files)) {
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'].includes(file.type)) throw new Error(`Tipo não permitido: ${file.name}`)
        if (file.size > 15 * 1024 * 1024) throw new Error(`Arquivo acima de 15 MB: ${file.name}`)
        const ext = file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1]
        const path = `${wsId}/${o.id}/${crypto.randomUUID()}.${ext}`
        const up = await supabase.storage.from('order-files').upload(path, file, { contentType: file.type, upsert: false })
        if (up.error) throw up.error
        const { error } = await supabase.from('order_attachments').insert({ workshop_id: wsId, order_id: o.id, storage_path: path, mime_type: file.type, size_bytes: file.size,
          kind: file.type === 'application/pdf' ? 'document' : 'photo', stage })
        if (error) throw error
      }
      toast.success('Arquivo(s) enviado(s)'); reload()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  async function toggle(a: any) {
    const { error } = await supabase.from('order_attachments').update({ visible_to_client: !a.visible_to_client }).eq('id', a.id)
    if (error) toast.error(error); else reload()
  }
  return (
    <Card title="Fotos e anexos" actions={can('orders.execute') && !['delivered', 'cancelled'].includes(o.status) && (
      <div className="flex items-center gap-2">
        <select className="input h-8 w-36 py-0" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Etapa"><option value="entrada">Entrada</option><option value="diagnostico">Diagnóstico</option><option value="execucao">Execução</option><option value="entrega">Entrega</option></select>
        <label className={clsx('inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-brand px-3 text-sm text-white', busy && 'opacity-60')}>
          <Camera className="size-4" />{busy ? 'Enviando…' : 'Foto'}
          <input type="file" accept="image/*,application/pdf" capture="environment" multiple className="sr-only" disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = '' }} />
        </label>
      </div>
    )}>
      {o.attachments.length === 0 ? <p className="text-sm text-slate-500">Nenhum arquivo.</p> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{o.attachments.map((a: any) => (
          <figure key={a.id} className="rounded-md border border-slate-200 p-1">
            {a.kind === 'photo' && urls[a.storage_path] ? <a href={urls[a.storage_path]} target="_blank" rel="noopener noreferrer"><img src={urls[a.storage_path]} alt={a.caption ?? 'Foto da OS'} className="aspect-square w-full rounded object-cover" /></a>
              : <a className="block p-4 text-center text-sm text-brand" href={urls[a.storage_path]} target="_blank" rel="noopener noreferrer">Documento PDF</a>}
            <figcaption className="mt-1 flex items-center justify-between text-xs text-slate-500"><span>{a.stage}</span>
              {can('orders.edit') ? <button onClick={() => toggle(a)} className={a.visible_to_client ? 'text-emerald-700' : ''}>{a.visible_to_client ? 'visível ao cliente' : 'interno'}</button> : <span>{a.visible_to_client ? 'visível ao cliente' : 'interno'}</span>}
            </figcaption>
          </figure>
        ))}</div>
      )}
    </Card>
  )
}

function TimeTab({ o, act, name }: { o: any; act: (fn: () => Promise<unknown>, ok?: string) => void; name: (id: string) => string }) {
  const { can, tz, ws } = useAuth()
  const mine = o.time_entries.find((t: any) => !t.ended_at && t.membership_id === ws?.membership_id)
  const total = (t: any) => Math.round(((t.ended_at ? +new Date(t.ended_at) : Date.now()) - +new Date(t.started_at)) / 60000)
  return (
    <Card title="Apontamento de tempo" actions={can('orders.execute') && (mine
      ? <Button size="sm" variant="secondary" onClick={() => act(() => rpc('timer_stop', { p_entry: mine.id, p_reason: prompt('Motivo da pausa (opcional):') || null }), 'Apontamento pausado')}><Pause className="size-4" />Pausar</Button>
      : o.status === 'in_progress' && <Button size="sm" onClick={() => act(() => rpc('timer_start', { p_order: o.id }), 'Apontamento iniciado')}><Play className="size-4" />Iniciar</Button>)}>
      {o.time_entries.length === 0 ? <p className="text-sm text-slate-500">Sem apontamentos.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">{o.time_entries.map((t: any) => (
          <li key={t.id} className="flex flex-wrap gap-2 py-2"><span className="font-medium">{name(t.membership_id)}</span><span>{fmtDateTime(t.started_at, tz)} → {t.ended_at ? fmtDateTime(t.ended_at, tz) : <Badge tone="violet">em andamento</Badge>}</span>
            <span className="ml-auto text-slate-500">{Math.floor(total(t) / 60)}h{String(total(t) % 60).padStart(2, '0')}</span>
            {t.pause_reason && <span className="w-full text-xs text-slate-500">Pausa: {t.pause_reason}</span>}
            {t.edited_reason && <span className="w-full text-xs text-amber-700">Editado: {t.edited_reason}</span>}</li>
        ))}</ul>
      )}
      <p className="mt-2 text-xs text-slate-400">Tempo apontado é informação operacional e não deve ser usado isoladamente como avaliação de desempenho.</p>
    </Card>
  )
}

function TimelineTab({ o, reload }: { o: any; reload: () => void }) {
  const { can, tz, wsId } = useAuth()
  const toast = useToast()
  const [note, setNote] = useState('')
  async function add() {
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('order_events').insert({ workshop_id: wsId, order_id: o.id, kind: 'note', message: note, author_id: u.user?.id })
    if (error) return toast.error(error)
    setNote(''); reload()
  }
  return (
    <Card title="Linha do tempo">
      {(can('orders.execute') || can('orders.edit')) && <div className="mb-3 flex gap-2"><input className="input" placeholder="Adicionar nota interna" value={note} onChange={(e) => setNote(e.target.value)} /><Button disabled={!note.trim()} onClick={add}>Adicionar</Button></div>}
      <ul className="space-y-2 text-sm">{o.events.map((e: any) => (
        <li key={e.id} className="flex gap-2"><span className="whitespace-nowrap text-slate-500">{fmtDateTime(e.created_at, tz)}</span><span>{e.message}</span>{e.visible_to_client && <Badge tone="blue">cliente vê</Badge>}</li>
      ))}</ul>
    </Card>
  )
}

function AddItemModal({ open, onClose, o, reload }: { open: boolean; onClose: () => void; o: any; reload: () => void }) {
  const { wsId, can } = useAuth()
  const toast = useToast()
  const team = useTeam()
  const empty = { kind: 'service', description: '', qty: '1', price: null as number | null, discount: 0 as number | null, service: '', product: '', origin: 'stock', originNote: '', assigned: '', component: '', onsite: false, channel: 'presencial', who: '', cost: null as number | null }
  const [f, setF] = useState(empty)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setF(empty) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const services = useQuery({ queryKey: ['catalog', wsId], enabled: open, queryFn: async () => (await supabase.from('service_catalog').select('*').eq('workshop_id', wsId).is('archived_at', null).order('name')).data ?? [] })
  const [pq, setPq] = useState('')
  const products = useQuery({ queryKey: ['product-pick', wsId, pq], enabled: open && f.kind === 'part' && pq.length >= 2, queryFn: () => rpc<any[]>('product_list', { p_workshop: wsId, p_q: pq, p_limit: 10 }) })
  const afterApproval = ['approved', 'in_progress', 'quality_check'].includes(o.status)
  async function save() {
    if (busy) return
    setBusy(true)
    try {
      await rpc('add_order_item', { p_order: o.id, p_kind: f.kind, p_description: f.description, p_qty: Number(f.qty.replace(',', '.')), p_unit_price_cents: f.price ?? 0,
        p_discount_cents: f.discount ?? 0, p_service: f.service || null, p_product: f.product || null, p_part_origin: f.origin, p_assigned: f.assigned || null,
        p_maintenance_component: f.component || null, p_unit_cost_cents: f.cost, p_part_origin_note: f.originNote || null,
        p_onsite_authorization: f.onsite ? { channel: f.channel, authorized_by: f.who } : null })
      toast.success(afterApproval && !f.onsite ? 'Item incluído como aditivo pendente de aprovação' : 'Item incluído'); reload(); onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Incluir item na OS" wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!f.description || f.price === null || (f.onsite && !f.who)} onClick={save}>Incluir</Button></>}>
      {afterApproval && <p className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900">A OS já foi aprovada: o novo item fica como <strong>aditivo pendente</strong> e não pode ser executado antes de novo aceite — salvo autorização presencial registrada abaixo.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Tipo" value={f.kind} onChange={(e) => setF((s) => ({ ...s, kind: e.target.value }))}><option value="service">Serviço</option><option value="part">Peça</option><option value="third_party">Serviço de terceiros</option></Select>
        {f.kind === 'service' && <Select label="Do catálogo" value={f.service} onChange={(e) => { const sv = services.data?.find((x) => x.id === e.target.value); setF((s) => ({ ...s, service: e.target.value, description: sv?.name ?? s.description, price: sv ? Number(sv.base_price_cents) : s.price, component: sv?.maintenance_component ?? s.component })) }}>
          <option value="">— livre —</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.name} · {brl(s.base_price_cents)}</option>)}
        </Select>}
        {f.kind === 'part' && <>
          <Select label="Origem da peça" value={f.origin} onChange={(e) => setF((s) => ({ ...s, origin: e.target.value, product: e.target.value === 'stock' ? s.product : '' }))}>
            <option value="stock">Estoque da oficina</option><option value="client_supplied">Fornecida pelo cliente</option><option value="direct_purchase">Compra direta para esta OS</option>
          </Select>
          {f.origin === 'stock' ? <div className="sm:col-span-2"><Input label="Buscar peça no estoque" value={pq} onChange={(e) => setPq(e.target.value)} />
            <ul className="mt-1 max-h-40 overflow-y-auto">{products.data?.map((p) => (
              <li key={p.id}><button type="button" className={clsx('w-full rounded px-2 py-1 text-left text-sm', f.product === p.id ? 'bg-brand-soft' : 'hover:bg-slate-50')}
                onClick={() => setF((s) => ({ ...s, product: p.id, description: p.name, price: Number(p.sale_price_cents ?? 0) }))}>{p.sku} · {p.name} · disp. {fmtQty(p.available)} {p.unit}</button></li>
            ))}</ul></div>
            : <Input className="sm:col-span-2" label="Observação de responsabilidade" value={f.originNote} onChange={(e) => setF((s) => ({ ...s, originNote: e.target.value }))} placeholder="Ex.: peça trazida pelo cliente, sem garantia da oficina sobre a peça" />}
        </>}
        <Input className="sm:col-span-2" label="Descrição" value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} />
        <Input label="Quantidade" inputMode="decimal" value={f.qty} onChange={(e) => setF((s) => ({ ...s, qty: e.target.value }))} />
        <MoneyInput label="Preço unitário (R$)" cents={f.price} onCents={(c) => setF((s) => ({ ...s, price: c }))} />
        <MoneyInput label="Desconto (R$)" cents={f.discount} onCents={(c) => setF((s) => ({ ...s, discount: c }))} />
        {can('costs.view') && f.kind !== 'service' && <MoneyInput label="Custo unitário (R$)" cents={f.cost} onCents={(c) => setF((s) => ({ ...s, cost: c }))} />}
        {f.kind === 'service' && <Select label="Componente preventivo atendido" value={f.component} onChange={(e) => setF((s) => ({ ...s, component: e.target.value }))}>
          <option value="">Nenhum</option>{COMPONENTS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </Select>}
        <Select label="Mecânico do item" value={f.assigned} onChange={(e) => setF((s) => ({ ...s, assigned: e.target.value }))}>
          <option value="">—</option>{team.data?.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        {can('quotes.approve_onsite') && <div className="rounded-md border border-slate-200 p-3 sm:col-span-2">
          <Checkbox label="Cliente autorizou este item (registrar autorização)" checked={f.onsite} onChange={(v) => setF((s) => ({ ...s, onsite: v }))} />
          {f.onsite && <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Select label="Canal" value={f.channel} onChange={(e) => setF((s) => ({ ...s, channel: e.target.value }))}><option value="presencial">Presencial</option><option value="telefone">Telefone</option><option value="whatsapp">WhatsApp</option></Select>
            <Input label="Nome de quem autorizou" value={f.who} onChange={(e) => setF((s) => ({ ...s, who: e.target.value }))} />
          </div>}
        </div>}
      </div>
    </Modal>
  )
}

export function PortalLinkModal({ open, onClose, orderId, quoteId, purpose = 'track', clientPhone, clientName, clientId }: { open: boolean; onClose: () => void; orderId?: string; quoteId?: string; purpose?: 'track' | 'approve'; clientPhone?: string; clientName?: string; clientId?: string }) {
  const toast = useToast()
  const { ws, wsId } = useAuth()
  const [res, setRes] = useState<{ token: string; code: string | null; expires_at: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!open) setRes(null) }, [open])
  async function gen() {
    setBusy(true)
    try {
      const r = await rpc<any[]>('create_portal_link', { p_purpose: purpose, p_order: orderId ?? null, p_quote: quoteId ?? null, p_valid_days: purpose === 'approve' ? 7 : 30 })
      setRes(Array.isArray(r) ? r[0] : r)
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  const url = res ? portalUrl(res.token) : ''
  const first = clientName?.split(' ')[0] ?? ''
  const msgLink = purpose === 'approve' ? `Olá, ${first}! O orçamento da ${ws?.name} está disponível: ${url}` : `Olá, ${first}! Acompanhe o atendimento do seu veículo na ${ws?.name}: ${url}`
  const msgCode = res?.code ? `Seu código para aprovar o orçamento na ${ws?.name}: ${res.code}. Não compartilhe.` : ''
  const logOpen = (m: string) => { if (clientId) rpc('log_contact', { p_workshop: wsId, p_client: clientId, p_channel: 'whatsapp', p_kind: 'conversation_opened', p_message: m, p_outcome: null, p_order: orderId ?? null }).catch(() => {}) }
  return (
    <Modal open={open} onClose={onClose} title={purpose === 'approve' ? 'Link de aprovação do orçamento' : 'Link de acompanhamento para o cliente'}>
      {!res ? (
        <div className="space-y-3 text-sm">
          <p>Gera um link seguro e individual. {purpose === 'approve' ? 'Para aprovar, o cliente também precisa de um código de 6 dígitos — envie-o em mensagem separada.' : 'O cliente vê etapa, itens aprovados, fotos liberadas e previsão — nunca notas internas ou custos.'}</p>
          <p className="text-xs text-slate-500">Gerar um novo link de aprovação revoga o anterior.</p>
          <Button loading={busy} onClick={gen}>Gerar link</Button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <Input label="Link" readOnly value={url} onFocus={(e) => e.target.select()} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard.writeText(url); toast.success('Link copiado') }}>Copiar link</Button>
            {clientPhone && <a className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-3 text-white" target="_blank" rel="noopener noreferrer" href={waLink(clientPhone, msgLink) ?? '#'} onClick={() => logOpen('link do portal')}><MessageCircle className="size-4" />Enviar link no WhatsApp</a>}
          </div>
          {res.code && <>
            <div className="rounded-md bg-amber-50 p-3"><p>Código de verificação: <strong className="text-lg tracking-widest">{res.code}</strong></p><p className="text-xs text-amber-900">Mostrado só agora. Envie por um canal do cliente (ex.: WhatsApp). 5 tentativas erradas bloqueiam o link.</p></div>
            {clientPhone && <a className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 px-3" target="_blank" rel="noopener noreferrer" href={waLink(clientPhone, msgCode) ?? '#'}>Enviar código no WhatsApp</a>}
          </>}
          <p className="text-xs text-slate-500">Válido até {fmtDateTime(res.expires_at)}. O WhatsApp é aberto com o texto pronto; o envio é feito por você e não é confirmado automaticamente.</p>
        </div>
      )}
    </Modal>
  )
}

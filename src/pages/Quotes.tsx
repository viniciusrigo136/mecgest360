import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, FileDown, Plus, Trash2, User } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { ClientSheet } from '@/components/ClientSheet'
import { type Picked } from '@/components/pickers'
import { loadWorkshopDoc } from '@/lib/workshop'
import { Badge, Button, Card, Checkbox, ErrorBox, Input, Loading, Modal, MoneyInput, PageHeader, Pager, Select, StatusBadge, Table, Textarea, useToast, useUnsavedWarning } from '@/components/ui'
import { brl, fmtDate, fmtDateTime, fmtPlate, fmtQty, todayLocal } from '@/lib/format'
import { COMPONENTS, kindLabel, quoteStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'
import { PortalLinkModal } from './Orders'

const PAGE = 25

export function QuotesPage() {
  const { wsId, can, tz } = useAuth()
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(0)
  const q = useQuery({ queryKey: ['quotes', wsId, status, page], queryFn: async () => {
    let s = supabase.from('quotes').select('id, number, status, is_addendum, created_at, order_id, clients(name), vehicles(plate, internal_code, model), quote_versions!quotes_current_version_fk(total_cents, valid_until, version_no)', { count: 'exact' })
      .eq('workshop_id', wsId).order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1)
    if (status) s = s.eq('status', status)
    const { data, error, count } = await s
    if (error) throw error
    return { rows: data ?? [], count: count ?? 0 }
  } })
  return (
    <div>
      <PageHeader title="Orçamentos" actions={can('quotes.create') && <Link to="/orcamentos/novo" className="inline-flex h-10 items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-medium text-white"><Plus className="size-4" />Fazer orçamento</Link>} />
      <div className="card">
        <div className="p-3 sm:w-64"><Select label="Situação" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }}><option value="">Todas</option>{Object.entries(quoteStatus).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select></div>
        {q.error ? <div className="p-3"><ErrorBox error={q.error} /></div> : q.isLoading ? <Loading /> : <>
          <Table head={['Número', 'Cliente', 'Veículo', 'Total', 'Validade', 'Criado', 'Situação']} empty={!q.data?.rows.length}>
            {q.data?.rows.map((r: any) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="td font-medium"><Link className="text-brand" to={`/orcamentos/${r.id}`}>{r.number}</Link>{r.quote_versions?.version_no > 1 && <span className="text-xs text-slate-500"> v{r.quote_versions.version_no}</span>}{r.is_addendum && <Badge tone="violet">aditivo</Badge>}</td>
                <td className="td">{r.clients?.name}</td><td className="td">{fmtPlate(r.vehicles?.plate ?? r.vehicles?.internal_code)} {r.vehicles?.model}</td>
                <td className="td">{brl(r.quote_versions?.total_cents)}</td><td className="td">{fmtDate(r.quote_versions?.valid_until)}</td>
                <td className="td">{fmtDate(r.created_at, tz)}</td><td className="td"><StatusBadge map={quoteStatus} value={r.status} /></td>
              </tr>
            ))}
          </Table>
          <Pager page={page} pageSize={PAGE} total={q.data?.count ?? 0} onPage={setPage} />
        </>}
      </div>
    </div>
  )
}

type Line = { key: string; kind: string; description: string; service_id?: string | null; product_id?: string | null; quantity: string; unit_price_cents: number | null; discount_cents: number | null; group_key: string; priority: string; maintenance_component: string }
const newLine = (): Line => ({ key: crypto.randomUUID(), kind: 'service', description: '', quantity: '1', unit_price_cents: null, discount_cents: 0, group_key: '', priority: 'media', maintenance_component: '' })

export function QuoteEditor() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const { wsId, can, tz, ws } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const nav = useNavigate()
  const orderId = params.get('order')
  const [picked, setPicked] = useState<Picked | null>(null)
  const [lines, setLines] = useState<Line[]>([newLine()])
  const [meta, setMeta] = useState({ valid_until: todayLocal(tz, 7), estimated_days: '', conditions: '', payment_terms: '', notes_client: '' })
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)
  useUnsavedWarning(dirty)

  const data = useQuery({ queryKey: ['quote', id], enabled: !!id, queryFn: async () => {
    const { data: q, error } = await supabase.from('quotes').select('*, clients(name, whatsapp_norm), vehicles(plate, internal_code, brand, model, year_model)').eq('id', id!).single()
    if (error) throw error
    const { data: versions } = await supabase.from('quote_versions').select('*').eq('quote_id', id!).order('version_no', { ascending: false })
    const cur = versions?.find((v) => v.id === q.current_version_id)
    const { data: items } = await supabase.from('quote_items').select('*').eq('version_id', q.current_version_id).order('sort')
    const { data: decision } = await supabase.from('quote_decisions').select('*').eq('version_id', q.current_version_id).maybeSingle()
    return { q, versions: versions ?? [], cur, items: items ?? [], decision }
  } })
  const order = useQuery({ queryKey: ['quote-order', orderId], enabled: !!orderId && !id, queryFn: () => rpc<any>('order_detail', { p_order: orderId }) })
  const services = useQuery({ queryKey: ['catalog', wsId], queryFn: async () => (await supabase.from('service_catalog').select('*').eq('workshop_id', wsId).is('archived_at', null).order('name')).data ?? [] })

  useEffect(() => {
    if (order.data) setPicked({ clientId: order.data.client.id, clientName: order.data.client.name, vehicleId: order.data.vehicle_id, vehicleLabel: '' })
  }, [order.data])
  useEffect(() => {
    const d = data.data
    if (!d) return
    setPicked({ clientId: d.q.client_id, clientName: d.q.clients?.name, vehicleId: d.q.vehicle_id, vehicleLabel: '' })
    setLines(d.items.map((i: any) => ({ key: i.id, kind: i.kind, description: i.description, service_id: i.service_id, product_id: i.product_id, quantity: String(Number(i.quantity)),
      unit_price_cents: Number(i.unit_price_cents), discount_cents: Number(i.discount_cents), group_key: i.group_key ?? '', priority: i.priority, maintenance_component: i.maintenance_component ?? '' })))
    if (d.cur) setMeta({ valid_until: d.cur.valid_until, estimated_days: d.cur.estimated_days ?? '', conditions: d.cur.conditions ?? '', payment_terms: d.cur.payment_terms ?? '', notes_client: d.cur.notes_client ?? '' })
    setDirty(false)
  }, [data.data])

  const totals = useMemo(() => lines.reduce((s, l) => {
    const gross = Math.round(Number(l.quantity.replace(',', '.') || 0) * (l.unit_price_cents ?? 0))
    return { gross: s.gross + gross, disc: s.disc + (l.discount_cents ?? 0) }
  }, { gross: 0, disc: 0 }), [lines])
  const locked = !!data.data?.cur?.locked_at
  const decided = ['approved', 'partially_approved', 'declined'].includes(data.data?.q.status ?? '')
  const editable = can('quotes.create') && !decided
  const upd = (k: string, patch: Partial<Line>) => { setDirty(true); setLines((s) => s.map((l) => l.key === k ? { ...l, ...patch } : l)) }

  async function save(): Promise<string | null> {
    if (!picked?.vehicleId) { toast.error({ message: 'Selecione cliente e veículo' }); return null }
    setBusy(true)
    try {
      const qid = await rpc<string>('save_quote', { p_workshop: wsId, p_quote: id ?? null, p_client: picked.clientId, p_vehicle: picked.vehicleId, p_order: id ? null : orderId,
        p_valid_until: meta.valid_until, p_conditions: meta.conditions || null, p_payment_terms: meta.payment_terms || null, p_estimated_days: meta.estimated_days ? Number(meta.estimated_days) : null,
        p_notes_client: meta.notes_client || null,
        p_items: lines.filter((l) => l.description).map((l, i) => ({ kind: l.kind, description: l.description, service_id: l.service_id ?? '', product_id: l.product_id ?? '',
          quantity: Number(l.quantity.replace(',', '.')), unit_price_cents: l.unit_price_cents ?? 0, discount_cents: l.discount_cents ?? 0, group_key: l.group_key,
          priority: l.priority, maintenance_component: l.maintenance_component, sort: i })) })
      setDirty(false)
      toast.success(locked ? 'Nova versão criada (a anterior foi substituída)' : 'Orçamento salvo')
      qc.invalidateQueries({ queryKey: ['quote', qid] }); qc.invalidateQueries({ queryKey: ['quotes'] })
      if (!id) nav(`/orcamentos/${qid}`, { replace: true })
      return qid
    } catch (e) { toast.error(e); return null } finally { setBusy(false) }
  }
  async function send() {
    const qid = dirty || !id ? await save() : id
    if (!qid) return
    try { await rpc('send_quote', { p_quote: qid }); toast.success('Orçamento enviado e travado'); qc.invalidateQueries({ queryKey: ['quote', qid] }); setModal('link') } catch (e) { toast.error(e) }
  }

  if (id && data.isLoading) return <Loading />
  if (data.error) return <ErrorBox error={data.error} />
  const d = data.data
  return (
    <div>
      <PageHeader title={d ? <span className="flex items-center gap-2">{d.q.number} <span className="text-sm font-normal text-slate-500">versão {d.cur?.version_no}</span><StatusBadge map={quoteStatus} value={d.q.status} />{d.q.is_addendum && <Badge tone="violet">aditivo</Badge>}</span> : orderId ? 'Novo orçamento da OS' : 'Novo orçamento'}
        subtitle={d && <>{d.q.clients?.name} · {fmtPlate(d.q.vehicles?.plate ?? d.q.vehicles?.internal_code)} {d.q.vehicles?.brand} {d.q.vehicles?.model} {d.q.order_id && <Link className="text-brand" to={`/os/${d.q.order_id}`}>· ver OS</Link>}</>}
        actions={<div className="no-print flex flex-wrap gap-2">
          {editable && <Button variant="secondary" loading={busy} onClick={save}>{locked ? 'Salvar como nova versão' : 'Salvar rascunho'}</Button>}
          {editable && can('quotes.send') && d?.q.status !== 'sent' && <Button onClick={send}>Mandar para o cliente</Button>}
          {d?.q.status === 'sent' && can('quotes.send') && <Button variant="secondary" onClick={() => setModal('link')}>Link de aprovação</Button>}
          {d?.q.status === 'sent' && can('quotes.approve_onsite') && <Button onClick={() => setModal('decide')}>Cliente respondeu</Button>}
          {d && ['approved', 'partially_approved'].includes(d.q.status) && !d.q.order_id && can('orders.create') && <Button onClick={async () => { try { const oid = await rpc<string>('convert_quote_to_order', { p_quote: d.q.id }); nav(`/os/${oid}`) } catch (e) { toast.error(e) } }}>Aprovado? Abrir serviço</Button>}
          {d && <Button variant="secondary" onClick={() => quotePdf(d, wsId).catch((e) => toast.error(e))}><FileDown className="size-4" />PDF</Button>}
        </div>} />
      {locked && editable && <p className="no-print mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Esta versão já foi enviada e está travada. Alterar itens ou preços cria uma <strong>nova versão</strong>; a atual deixa de poder ser aprovada e o link anterior é revogado.</p>}
      {d?.decision && <p className="mb-3 rounded-md bg-slate-100 p-3 text-sm">Decisão: <strong>{quoteStatus[d.decision.decision][0]}</strong> por {d.decision.decided_by_name} via {d.decision.channel}{d.decision.recorded_by && ' (registrado pela oficina)'} em {fmtDateTime(d.decision.created_at, tz)} — total aprovado {brl(d.decision.total_approved_cents)}. {d.decision.evidence?.code_verified && 'Código de verificação conferido.'}</p>}

      {/* Cabeçalho do documento impresso (sem custos/margens) */}
      <div className="mb-4 hidden print:block">
        <h2 className="text-lg font-semibold">{ws?.name} — Orçamento {d?.q.number} (v{d?.cur?.version_no})</h2>
        <p className="text-sm">Cliente: {d?.q.clients?.name} · Veículo: {fmtPlate(d?.q.vehicles?.plate)} {d?.q.vehicles?.brand} {d?.q.vehicles?.model} · Validade: {fmtDate(meta.valid_until)}</p>
      </div>

      {!id && <Card title="Cliente e veículo" className="mb-4 no-print">{orderId ? (order.isLoading ? <Loading /> : <p className="text-sm">{order.data?.client.name} · {order.data?.vehicle?.model}</p>) : <button onClick={() => setSheet(true)} className="flex w-full items-center gap-3 rounded-2xl border-2 border-brand bg-card p-3 text-left">
            <span className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand"><User className="size-5" /></span>
            {picked ? <span className="min-w-0 flex-1"><span className="block truncate font-semibold uppercase">{picked.clientName}</span><span className="text-sm text-slate-500">{picked.vehicleLabel}</span></span>
              : <span className="flex-1"><span className="block font-bold text-brand-strong">Escolher cliente e carro</span><span className="text-sm text-slate-500">Busque pelo nome ou placa</span></span>}
            <ChevronRight className="size-5 text-slate-400" />
          </button>}</Card>}
      <ClientSheet open={sheet} onClose={() => setSheet(false)} onPick={(v) => { setPicked({ clientId: v.clientId, clientName: v.clientName, vehicleId: v.vehicleId, vehicleLabel: [v.plate, v.label].filter(Boolean).join(' ') }); setDirty(true); setSheet(false) }} />

      <Card title="Itens" actions={editable && <Button size="sm" variant="secondary" className="no-print" onClick={() => { setDirty(true); setLines((s) => [...s, newLine()]) }}><Plus className="size-4" />Linha</Button>}>
        <div className="space-y-3">
          {lines.map((l) => {
            const total = Math.round(Number(l.quantity.replace(',', '.') || 0) * (l.unit_price_cents ?? 0)) - (l.discount_cents ?? 0)
            return (
              <div key={l.key} className="grid gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-12">
                <Select className="sm:col-span-2" label="Tipo" value={l.kind} disabled={!editable} onChange={(e) => upd(l.key, { kind: e.target.value })}>
                  {Object.entries(kindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                <div className="sm:col-span-4"><Input label="Descrição" value={l.description} disabled={!editable} list={`svc-${l.key}`}
                  onChange={(e) => { const sv = services.data?.find((s) => s.name === e.target.value); upd(l.key, { description: e.target.value, ...(sv ? { service_id: sv.id, unit_price_cents: Number(sv.base_price_cents), maintenance_component: sv.maintenance_component ?? '' } : {}) }) }} />
                  <datalist id={`svc-${l.key}`}>{services.data?.map((s) => <option key={s.id} value={s.name} />)}</datalist></div>
                <Input className="sm:col-span-1" label="Qtd" inputMode="decimal" value={l.quantity} disabled={!editable} onChange={(e) => upd(l.key, { quantity: e.target.value })} />
                <div className="sm:col-span-2"><MoneyInput label="Unitário" cents={l.unit_price_cents} disabled={!editable} onCents={(c) => upd(l.key, { unit_price_cents: c })} /></div>
                <div className="sm:col-span-2"><MoneyInput label="Desconto" cents={l.discount_cents} disabled={!editable} onCents={(c) => upd(l.key, { discount_cents: c })} /></div>
                <div className="flex items-end justify-between sm:col-span-1"><span className="pb-2 text-sm font-semibold">{brl(total)}</span>
                  {editable && <button className="no-print pb-2 text-slate-400 hover:text-red-600" aria-label="Remover linha" onClick={() => { setDirty(true); setLines((s) => s.filter((x) => x.key !== l.key)) }}><Trash2 className="size-4" /></button>}</div>
                <details className="no-print sm:col-span-12"><summary className="cursor-pointer text-sm text-slate-500">Mais opções</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  <Input label="Conjunto (aprovar junto)" value={l.group_key} disabled={!editable} onChange={(e) => upd(l.key, { group_key: e.target.value })} hint="Itens com o mesmo nome de conjunto só podem ser aprovados juntos (ex.: peça + mão de obra)." />
                  <Select label="Prioridade (definida pelo mecânico)" value={l.priority} disabled={!editable} onChange={(e) => upd(l.key, { priority: e.target.value })}>
                    <option value="baixa">Baixa</option><option value="media">Média</option><option value="alta">Alta</option><option value="critica">Crítica (comunicar pessoalmente)</option>
                  </Select>
                  {l.kind === 'service' && <Select label="Componente preventivo" value={l.maintenance_component} disabled={!editable} onChange={(e) => upd(l.key, { maintenance_component: e.target.value })}>
                    <option value="">Nenhum</option>{COMPONENTS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </Select>}
                </div></details>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-col items-end gap-1 text-sm">
          <p>Subtotal: {brl(totals.gross)}</p>{totals.disc > 0 && <p>Descontos: −{brl(totals.disc)}</p>}
          <p className="text-lg font-semibold">Total: {brl(totals.gross - totals.disc)}</p>
          <p className="text-xs text-slate-400">Valores conferidos e recalculados no servidor ao salvar.</p>
        </div>
      </Card>

      <Card title="Condições" className="mt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Válido até" type="date" value={meta.valid_until} disabled={!editable} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, valid_until: e.target.value })) }} />
          <Input label="Prazo estimado (dias)" inputMode="numeric" value={meta.estimated_days} disabled={!editable} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, estimated_days: e.target.value })) }} />
          <Textarea label="Formas de pagamento" value={meta.payment_terms} disabled={!editable} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, payment_terms: e.target.value })) }} />
          <Textarea label="Condições comerciais / garantia" value={meta.conditions} disabled={!editable} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, conditions: e.target.value })) }} />
          <Textarea className="sm:col-span-2" label="Observações ao cliente" value={meta.notes_client} disabled={!editable} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, notes_client: e.target.value })) }} />
        </div>
      </Card>

      {d && d.versions.length > 1 && <Card title="Histórico de versões" className="no-print mt-4">
        <ul className="text-sm">{d.versions.map((v: any) => <li key={v.id} className="flex gap-3 py-1">v{v.version_no}<StatusBadge map={quoteStatus} value={v.status} />{brl(v.total_cents)}<span className="text-slate-500">{fmtDateTime(v.created_at, tz)}</span></li>)}</ul>
      </Card>}

      {d && <DecideModal open={modal === 'decide'} onClose={() => setModal(null)} quoteId={d.q.id} items={d.items} onDone={() => qc.invalidateQueries({ queryKey: ['quote', id] })} />}
      {d && <PortalLinkModal open={modal === 'link'} onClose={() => setModal(null)} quoteId={d.q.id} orderId={d.q.order_id ?? undefined} purpose="approve" clientPhone={d.q.clients?.whatsapp_norm} clientName={d.q.clients?.name} clientId={d.q.client_id} />}
    </div>
  )
}

function DecideModal({ open, onClose, quoteId, items, onDone }: { open: boolean; onClose: () => void; quoteId: string; items: any[]; onDone: () => void }) {
  const toast = useToast()
  const [sel, setSel] = useState<string[]>([])
  const [f, setF] = useState({ channel: 'presencial', name: '', note: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setSel(items.map((i) => i.id)) }, [open, items])
  const total = items.filter((i) => sel.includes(i.id)).reduce((s, i) => s + Number(i.total_cents), 0)
  async function go() {
    setBusy(true)
    try {
      const r = await rpc<string>('record_quote_decision', { p_quote: quoteId, p_approved: sel, p_channel: f.channel, p_name: f.name, p_note: f.note })
      toast.success(`Decisão registrada: ${quoteStatus[r][0]}`); onDone(); onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Registrar decisão do cliente (pela oficina)" wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!f.name} onClick={go}>Confirmar decisão</Button></>}>
      <p className="mb-3 text-sm text-slate-600">Use quando o cliente decidir presencialmente ou por telefone. Fica identificado como registro feito pela oficina, com seu usuário.</p>
      <ul className="mb-3 divide-y divide-slate-100">{items.map((i) => (
        <li key={i.id} className="flex items-center gap-2 py-2"><Checkbox label={<>{i.description} {i.group_key && <Badge tone="violet">conjunto {i.group_key}</Badge>}</>} checked={sel.includes(i.id)}
          onChange={(v) => setSel((s) => v ? [...s, i.id] : s.filter((x) => x !== i.id))} /><span className="ml-auto text-sm">{fmtQty(i.quantity)} × {brl(i.unit_price_cents)} = {brl(i.total_cents)}</span></li>
      ))}</ul>
      <p className="mb-3 text-sm">Total aprovado: <strong>{brl(total)}</strong> {sel.length === 0 && '(recusa total)'}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Canal" value={f.channel} onChange={(e) => setF((s) => ({ ...s, channel: e.target.value }))}><option value="presencial">Presencial</option><option value="telefone">Telefone</option><option value="whatsapp">WhatsApp</option><option value="email">E-mail</option></Select>
        <Input label="Nome de quem decidiu" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} />
        <Textarea className="sm:col-span-2" label="Observação" value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} />
      </div>
    </Modal>
  )
}

/** PDF A4 do orçamento com logo e QR Code Pix (sem custos). */
async function quotePdf(d: any, wsId: string) {
  const [workshop, { buildPdf, sharePdf }] = await Promise.all([loadWorkshopDoc(wsId), import('@/lib/pdf')])
  const blob = await buildPdf({
    kind: 'ORÇAMENTO', number: d.cur?.version_no > 1 ? `${d.q.number} (v${d.cur.version_no})` : d.q.number, date: d.cur?.created_at ?? d.q.created_at, workshop,
    client: { name: d.q.clients?.name ?? '', phone: d.q.clients?.whatsapp_norm },
    vehicle: { plate: d.q.vehicles?.plate ?? d.q.vehicles?.internal_code, label: [d.q.vehicles?.brand, d.q.vehicles?.model, d.q.vehicles?.year_model].filter(Boolean).join(' ') },
    items: d.items.map((i: any) => ({ description: i.description, quantity: Number(i.quantity), unit_cents: Number(i.unit_price_cents), discount_cents: Number(i.discount_cents), total_cents: Number(i.total_cents) })),
    total_cents: Number(d.cur?.total_cents ?? 0), discount_cents: Number(d.cur?.discount_cents ?? 0),
    notes: [d.cur?.estimated_days && `Prazo estimado: ${d.cur.estimated_days} dia(s).`, d.cur?.payment_terms && `Pagamento: ${d.cur.payment_terms}`, d.cur?.conditions, d.cur?.notes_client],
    validity: d.cur?.valid_until, pix: true,
  })
  await sharePdf(blob, `Orcamento-${d.q.number}.pdf`, `Orçamento ${d.q.number}`)
}

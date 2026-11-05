import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { QuickRegisterModal } from '@/components/pickers'
import { Badge, Button, Card, ErrorBox, Input, Loading, Modal, PageHeader, Pager, Select, StatusBadge, Table, Tabs, Textarea, useToast, useUnsavedWarning } from '@/components/ui'
import { downloadText, toCSV } from '@/lib/csv'
import { brl, fmtDate, fmtDateTime, fmtPhone, fmtPlate } from '@/lib/format'
import { orderStatus, quoteStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'
import { waLink } from '@/lib/whatsapp'

const PAGE = 25

export function ClientsPage() {
  const { wsId, can } = useAuth()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [creating, setCreating] = useState(() => new URLSearchParams(location.search).get('novo') === '1')
  const nav = useNavigate()
  const list = useQuery({
    queryKey: ['clients', wsId, q, page],
    queryFn: async () => {
      let s = supabase.from('clients').select('id, name, phone, email, kind, document, created_at', { count: 'exact' })
        .eq('workshop_id', wsId).is('archived_at', null).is('merged_into', null).order('name').range(page * PAGE, page * PAGE + PAGE - 1)
      if (q.trim()) s = s.ilike('search', `%${q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}%`)
      const { data, error, count } = await s
      if (error) throw error
      return { rows: data ?? [], count: count ?? 0 }
    },
  })
  async function exportCsv() {
    try {
      const { data, error } = await supabase.from('clients').select('name, phone, email, document, kind').eq('workshop_id', wsId).is('archived_at', null).limit(5000)
      if (error) throw error
      await rpc('log_export', { p_workshop: wsId, p_resource: 'clients', p_filters: { q }, p_rows: data.length })
      downloadText('clientes.csv', toCSV(data, [{ key: 'name', label: 'Nome' }, { key: 'phone', label: 'Telefone' }, { key: 'email', label: 'E-mail' }, { key: 'document', label: 'Documento' }, { key: 'kind', label: 'Tipo' }]))
    } catch (e) { toast.error(e) }
  }
  return (
    <div>
      <PageHeader title="Clientes" actions={<>
        {can('clients.export') && can('reports.export') && <Button variant="secondary" onClick={exportCsv}>Exportar CSV</Button>}
        {can('clients.create') && <Button onClick={() => setCreating(true)}><Plus className="size-4" />Novo cliente</Button>}
      </>} />
      <div className="card">
        <div className="p-3"><Input label="Buscar" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Nome, telefone, documento ou e-mail" /></div>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} onRetry={() => list.refetch()} /></div> : list.isLoading ? <Loading /> : (
          <>
            <Table head={['Nome', 'Telefone', 'E-mail', 'Tipo']} empty={!list.data?.rows.length}>
              {list.data?.rows.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/clientes/${c.id}`)}>
                  <td className="td font-medium"><Link to={`/clientes/${c.id}`}>{c.name}</Link></td>
                  <td className="td">{fmtPhone(c.phone)}</td><td className="td">{c.email}</td><td className="td uppercase">{c.kind}</td>
                </tr>
              ))}
            </Table>
            <Pager page={page} pageSize={PAGE} total={list.data?.count ?? 0} onPage={setPage} />
          </>
        )}
      </div>
      <ClientFormModal open={creating} onClose={() => setCreating(false)} onSaved={(id) => nav(`/clientes/${id}`)} />
    </div>
  )
}

export function ClientFormModal({ open, onClose, onSaved, client }: { open: boolean; onClose: () => void; onSaved?: (id: string) => void; client?: any }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const empty = { kind: 'pf', name: '', trade_name: '', phone: '', whatsapp: '', email: '', document: '', notes_internal: '', preferred_channel: 'whatsapp', source: '', street: '', city: '', state: '', zip: '' }
  const [f, setF] = useState(empty)
  const [dirty, setDirty] = useState(false)
  const [dups, setDups] = useState<any[]>([])
  useUnsavedWarning(open && dirty)
  useEffect(() => {
    if (!open) return
    setDirty(false)
    setF(client ? { ...empty, ...Object.fromEntries(Object.entries(client).map(([k, v]) => [k, v ?? ''])), ...(client.address ?? {}) } : empty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client])
  useEffect(() => {
    if (!open || (!f.phone && !f.document)) return setDups([])
    const t = setTimeout(() => rpc<any[]>('client_possible_duplicates', { p_workshop: wsId, p_phone: f.phone, p_document: f.document, p_exclude: client?.id ?? null })
      .then(setDups).catch(() => {}), 400)
    return () => clearTimeout(t)
  }, [f.phone, f.document, open, wsId, client?.id])
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => { setDirty(true); setF((s) => ({ ...s, [k]: e.target.value })) }
  const save = useMutation({
    mutationFn: async () => {
      const row = { workshop_id: wsId, kind: f.kind, name: f.name.trim(), trade_name: f.trade_name || null, phone: f.phone || null, whatsapp: f.whatsapp || null,
        email: f.email || null, document: f.document || null, notes_internal: f.notes_internal || null, preferred_channel: f.preferred_channel, source: f.source || null,
        address: { street: f.street, city: f.city, state: f.state, zip: f.zip } }
      if (client) {
        const { data, error } = await supabase.from('clients').update(row).eq('id', client.id).eq('version', client.version).select('id')
        if (error) throw error
        if (!data?.length) throw { code: '40001' }
        return client.id as string
      }
      const { data, error } = await supabase.from('clients').insert(row).select('id').single()
      if (error) throw error
      return data.id as string
    },
    onSuccess: (id) => { setDirty(false); qc.invalidateQueries({ queryKey: ['clients'] }); qc.invalidateQueries({ queryKey: ['client', id] }); toast.success('Cliente salvo'); onClose(); onSaved?.(id) },
    onError: (e) => toast.error(e),
  })
  return (
    <Modal open={open} onClose={onClose} title={client ? 'Editar cliente' : 'Novo cliente'} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={save.isPending} onClick={() => save.mutate()} disabled={f.name.trim().length < 2}>Salvar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Tipo" value={f.kind} onChange={set('kind')}><option value="pf">Pessoa física</option><option value="pj">Pessoa jurídica</option></Select>
        <Input label="Nome *" value={f.name} onChange={set('name')} required />
        {f.kind === 'pj' && <Input label="Nome fantasia" value={f.trade_name} onChange={set('trade_name')} />}
        <Input label="Telefone" inputMode="tel" value={f.phone} onChange={set('phone')} />
        <Input label="WhatsApp (se diferente)" inputMode="tel" value={f.whatsapp} onChange={set('whatsapp')} />
        <Input label="E-mail" type="email" value={f.email} onChange={set('email')} />
        <Input label={f.kind === 'pj' ? 'CNPJ (opcional)' : 'CPF (opcional)'} value={f.document} onChange={set('document')} hint="Só é necessário quando a operação exigir." />
        <Select label="Canal preferido" value={f.preferred_channel} onChange={set('preferred_channel')}>
          <option value="whatsapp">WhatsApp</option><option value="telefone">Telefone</option><option value="email">E-mail</option><option value="nenhum">Não contatar</option>
        </Select>
        <Input label="Origem" value={f.source} onChange={set('source')} placeholder="Indicação, Google, passou na frente..." />
        <Input label="Endereço" value={f.street} onChange={set('street')} className="sm:col-span-2" />
        <Input label="Cidade" value={f.city} onChange={set('city')} />
        <div className="grid grid-cols-2 gap-3"><Input label="UF" maxLength={2} value={f.state} onChange={set('state')} /><Input label="CEP" value={f.zip} onChange={set('zip')} /></div>
        <Textarea label="Observações internas" value={f.notes_internal} onChange={set('notes_internal')} className="sm:col-span-2" hint="Nunca aparecem para o cliente." />
        {dups.length > 0 && (
          <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 sm:col-span-2">
            Possíveis duplicidades: {dups.map((d) => <Link key={d.id} className="underline" to={`/clientes/${d.id}`}> {d.name} ({d.reason})</Link>)}. Telefones compartilhados (família) são permitidos.
          </div>
        )}
      </div>
    </Modal>
  )
}

export function ClientDetail() {
  const { id } = useParams()
  const { wsId, can, tz } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [tab, setTab] = useState('veiculos')
  const [edit, setEdit] = useState(false)
  const [addVehicle, setAddVehicle] = useState(false)
  const [merge, setMerge] = useState(false)
  const c = useQuery({ queryKey: ['client', id], queryFn: async () => {
    const { data, error } = await supabase.from('clients').select('*').eq('id', id!).single()
    if (error) throw error
    return data
  } })
  const vehicles = useQuery({ queryKey: ['client-vehicles', id], queryFn: async () => {
    const { data, error } = await supabase.from('vehicle_ownerships').select('started_at, vehicles(id, plate, internal_code, brand, model, year_model, color)')
      .eq('client_id', id!).is('ended_at', null)
    if (error) throw error
    return data ?? []
  } })
  const orders = useQuery({ queryKey: ['client-orders', id], enabled: can('orders.view'), queryFn: async () => {
    const { data, error } = await supabase.from('service_orders').select('id, number, status, entry_at, vehicles(plate, model)').eq('client_id', id!).order('entry_at', { ascending: false }).limit(50)
    if (error) throw error
    return data ?? []
  } })
  const quotes = useQuery({ queryKey: ['client-quotes', id], enabled: can('quotes.view'), queryFn: async () => {
    const { data, error } = await supabase.from('quotes').select('id, number, status, created_at').eq('client_id', id!).order('created_at', { ascending: false }).limit(50)
    if (error) throw error
    return data ?? []
  } })
  const contacts = useQuery({ queryKey: ['client-contacts', id], enabled: can('contacts.view'), queryFn: async () => {
    const { data, error } = await supabase.from('contact_log').select('*').eq('client_id', id!).order('created_at', { ascending: false }).limit(50)
    if (error) throw error
    return data ?? []
  } })
  const consents = useQuery({ queryKey: ['client-consents', id], queryFn: async () => {
    const { data, error } = await supabase.from('contact_consents').select('*').eq('client_id', id!).order('recorded_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } })
  const finance = useQuery({ queryKey: ['client-finance', id], enabled: can('finance.view'), queryFn: async () => {
    const { data, error } = await supabase.from('accounts').select('id, description, total_cents, status, account_installments(amount_cents, paid_cents, due_date)').eq('client_id', id!).eq('kind', 'receivable')
    if (error) throw error
    return data ?? []
  } })
  async function setConsent(purpose: string, granted: boolean) {
    const { error } = await supabase.from('contact_consents').insert({ workshop_id: wsId, client_id: id, purpose, granted, source: 'balcao' })
    if (error) return toast.error(error)
    qc.invalidateQueries({ queryKey: ['client-consents', id] })
    toast.success('Preferência registrada')
  }
  async function archive() {
    if (!confirm('Arquivar este cliente? O histórico é preservado.')) return
    const { error } = await supabase.from('clients').update({ archived_at: new Date().toISOString() }).eq('id', id!)
    if (error) return toast.error(error)
    toast.success('Cliente arquivado'); qc.invalidateQueries({ queryKey: ['client', id] })
  }

  if (c.isLoading) return <Loading />
  if (c.error) return <ErrorBox error={c.error} />
  const cl = c.data
  const current = (p: string) => consents.data?.find((x) => x.purpose === p)
  const purposes = [['service_updates', 'Avisos do serviço'], ['appointment_reminders', 'Lembretes de agendamento'], ['maintenance_reminders', 'Lembretes preventivos'], ['post_service', 'Pós-atendimento'], ['promotions', 'Promoções (exige consentimento explícito)']]
  const wa = waLink(cl.whatsapp || cl.phone, `Olá, ${cl.name.split(' ')[0]}!`)
  const balance = (finance.data ?? []).filter((a) => a.status === 'open').reduce((s, a) => s + a.account_installments.reduce((x: number, i: any) => x + Number(i.amount_cents) - Number(i.paid_cents), 0), 0)

  return (
    <div>
      <PageHeader title={cl.name} subtitle={<>{fmtPhone(cl.phone)} {cl.email && `· ${cl.email}`} {cl.archived_at && <Badge tone="gray">Arquivado</Badge>}</>} actions={<>
        {wa && can('messages.send') && <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-card px-4 text-sm"
          onClick={() => rpc('log_contact', { p_workshop: wsId, p_client: id, p_channel: 'whatsapp', p_kind: 'conversation_opened', p_message: null, p_outcome: null }).catch(() => {})}>
          <MessageCircle className="size-4" />WhatsApp</a>}
        {can('clients.edit') && <Button variant="secondary" onClick={() => setEdit(true)}>Editar</Button>}
        {can('clients.merge') && <Button variant="secondary" onClick={() => setMerge(true)}>Mesclar duplicado</Button>}
        {can('clients.archive') && !cl.archived_at && <Button variant="ghost" onClick={archive}>Arquivar</Button>}
      </>} />
      {cl.notes_internal && <p className="mb-3 rounded-md bg-slate-100 p-3 text-sm"><strong>Nota interna:</strong> {cl.notes_internal}</p>}
      {can('finance.view') && balance > 0 && <p className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900">Saldo em aberto: <strong>{brl(balance)}</strong></p>}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'veiculos', label: 'Veículos' }, ...(can('orders.view') ? [{ key: 'os', label: 'Atendimentos' }] : []),
        ...(can('quotes.view') ? [{ key: 'orc', label: 'Orçamentos' }] : []), ...(can('contacts.view') ? [{ key: 'contatos', label: 'Contatos' }] : []), { key: 'pref', label: 'Preferências de contato' }]} />
      {tab === 'veiculos' && (
        <Card title="Veículos atuais" actions={can('vehicles.create') && <Button size="sm" onClick={() => setAddVehicle(true)}><Plus className="size-4" />Veículo</Button>}>
          {vehicles.isLoading ? <Loading /> : vehicles.data?.length ? (
            <ul className="divide-y divide-slate-100">{vehicles.data.map((o: any) => (
              <li key={o.vehicles.id} className="py-2 text-sm"><Link className="font-medium text-brand" to={`/veiculos/${o.vehicles.id}`}>{fmtPlate(o.vehicles.plate ?? o.vehicles.internal_code)}</Link> — {o.vehicles.brand} {o.vehicles.model} {o.vehicles.year_model} <span className="text-slate-500">desde {fmtDate(o.started_at)}</span></li>
            ))}</ul>
          ) : <p className="text-sm text-slate-500">Nenhum veículo vinculado.</p>}
        </Card>
      )}
      {tab === 'os' && <Card title="Atendimentos">{orders.data?.length ? <ul className="divide-y divide-slate-100">{orders.data.map((o: any) => (
        <li key={o.id} className="flex items-center gap-3 py-2 text-sm"><Link className="font-medium text-brand" to={`/os/${o.id}`}>{o.number}</Link>{fmtPlate(o.vehicles?.plate)} {o.vehicles?.model}<span className="text-slate-500">{fmtDate(o.entry_at, tz)}</span><span className="ml-auto"><StatusBadge map={orderStatus} value={o.status} /></span></li>
      ))}</ul> : <p className="text-sm text-slate-500">Sem atendimentos.</p>}</Card>}
      {tab === 'orc' && <Card title="Orçamentos">{quotes.data?.length ? <ul className="divide-y divide-slate-100">{quotes.data.map((q: any) => (
        <li key={q.id} className="flex items-center gap-3 py-2 text-sm"><Link className="font-medium text-brand" to={`/orcamentos/${q.id}`}>{q.number}</Link><span className="text-slate-500">{fmtDate(q.created_at, tz)}</span><span className="ml-auto"><StatusBadge map={quoteStatus} value={q.status} /></span></li>
      ))}</ul> : <p className="text-sm text-slate-500">Sem orçamentos.</p>}</Card>}
      {tab === 'contatos' && <Card title="Histórico de contatos">{contacts.data?.length ? <ul className="divide-y divide-slate-100">{contacts.data.map((l: any) => (
        <li key={l.id} className="py-2 text-sm"><span className="text-slate-500">{fmtDateTime(l.created_at, tz)}</span> · {l.channel} · {l.kind === 'conversation_opened' ? 'conversa aberta (envio não confirmado)' : l.kind} {l.outcome && <Badge>{l.outcome}</Badge>} {l.message && <p className="text-slate-600">{l.message}</p>}</li>
      ))}</ul> : <p className="text-sm text-slate-500">Nenhum contato registrado.</p>}</Card>}
      {tab === 'pref' && (
        <Card title="Preferências por finalidade">
          <p className="mb-3 text-xs text-slate-500">Cada alteração fica registrada com data e origem. Avisos do serviço são permitidos até que o cliente peça para parar; promoções só com consentimento explícito.</p>
          <ul className="divide-y divide-slate-100">{purposes.map(([p, label]) => {
            const cur = current(p)
            const granted = cur ? cur.granted : p !== 'promotions'
            return (
              <li key={p} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="flex-1">{label}</span>
                <Badge tone={granted ? 'green' : 'red'}>{granted ? 'Permitido' : 'Não permitido'}</Badge>
                <span className="text-xs text-slate-400">{cur ? `${cur.source} · ${fmtDateTime(cur.recorded_at, tz)}` : 'padrão'}</span>
                {(can('clients.edit') || can('contacts.edit')) && <Button size="sm" variant="secondary" onClick={() => setConsent(p, !granted)}>{granted ? 'Retirar' : 'Permitir'}</Button>}
              </li>
            )
          })}</ul>
        </Card>
      )}
      <ClientFormModal open={edit} onClose={() => setEdit(false)} client={cl} />
      <QuickRegisterModal open={addVehicle} clientId={id} onClose={() => setAddVehicle(false)} onDone={() => { setAddVehicle(false); qc.invalidateQueries({ queryKey: ['client-vehicles', id] }) }} />
      <MergeModal open={merge} onClose={() => setMerge(false)} keepId={id!} />
    </div>
  )
}

function MergeModal({ open, onClose, keepId }: { open: boolean; onClose: () => void; keepId: string }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [target, setTarget] = useState<any>(null)
  const [note, setNote] = useState('')
  const hits = useQuery({ queryKey: ['merge-search', q], enabled: q.length >= 2, queryFn: async () => {
    const { data } = await supabase.from('clients').select('id, name, phone, document').eq('workshop_id', wsId).neq('id', keepId).is('merged_into', null).ilike('name', `%${q}%`).limit(10)
    return data ?? []
  } })
  async function doMerge() {
    try {
      await rpc('merge_clients', { p_keep: keepId, p_merge: target.id, p_note: note })
      toast.success('Cadastros mesclados e registrados na auditoria'); qc.invalidateQueries(); onClose()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Mesclar cadastro duplicado" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button variant="danger" disabled={!target || note.length < 5} onClick={doMerge}>Mesclar</Button></>}>
      <p className="mb-3 text-sm text-slate-600">Os veículos e preferências do cadastro selecionado passam para este cliente; o duplicado é arquivado. A operação fica na auditoria.</p>
      <Input label="Buscar duplicado" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="my-2">{hits.data?.map((h) => <li key={h.id}><button className={`w-full rounded px-2 py-1 text-left text-sm ${target?.id === h.id ? 'bg-brand-soft' : 'hover:bg-slate-50'}`} onClick={() => setTarget(h)}>{h.name} · {fmtPhone(h.phone)} {h.document}</button></li>)}</ul>
      <Textarea label="Motivo (revisão)" value={note} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  )
}

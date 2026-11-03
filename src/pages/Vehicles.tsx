import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Badge, Button, Card, ErrorBox, Input, Loading, Modal, PageHeader, Pager, StatusBadge, Table, Textarea, useToast } from '@/components/ui'
import { fmtDate, fmtKm, fmtPlate, isValidPlate } from '@/lib/format'
import { orderStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'
import { MaintenancePlanModal, VehiclePlans } from './Maintenance'

const PAGE = 25
const sourceLabel: Record<string, string> = { order_entry: 'Entrada de OS', order_exit: 'Saída de OS', reception: 'Recepção', client_portal: 'Cliente (portal)', client_message: 'Cliente (mensagem)', manual: 'Manual', external: 'Outra oficina' }

export function VehiclesPage() {
  const { wsId } = useAuth()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const list = useQuery({
    queryKey: ['vehicles', wsId, q, page],
    queryFn: async () => {
      let s = supabase.from('vehicles').select('id, plate, internal_code, brand, model, year_model, color, vehicle_ownerships(client_id, ended_at, clients!vehicle_ownerships_workshop_id_client_id_fkey(name))', { count: 'exact' })
        .eq('workshop_id', wsId).is('archived_at', null).order('updated_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1)
      if (q.trim()) s = s.ilike('search', `%${q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}%`)
      const { data, error, count } = await s
      if (error) throw error
      return { rows: data ?? [], count: count ?? 0 }
    },
  })
  return (
    <div>
      <PageHeader title="Veículos" subtitle="Para cadastrar um veículo, abra o cliente ou use o cadastro rápido no atendimento." />
      <div className="card">
        <div className="p-3"><Input label="Buscar" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Placa, modelo, marca ou cor" /></div>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : list.isLoading ? <Loading /> : <>
          <Table head={['Placa', 'Veículo', 'Ano', 'Proprietário atual']} empty={!list.data?.rows.length}>
            {list.data?.rows.map((v: any) => {
              const owner = v.vehicle_ownerships?.find((o: any) => !o.ended_at)
              return (
                <tr key={v.id} className="cursor-pointer hover:bg-slate-50" onClick={() => nav(`/veiculos/${v.id}`)}>
                  <td className="td font-medium"><Link to={`/veiculos/${v.id}`}>{fmtPlate(v.plate ?? v.internal_code)}</Link></td>
                  <td className="td">{v.brand} {v.model} {v.color && <span className="text-slate-500">· {v.color}</span>}</td>
                  <td className="td">{v.year_model}</td><td className="td">{owner?.clients?.name ?? '—'}</td>
                </tr>
              )
            })}
          </Table>
          <Pager page={page} pageSize={PAGE} total={list.data?.count ?? 0} onPage={setPage} />
        </>}
      </div>
    </div>
  )
}

export function VehicleDetail() {
  const { id } = useParams()
  const { wsId, can, tz } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [km, setKm] = useState(false)
  const [transfer, setTransfer] = useState(false)
  const [edit, setEdit] = useState(false)
  const [plan, setPlan] = useState(false)
  const v = useQuery({ queryKey: ['vehicle', id], queryFn: async () => {
    const { data, error } = await supabase.from('vehicles').select('*').eq('id', id!).single()
    if (error) throw error
    return data
  } })
  const owner = useQuery({ queryKey: ['vehicle-owner', id], enabled: can('clients.view'), queryFn: async () => {
    const { data, error } = await supabase.from('vehicle_ownerships').select('*, clients!vehicle_ownerships_workshop_id_client_id_fkey(id, name, phone)').eq('vehicle_id', id!).is('ended_at', null).maybeSingle()
    if (error) throw error
    return data
  } })
  const readings = useQuery({ queryKey: ['odometer', id], queryFn: async () => {
    const { data, error } = await supabase.from('odometer_readings').select('*').eq('vehicle_id', id!).order('read_on', { ascending: false }).order('created_at', { ascending: false }).limit(30)
    if (error) throw error
    return data ?? []
  } })
  const rate = useQuery({ queryKey: ['km-rate', id], queryFn: () => rpc<any[]>('vehicle_km_rate', { p_vehicle: id }) })
  // histórico técnico do veículo: OS do proprietário atual + itens técnicos; dados pessoais/financeiros de donos anteriores não aparecem
  const orders = useQuery({ queryKey: ['vehicle-orders', id], enabled: can('orders.view'), queryFn: async () => {
    const { data, error } = await supabase.from('service_orders').select('id, number, status, entry_at, km_entry, complaint, client_id').eq('vehicle_id', id!).order('entry_at', { ascending: false }).limit(50)
    if (error) throw error
    return data ?? []
  } })
  const recs = useQuery({ queryKey: ['recommendations', id], enabled: can('maintenance.view') || can('quotes.view'), queryFn: async () => {
    const { data, error } = await supabase.from('recommendations').select('*').eq('vehicle_id', id!).in('status', ['open', 'scheduled']).order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  } })
  async function invalidate(r: any) {
    const reason = prompt('Motivo da invalidação desta leitura (fica registrado):')
    if (!reason) return
    const { error } = await supabase.from('odometer_readings').update({ invalidated_at: new Date().toISOString(), invalidated_reason: reason }).eq('id', r.id)
    if (error) return toast.error(error)
    qc.invalidateQueries({ queryKey: ['odometer', id] })
  }
  async function confirmReading(r: any) {
    const { error } = await supabase.from('odometer_readings').update({ confirmed: true }).eq('id', r.id)
    if (error) return toast.error(error)
    qc.invalidateQueries({ queryKey: ['odometer', id] })
  }

  if (v.isLoading) return <Loading />
  if (v.error) return <ErrorBox error={v.error} />
  const ve = v.data
  const r = rate.data?.[0]
  const currentClient = owner.data?.client_id
  return (
    <div>
      <PageHeader title={`${fmtPlate(ve.plate ?? ve.internal_code)} — ${ve.brand ?? ''} ${ve.model}`}
        subtitle={[ve.year_manufacture && `${ve.year_manufacture}/${ve.year_model ?? ''}`, ve.trim_version, ve.engine, ve.fuel, ve.transmission, ve.color].filter(Boolean).join(' · ')}
        actions={<>
          {can('orders.create') && currentClient && <Link to={`/os/nova?client=${currentClient}&vehicle=${id}`} className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-white">Abrir OS</Link>}
          {can('vehicles.edit') && <Button variant="secondary" onClick={() => setEdit(true)}>Editar</Button>}
          {can('vehicles.edit') && <Button variant="secondary" onClick={() => setTransfer(true)}>Transferir proprietário</Button>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {can('clients.view') && <Card title="Proprietário atual">{owner.data ? <Link className="text-brand" to={`/clientes/${owner.data.client_id}`}>{owner.data.clients?.name}</Link> : <p className="text-sm text-slate-500">Sem proprietário vinculado.</p>}</Card>}
          {can('maintenance.view') && <VehiclePlans vehicleId={id!} onNew={can('maintenance.edit') ? () => setPlan(true) : undefined} />}
          {recs.data && recs.data.length > 0 && (
            <Card title="Pendências recomendadas">
              <ul className="divide-y divide-slate-100">{recs.data.map((rc: any) => (
                <li key={rc.id} className="flex flex-wrap items-center gap-2 py-2 text-sm"><Badge tone={rc.priority === 'critica' ? 'red' : rc.priority === 'alta' ? 'amber' : 'gray'}>{rc.priority}</Badge>{rc.description}<span className="text-slate-500">· {rc.reason}</span>{rc.follow_up_on && <span className="ml-auto text-xs text-slate-500">acompanhar em {fmtDate(rc.follow_up_on)}</span>}</li>
              ))}</ul>
              {recs.data.some((x: any) => x.priority === 'critica') && <p className="mt-2 text-xs text-red-700">Itens críticos devem ser comunicados pessoalmente por um responsável — não dependa só de lembrete automático.</p>}
            </Card>
          )}
          {can('orders.view') && (
            <Card title="Histórico técnico">
              {orders.data?.length ? <ul className="divide-y divide-slate-100">{orders.data.map((o: any) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  {o.client_id === currentClient ? <Link className="font-medium text-brand" to={`/os/${o.id}`}>{o.number}</Link> : <span className="font-medium">{o.number} <span className="text-xs text-slate-400">(proprietário anterior)</span></span>}
                  <span className="text-slate-500">{fmtDate(o.entry_at, tz)} · {fmtKm(o.km_entry)}</span><span className="truncate">{o.complaint}</span>
                  <span className="ml-auto"><StatusBadge map={orderStatus} value={o.status} /></span>
                </li>
              ))}</ul> : <p className="text-sm text-slate-500">Sem atendimentos.</p>}
            </Card>
          )}
        </div>
        <Card title="Quilometragem" actions={(can('vehicles.edit') || can('vehicles.create')) && <Button size="sm" onClick={() => setKm(true)}>Registrar leitura</Button>}>
          {r ? <p className="mb-3 rounded bg-slate-50 p-2 text-xs text-slate-600">Estimativa: <strong>{Number(r.km_per_day).toLocaleString('pt-BR')} km/dia</strong> ({r.readings} leituras, {fmtDate(r.first_on)}–{fmtDate(r.last_on)}, confiança {r.confidence}). É uma projeção, não uma leitura.</p>
            : <p className="mb-3 text-xs text-slate-500">Sem leituras suficientes para estimar uso (mínimo duas em datas diferentes). Ausência de leitura não significa que o carro não rodou.</p>}
          <ul className="space-y-2">{readings.data?.map((rd: any) => (
            <li key={rd.id} className={`text-sm ${rd.invalidated_at ? 'text-slate-400 line-through' : ''}`}>
              <div className="flex items-center gap-2"><strong>{fmtKm(rd.km)}</strong><span className="text-slate-500">{fmtDate(rd.read_on)}</span>{!rd.confirmed && <Badge tone="amber">a validar</Badge>}</div>
              <div className="text-xs text-slate-500">{sourceLabel[rd.source]}{rd.regression_justification && ` · ${rd.regression_justification}`}{rd.invalidated_reason && ` · invalidada: ${rd.invalidated_reason}`}</div>
              {can('vehicles.edit') && !rd.invalidated_at && <div className="flex gap-2 text-xs">
                {!rd.confirmed && <button className="text-brand" onClick={() => confirmReading(rd)}>Confirmar</button>}
                <button className="text-slate-500 hover:text-red-600" onClick={() => invalidate(rd)}>Invalidar</button>
              </div>}
            </li>
          ))}</ul>
        </Card>
      </div>
      <KmModal open={km} onClose={() => setKm(false)} vehicleId={id!} />
      <TransferModal open={transfer} onClose={() => setTransfer(false)} vehicleId={id!} />
      <VehicleEditModal open={edit} onClose={() => setEdit(false)} vehicle={ve} />
      <MaintenancePlanModal open={plan} onClose={() => setPlan(false)} vehicleId={id!} />
      <input type="hidden" value={wsId} readOnly />
    </div>
  )
}

function KmModal({ open, onClose, vehicleId }: { open: boolean; onClose: () => void; vehicleId: string }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [km, setKm] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [just, setJust] = useState('')
  const [needJust, setNeedJust] = useState(false)
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('odometer_readings').insert({ workshop_id: wsId, vehicle_id: vehicleId, km: Number(km), read_on: date, source: 'manual', regression_justification: just || null })
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['odometer', vehicleId] }); qc.invalidateQueries({ queryKey: ['km-rate', vehicleId] }); toast.success('Leitura registrada'); setKm(''); setJust(''); setNeedJust(false); onClose() },
    onError: (e: any) => { if (e?.code === 'P0002') setNeedJust(true); toast.error(e) },
  })
  return (
    <Modal open={open} onClose={onClose} title="Registrar quilometragem" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={save.isPending} disabled={!km} onClick={() => save.mutate()}>Salvar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Quilometragem" inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ''))} />
        <Input label="Data da leitura" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {needJust && <Textarea className="sm:col-span-2" label="Justificativa (leitura menor que a anterior)" value={just} onChange={(e) => setJust(e.target.value)} hint="Ex.: troca de painel, erro de digitação na leitura anterior. A leitura anterior não é apagada." />}
      </div>
    </Modal>
  )
}

function TransferModal({ open, onClose, vehicleId }: { open: boolean; onClose: () => void; vehicleId: string }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [target, setTarget] = useState<any>(null)
  const [reason, setReason] = useState('Venda do veículo')
  const hits = useQuery({ queryKey: ['transfer-search', q], enabled: q.length >= 2, queryFn: async () => {
    const { data } = await supabase.from('clients').select('id, name, phone').eq('workshop_id', wsId).is('archived_at', null).ilike('name', `%${q}%`).limit(10)
    return data ?? []
  } })
  async function go() {
    try {
      await rpc('transfer_vehicle', { p_vehicle: vehicleId, p_new_client: target.id, p_reason: reason })
      toast.success('Proprietário alterado. O histórico técnico foi preservado.'); qc.invalidateQueries(); onClose()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Transferir proprietário" footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!target} onClick={go}>Transferir</Button></>}>
      <p className="mb-3 text-sm text-slate-600">O novo proprietário verá o histórico técnico do carro, mas não os dados pessoais ou financeiros do dono anterior.</p>
      <Input label="Novo proprietário (cliente já cadastrado)" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="my-2">{hits.data?.map((h) => <li key={h.id}><button className={`w-full rounded px-2 py-1 text-left text-sm ${target?.id === h.id ? 'bg-brand-soft' : 'hover:bg-slate-50'}`} onClick={() => setTarget(h)}>{h.name}</button></li>)}</ul>
      <Input label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  )
}

function VehicleEditModal({ open, onClose, vehicle }: { open: boolean; onClose: () => void; vehicle: any }) {
  const toast = useToast()
  const qc = useQueryClient()
  const fields = ['plate', 'plate_exception', 'brand', 'model', 'year_manufacture', 'year_model', 'trim_version', 'engine', 'fuel', 'transmission', 'color', 'vin', 'notes'] as const
  const labels: Record<string, string> = { plate: 'Placa', plate_exception: 'Exceção da placa', brand: 'Marca', model: 'Modelo', year_manufacture: 'Ano fabricação', year_model: 'Ano modelo', trim_version: 'Versão', engine: 'Motor', fuel: 'Combustível', transmission: 'Câmbio', color: 'Cor', vin: 'Chassi (opcional)', notes: 'Observações' }
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((k) => [k, vehicle[k] ?? ''])))
  const plateErr = f.plate && !f.plate_exception && !isValidPlate(f.plate) ? 'Placa fora do padrão; informe a exceção se for estrangeira/sem registro.' : undefined
  async function save() {
    const row: Record<string, unknown> = Object.fromEntries(fields.map((k) => [k, f[k] === '' ? null : f[k]]))
    row.year_manufacture = row.year_manufacture ? Number(row.year_manufacture) : null
    row.year_model = row.year_model ? Number(row.year_model) : null
    const { data, error } = await supabase.from('vehicles').update(row).eq('id', vehicle.id).eq('version', vehicle.version).select('id')
    if (error) return toast.error(error)
    if (!data?.length) return toast.error({ code: '40001' })
    qc.invalidateQueries({ queryKey: ['vehicle', vehicle.id] }); toast.success('Veículo salvo'); onClose()
  }
  return (
    <Modal open={open} onClose={onClose} title="Editar veículo" wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!!plateErr || !f.model} onClick={save}>Salvar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">{fields.map((k) => (
        <Input key={k} label={labels[k]} value={f[k]} error={k === 'plate' ? plateErr : undefined} onChange={(e) => setF((s) => ({ ...s, [k]: e.target.value }))} className={k === 'notes' ? 'sm:col-span-3' : ''} />
      ))}</div>
    </Modal>
  )
}

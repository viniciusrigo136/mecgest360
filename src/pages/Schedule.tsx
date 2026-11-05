import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { ClientVehiclePicker, useTeam, type Picked } from '@/components/pickers'
import { Button, Card, ErrorBox, Input, Loading, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useToast } from '@/components/ui'
import { fmtPlate, fmtTime, localToISO, todayLocal } from '@/lib/format'
import { appointmentStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'

function addDays(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10)
}
const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export function SchedulePage() {
  const { wsId, tz, can } = useAuth()
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const view = params.get('v') ?? 'dia'
  const day = params.get('d') ?? todayLocal(tz)
  const [form, setForm] = useState<any>(params.get('novo') ? {} : null)
  const range = view === 'semana' ? { from: addDays(day, -new Date(`${day}T12:00:00Z`).getUTCDay()), days: 7 } : view === 'lista' ? { from: day, days: 30 } : { from: day, days: 1 }
  const q = useQuery({
    queryKey: ['appointments', wsId, range.from, range.days],
    queryFn: async () => {
      const { data, error } = await supabase.from('appointments')
        .select('*, clients(name, phone), vehicles(plate, internal_code, model), resources(name)')
        .eq('workshop_id', wsId).gte('starts_at', localToISO(range.from, '00:00', tz)).lt('starts_at', localToISO(addDays(range.from, range.days), '00:00', tz))
        .order('starts_at')
      if (error) throw error
      return data ?? []
    },
  })
  const resources = useQuery({ queryKey: ['resources', wsId], queryFn: async () => (await supabase.from('resources').select('*').eq('workshop_id', wsId).eq('active', true).order('name')).data ?? [] })
  const team = useTeam()
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); p.set(k, v); p.delete('novo'); setParams(p, { replace: true }) }

  async function status(a: any, s: string) {
    let reason: string | null = null
    if (s === 'cancelled') { reason = prompt('Motivo do cancelamento:'); if (!reason) return }
    try { await rpc('set_appointment_status', { p_id: a.id, p_status: s, p_reason: reason }); qc.invalidateQueries({ queryKey: ['appointments'] }) } catch (e) { toast.error(e) }
  }
  async function convert(a: any) {
    const km = prompt('Quilometragem de entrada (opcional):') ?? ''
    try {
      const id = await rpc<string>('convert_appointment', { p_appointment: a.id, p_km: km ? Number(km.replace(/\D/g, '')) : null })
      nav(`/os/${id}`)
    } catch (e: any) {
      if (e?.code === 'P0002') {
        const j = prompt('A quilometragem é menor que a última leitura. Justifique (ex.: troca de painel):')
        if (j) { const id = await rpc<string>('convert_appointment', { p_appointment: a.id, p_km: Number(km.replace(/\D/g, '')), p_km_justification: j }).catch((x) => { toast.error(x); return null }); if (id) nav(`/os/${id}`) }
      } else toast.error(e)
    }
  }

  const days = Array.from({ length: range.days }, (_, i) => addDays(range.from, i))
  const byDay = useMemo(() => {
    const m: Record<string, any[]> = {}
    for (const a of q.data ?? []) {
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(a.starts_at))
      ;(m[d] ??= []).push(a)
    }
    return m
  }, [q.data, tz])

  const Item = ({ a }: { a: any }) => (
    <div className={clsx('rounded-md border p-2 text-sm', a.status === 'cancelled' ? 'border-slate-200 bg-slate-50 opacity-60' : 'border-slate-200 bg-card')}>
      <div className="flex flex-wrap items-center gap-2">
        <strong>{fmtTime(a.starts_at, tz)}–{fmtTime(a.ends_at, tz)}</strong>
        <span>{fmtPlate(a.vehicles?.plate ?? a.vehicles?.internal_code)} {a.vehicles?.model}</span>
        <span className="text-slate-500">· {a.clients?.name}</span>
        <span className="ml-auto"><StatusBadge map={appointmentStatus} value={a.status} /></span>
      </div>
      <p className="text-slate-600">{a.description} {a.resources?.name && <span className="text-xs text-slate-400">· {a.resources.name}</span>}
        {a.membership_id && <span className="text-xs text-slate-400"> · {team.data?.find((m) => m.id === a.membership_id)?.name}</span>}
        {a.override_reason && <span className="text-xs text-amber-700"> · encaixe: {a.override_reason}</span>}</p>
      {['requested', 'confirmed', 'arrived'].includes(a.status) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {a.status === 'requested' && can('schedule.edit') && <Button size="sm" variant="secondary" onClick={() => status(a, 'confirmed')}>Confirmar</Button>}
          {a.status !== 'arrived' && can('schedule.edit') && <Button size="sm" variant="secondary" onClick={() => status(a, 'arrived')}>Chegou</Button>}
          {can('orders.create') && <Button size="sm" onClick={() => convert(a)}>Converter em OS</Button>}
          {can('schedule.edit') && <Button size="sm" variant="ghost" onClick={() => setForm(a)}>Reagendar/editar</Button>}
          {can('schedule.edit') && <Button size="sm" variant="ghost" onClick={() => status(a, 'no_show')}>Não compareceu</Button>}
          {can('schedule.cancel') && <Button size="sm" variant="ghost" onClick={() => status(a, 'cancelled')}>Cancelar</Button>}
        </div>
      )}
      {a.order_id && <button className="mt-1 text-xs text-brand" onClick={() => nav(`/os/${a.order_id}`)}>Abrir OS</button>}
    </div>
  )

  return (
    <div>
      <PageHeader title="Agenda" actions={can('schedule.create') && <Button onClick={() => setForm({})}><Plus className="size-4" />Novo agendamento</Button>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={view} onChange={(v) => set('v', v)} tabs={[{ key: 'dia', label: 'Dia' }, { key: 'semana', label: 'Semana' }, { key: 'lista', label: 'Lista (30 dias)' }]} />
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="secondary" aria-label="Anterior" onClick={() => set('d', addDays(day, view === 'semana' ? -7 : -1))}><ChevronLeft className="size-4" /></Button>
          <input type="date" className="input h-8 w-40 py-0" value={day} onChange={(e) => set('d', e.target.value)} aria-label="Data" />
          <Button size="sm" variant="secondary" aria-label="Próximo" onClick={() => set('d', addDays(day, view === 'semana' ? 7 : 1))}><ChevronRight className="size-4" /></Button>
          <Button size="sm" variant="ghost" onClick={() => set('d', todayLocal(tz))}>Hoje</Button>
        </div>
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading ? <Loading /> : view === 'semana' ? (
        <div className="grid gap-2 md:grid-cols-7">
          {days.map((d) => (
            <div key={d} className={clsx('card min-h-40 p-2', d === todayLocal(tz) && 'ring-2 ring-brand/30')}>
              <p className="mb-2 text-xs font-semibold text-slate-500">{weekdays[new Date(`${d}T12:00:00Z`).getUTCDay()]} {d.slice(8)}/{d.slice(5, 7)}</p>
              <div className="space-y-1">{(byDay[d] ?? []).map((a) => <Item key={a.id} a={a} />)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {days.filter((d) => view === 'dia' || byDay[d]?.length).map((d) => (
            <Card key={d} title={`${weekdays[new Date(`${d}T12:00:00Z`).getUTCDay()]}, ${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`}>
              <div className="space-y-2">{(byDay[d] ?? []).map((a) => <Item key={a.id} a={a} />)}{!(byDay[d]?.length) && <p className="text-sm text-slate-500">Nenhum agendamento.</p>}</div>
            </Card>
          ))}
          {view === 'lista' && !q.data?.length && <p className="text-sm text-slate-500">Nenhum agendamento nos próximos 30 dias.</p>}
        </div>
      )}
      <AppointmentModal open={!!form} initial={form} day={day} onClose={() => setForm(null)} resources={resources.data ?? []} team={team.data ?? []} />
    </div>
  )
}

function AppointmentModal({ open, initial, day, onClose, resources, team }: { open: boolean; initial: any; day: string; onClose: () => void; resources: any[]; team: any[] }) {
  const { wsId, tz, can } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Picked | null>(null)
  const [f, setF] = useState({ date: day, time: '08:00', duration: '60', description: '', service: '', member: '', resource: '', notes: '', override: '', status: 'confirmed' })
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const services = useQuery({ queryKey: ['catalog', wsId], queryFn: async () => (await supabase.from('service_catalog').select('*').eq('workshop_id', wsId).is('archived_at', null).order('name')).data ?? [] })
  useEffect(() => {
    if (!open) return
    setConflict(false)
    if (initial?.id) {
      const local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(initial.starts_at))
      const g = (t: string) => local.find((p) => p.type === t)?.value
      setF({ date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}`, duration: String(Math.round((+new Date(initial.ends_at) - +new Date(initial.starts_at)) / 60000)),
        description: initial.description, service: initial.service_id ?? '', member: initial.membership_id ?? '', resource: initial.resource_id ?? '', notes: initial.notes ?? '', override: '', status: initial.status })
      setPicked({ clientId: initial.client_id, clientName: initial.clients?.name ?? '', vehicleId: initial.vehicle_id, vehicleLabel: '' })
    } else {
      setPicked(null)
      setF((s) => ({ ...s, date: day, description: '', notes: '', override: '' }))
    }
  }, [open, initial, day, tz])
  async function save() {
    if (!picked || busy) return
    setBusy(true)
    const start = localToISO(f.date, f.time, tz)
    const end = new Date(+new Date(start) + Number(f.duration) * 60000).toISOString()
    try {
      await rpc('save_appointment', { p_workshop: wsId, p_id: initial?.id ?? null, p_client: picked.clientId, p_vehicle: picked.vehicleId, p_service: f.service || null,
        p_description: f.description || services.data?.find((s) => s.id === f.service)?.name || 'Atendimento', p_starts_at: start, p_ends_at: end,
        p_member: f.member || null, p_resource: f.resource || null, p_status: f.status, p_override_reason: f.override || null, p_notes: f.notes || null,
        p_expected_version: initial?.version ?? null })
      qc.invalidateQueries({ queryKey: ['appointments'] }); toast.success(initial?.id ? 'Agendamento atualizado' : 'Agendamento criado'); onClose()
    } catch (e: any) {
      if (e?.code === 'P0004' || e?.code === 'P0003') setConflict(true)
      toast.error(e)
    } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Editar / reagendar' : 'Novo agendamento'} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!picked} onClick={save}>Salvar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><ClientVehiclePicker value={picked} onChange={setPicked} requireVehicle={false} /></div>
        <Select label="Serviço do catálogo" value={f.service} onChange={(e) => { const s = services.data?.find((x) => x.id === e.target.value); setF((p) => ({ ...p, service: e.target.value, duration: s ? String(s.duration_min) : p.duration, description: p.description || s?.name || '' })) }}>
          <option value="">— livre —</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Input label="Descrição" value={f.description} onChange={(e) => setF((p) => ({ ...p, description: e.target.value }))} />
        <Input label="Data" type="date" value={f.date} onChange={(e) => setF((p) => ({ ...p, date: e.target.value }))} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Hora" type="time" step={900} value={f.time} onChange={(e) => setF((p) => ({ ...p, time: e.target.value }))} />
          <Input label="Duração (min)" inputMode="numeric" value={f.duration} onChange={(e) => setF((p) => ({ ...p, duration: e.target.value.replace(/\D/g, '') }))} />
        </div>
        <Select label="Funcionário" value={f.member} onChange={(e) => setF((p) => ({ ...p, member: e.target.value }))}>
          <option value="">Sem funcionário definido</option>{team.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
        <Select label="Box / recurso" value={f.resource} onChange={(e) => setF((p) => ({ ...p, resource: e.target.value }))}>
          <option value="">Sem box definido</option>{resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
        <Select label="Situação" value={f.status} onChange={(e) => setF((p) => ({ ...p, status: e.target.value }))}>
          <option value="confirmed">Confirmado</option><option value="requested">Solicitado (a confirmar)</option>
        </Select>
        <Textarea label="Observações" value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} />
        {conflict && can('schedule.override') && (
          <Textarea className="sm:col-span-2" label="Encaixe com conflito — justificativa" value={f.override} onChange={(e) => setF((p) => ({ ...p, override: e.target.value }))}
            hint="Só use quando realmente necessário. Fica registrado na auditoria." />
        )}
      </div>
    </Modal>
  )
}

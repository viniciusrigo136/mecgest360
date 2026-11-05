import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronRight, Plus, User } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { ClientSheet, type ClientCar } from '@/components/ClientSheet'
import { Plate } from '@/components/Plate'
import { Button, ErrorBox, Input, Loading, Modal, StatusBadge, useToast } from '@/components/ui'
import { fmtTime, localToISO, todayLocal } from '@/lib/format'
import { appointmentStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'

// Agenda simples: lista de horários marcados (sem boxes, elevadores ou encaixes).

const weekday = (d: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))

export function SchedulePage() {
  const { wsId, tz, can } = useAuth()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(params.get('novo') === '1')
  const today = todayLocal(tz)
  const q = useQuery({
    queryKey: ['appointments', wsId, today],
    queryFn: async () => {
      const { data, error } = await supabase.from('appointments')
        .select('*, clients(name), vehicles(plate, internal_code, brand, model)')
        .eq('workshop_id', wsId).gte('starts_at', localToISO(today, '00:00', tz)).lt('starts_at', localToISO(todayLocal(tz, 31), '00:00', tz))
        .in('status', ['requested', 'confirmed', 'arrived']).order('starts_at')
      if (error) throw error
      return data ?? []
    },
  })
  const days: Record<string, any[]> = {}
  for (const a of q.data ?? []) (days[new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(a.starts_at))] ??= []).push(a)

  async function setStatus(a: any, s: string) {
    let reason: string | null = null
    if (s === 'cancelled') { reason = prompt('Motivo do cancelamento:'); if (!reason) return }
    try { await rpc('set_appointment_status', { p_id: a.id, p_status: s, p_reason: reason }); qc.invalidateQueries({ queryKey: ['appointments'] }) } catch (e) { toast.error(e) }
  }
  async function arrived(a: any) {
    if (!a.vehicle_id) return toast.error({ message: 'Escolha o carro do cliente para abrir o serviço' })
    try { const id = await rpc<string>('convert_appointment', { p_appointment: a.id }); nav(`/os/${id}`) } catch (e) { toast.error(e) }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-extrabold">Agenda</h1>
        {can('schedule.create') && <Button onClick={() => setCreating(true)}><Plus className="size-4" />Marcar horário</Button>}
      </div>
      {q.error && <ErrorBox error={q.error} />}
      {q.isLoading ? <Loading /> : Object.keys(days).length === 0 ? (
        <div className="card p-8 text-center text-slate-500">Nenhum horário marcado nos próximos 30 dias.</div>
      ) : Object.entries(days).map(([d, list]) => (
        <section key={d}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{d === today ? 'Hoje' : d === todayLocal(tz, 1) ? 'Amanhã' : weekday(d)}</h2>
          <ul className="space-y-2">{list.map((a) => (
            <li key={a.id} className="card flex flex-wrap items-center gap-3 p-3">
              <span className="w-14 font-heading text-lg font-extrabold">{fmtTime(a.starts_at, tz)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold uppercase">{a.clients?.name}</p>
                <p className="flex items-center gap-2 text-sm text-slate-600">{a.vehicles && <Plate value={a.vehicles.plate ?? a.vehicles.internal_code} />}<span className="truncate">{a.description}</span></p>
              </div>
              <StatusBadge map={appointmentStatus} value={a.status} />
              <div className="flex gap-1.5">
                {can('orders.create') && <Button size="sm" onClick={() => arrived(a)}>Chegou</Button>}
                {can('schedule.edit') && <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'no_show')}>Não veio</Button>}
                {can('schedule.cancel') && <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'cancelled')}>Cancelar</Button>}
              </div>
            </li>
          ))}</ul>
        </section>
      ))}
      <NewAppointment open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function NewAppointment({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wsId, tz } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [sheet, setSheet] = useState(false)
  const [picked, setPicked] = useState<ClientCar | null>(null)
  const [date, setDate] = useState(todayLocal(tz, 1))
  const [time, setTime] = useState('08:00')
  const [what, setWhat] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      const start = localToISO(date, time, tz)
      await rpc('save_appointment', { p_workshop: wsId, p_id: null, p_client: picked!.clientId, p_vehicle: picked!.vehicleId, p_service: null,
        p_description: what.trim(), p_starts_at: start, p_ends_at: new Date(+new Date(start) + 3600_000).toISOString(), p_member: null, p_resource: null })
      toast.success('Horário marcado'); qc.invalidateQueries({ queryKey: ['appointments'] })
      setPicked(null); setWhat(''); onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Marcar horário">
      <div className="space-y-3">
        <button onClick={() => setSheet(true)} className={clsx('flex w-full items-center gap-3 rounded-2xl border-2 p-3 text-left', picked ? 'border-slate-200' : 'border-brand')}>
          <span className="flex size-11 items-center justify-center rounded-xl bg-brand-soft text-brand"><User className="size-5" /></span>
          {picked ? <span className="min-w-0 flex-1"><span className="block truncate font-semibold uppercase">{picked.clientName}</span><span className="flex items-center gap-2 text-sm text-slate-500"><Plate value={picked.plate} />{picked.label}</span></span>
            : <span className="flex-1 font-bold text-brand-strong">Escolher cliente e carro</span>}
          <ChevronRight className="size-5 text-slate-400" />
        </button>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Dia" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input label="Hora" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <Input label="O que vai fazer?" value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Ex.: Revisão e alinhamento" />
        <Button size="lg" className="w-full" loading={busy} disabled={!picked || !what.trim()} onClick={save}>Marcar</Button>
      </div>
      <ClientSheet open={sheet} onClose={() => setSheet(false)} onPick={(v) => { setPicked(v); setSheet(false) }} />
    </Modal>
  )
}

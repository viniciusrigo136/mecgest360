import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { fmtPlate, isValidPlate } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'
import { Button, Input, Modal, Select, useToast } from './ui'

export type Picked = { clientId: string; clientName: string; vehicleId: string | null; vehicleLabel: string }

type Hit = { kind: string; id: string; title: string; subtitle: string; client_id: string | null; vehicle_id: string | null }

/** Busca cliente/veículo e permite cadastro rápido no balcão. */
export function ClientVehiclePicker({ value, onChange, requireVehicle = true }: { value: Picked | null; onChange: (p: Picked | null) => void; requireVehicle?: boolean }) {
  const { wsId, can } = useAuth()
  const [q, setQ] = useState('')
  const [quick, setQuick] = useState(false)
  const [deb, setDeb] = useState('')
  useEffect(() => { const t = setTimeout(() => setDeb(q.trim()), 250); return () => clearTimeout(t) }, [q])
  const hits = useQuery({
    queryKey: ['picker', wsId, deb],
    enabled: deb.length >= 2,
    queryFn: () => rpc<Hit[]>('search_clients_vehicles', { p_workshop: wsId, p_q: deb, p_limit: 10 }),
  })
  const vehicles = useQuery({
    queryKey: ['client-vehicles', value?.clientId],
    enabled: !!value?.clientId,
    queryFn: async () => {
      const { data, error } = await supabase.from('vehicle_ownerships')
        .select('vehicle_id, vehicles(id, plate, internal_code, brand, model)').eq('client_id', value!.clientId).is('ended_at', null)
      if (error) throw error
      return (data ?? []).map((r: any) => r.vehicles)
    },
  })

  if (value) {
    return (
      <div className="space-y-2 rounded-md border border-slate-200 p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm"><span className="text-slate-500">Cliente:</span> <strong>{value.clientName}</strong></p>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Trocar</Button>
        </div>
        <Select label="Veículo" value={value.vehicleId ?? ''} onChange={(e) => {
          const v = vehicles.data?.find((x: any) => x.id === e.target.value)
          onChange({ ...value, vehicleId: v?.id ?? null, vehicleLabel: v ? `${fmtPlate(v.plate ?? v.internal_code)} ${v.brand ?? ''} ${v.model}` : '' })
        }} required={requireVehicle}>
          <option value="">{requireVehicle ? 'Selecione o veículo' : 'Sem veículo definido'}</option>
          {vehicles.data?.map((v: any) => <option key={v.id} value={v.id}>{fmtPlate(v.plate ?? v.internal_code)} — {v.brand} {v.model}</option>)}
        </Select>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <Input label="Cliente ou placa" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Digite nome, telefone ou placa" />
      {hits.data && hits.data.length > 0 && (
        <ul className="max-h-56 overflow-y-auto rounded-md border border-slate-200">
          {hits.data.filter((h) => h.client_id).map((h) => (
            <li key={h.kind + h.id}>
              <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => onChange({
                clientId: h.client_id!, clientName: h.kind === 'client' ? h.title : h.subtitle,
                vehicleId: h.vehicle_id, vehicleLabel: h.kind === 'vehicle' ? h.title : '',
              })}>
                <strong>{h.title}</strong> <span className="text-slate-500">· {h.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {deb.length >= 2 && hits.data?.length === 0 && <p className="text-sm text-slate-500">Nenhum resultado.</p>}
      {can('clients.create') && <Button type="button" variant="secondary" size="sm" onClick={() => setQuick(true)}><Plus className="size-4" />Cadastro rápido</Button>}
      <QuickRegisterModal open={quick} onClose={() => setQuick(false)} onDone={(p) => { setQuick(false); onChange(p) }} />
    </div>
  )
}

export function QuickRegisterModal({ open, onClose, onDone, clientId }: { open: boolean; onClose: () => void; onDone: (p: Picked) => void; clientId?: string }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ name: '', phone: '', plate: '', noPlate: false, plateException: '', brand: '', model: '', year: '', km: '' })
  const [busy, setBusy] = useState(false)
  const [dups, setDups] = useState<any[]>([])
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))
  const plateErr = f.plate && !f.noPlate && !f.plateException && !isValidPlate(f.plate) ? 'Placa fora do padrão (ABC1D23 ou ABC1234). Se for estrangeira, informe a exceção.' : undefined

  useEffect(() => {
    if (clientId || f.phone.replace(/\D/g, '').length < 10) { setDups([]); return }
    const t = setTimeout(() => rpc<any[]>('client_possible_duplicates', { p_workshop: wsId, p_phone: f.phone, p_document: null }).then(setDups).catch(() => {}), 400)
    return () => clearTimeout(t)
  }, [f.phone, wsId, clientId])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || plateErr) return
    setBusy(true)
    try {
      const r = await rpc<{ client_id: string; vehicle_id: string }[]>('quick_register', {
        p_workshop: wsId,
        p_client: clientId ? { id: clientId } : { name: f.name, phone: f.phone },
        p_vehicle: { plate: f.noPlate ? '' : f.plate, plate_exception: f.plateException, brand: f.brand, model: f.model, year_model: f.year },
        p_km: f.km ? Number(f.km) : null,
      })
      const row = Array.isArray(r) ? r[0] : (r as any)
      qc.invalidateQueries({ queryKey: ['client-vehicles'] })
      toast.success('Cadastro salvo')
      onDone({ clientId: row.client_id, clientName: f.name, vehicleId: row.vehicle_id, vehicleLabel: `${fmtPlate(f.plate)} ${f.brand} ${f.model}` })
      setF({ name: '', phone: '', plate: '', noPlate: false, plateException: '', brand: '', model: '', year: '', km: '' })
    } catch (err) { toast.error(err) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={clientId ? 'Adicionar veículo' : 'Cadastro rápido de cliente e veículo'}>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        {!clientId && <>
          <Input label="Nome do cliente *" required minLength={2} value={f.name} onChange={set('name')} className="sm:col-span-2" />
          <Input label="Telefone / WhatsApp" inputMode="tel" value={f.phone} onChange={set('phone')} className="sm:col-span-2"
            hint="Opcional. Usado para contato e lembretes." />
          {dups.length > 0 && (
            <div className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 sm:col-span-2">
              Possível cadastro existente com este telefone: {dups.map((d) => d.name).join(', ')}. Famílias podem compartilhar telefone — confira antes de duplicar.
            </div>
          )}
        </>}
        <Input label="Placa" value={f.plate} onChange={set('plate')} disabled={f.noPlate} error={plateErr} autoCapitalize="characters" />
        <div className="flex items-end pb-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.noPlate} onChange={(e) => setF((s) => ({ ...s, noPlate: e.target.checked }))} />Sem placa (código provisório)</label></div>
        {f.plate && !isValidPlate(f.plate) && !f.noPlate && <Input label="Exceção da placa (justificativa)" value={f.plateException} onChange={set('plateException')} className="sm:col-span-2" placeholder="Ex.: veículo argentino" />}
        <Input label="Marca" value={f.brand} onChange={set('brand')} />
        <Input label="Modelo *" required value={f.model} onChange={set('model')} />
        <Input label="Ano modelo" inputMode="numeric" value={f.year} onChange={set('year')} />
        <Input label="Quilometragem atual" inputMode="numeric" value={f.km} onChange={set('km')} />
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={busy}>Salvar</Button>
        </div>
      </form>
    </Modal>
  )
}

/** Lista de membros da equipe (para atribuições). */
export function useTeam() {
  const { wsId } = useAuth()
  return useQuery({
    queryKey: ['team', wsId],
    enabled: !!wsId,
    queryFn: async () => {
      const { data, error } = await supabase.from('memberships').select('id, role, status, job_title, specialties, user_id, profiles(full_name, email)')
        .eq('workshop_id', wsId).order('created_at')
      if (error) throw error
      return (data ?? []).map((m: any) => ({ ...m, name: m.profiles?.full_name || m.profiles?.email || 'Sem nome' }))
    },
  })
}

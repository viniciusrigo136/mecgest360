import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { fmtPhone, fmtPlate, isValidPlate } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'
import { Plate } from './Plate'
import { Button, Input, Loading, Modal, useToast } from './ui'

export type ClientCar = { clientId: string; clientName: string; phone: string | null; vehicleId: string | null; plate: string | null; label: string }

type Row = { id: string; name: string; phone: string | null; cars: { id: string; plate: string | null; label: string }[] }

const SELECT = 'id, name, phone, vehicle_ownerships!vehicle_ownerships_workshop_id_client_id_fkey(ended_at, vehicles(id, plate, internal_code, brand, model))'

function toRows(data: any[]): Row[] {
  return data.map((c) => ({
    id: c.id, name: c.name, phone: c.phone,
    cars: (c.vehicle_ownerships ?? []).filter((o: any) => !o.ended_at && o.vehicles).map((o: any) => ({
      id: o.vehicles.id, plate: o.vehicles.plate ?? o.vehicles.internal_code, label: [o.vehicles.brand, o.vehicles.model].filter(Boolean).join(' '),
    })),
  }))
}

/** "Qual cliente?" — busca por nome, telefone ou placa e cadastro na hora (padrão ChapGest). */
export function ClientSheet({ open, onClose, onPick, needCar = true }: { open: boolean; onClose: () => void; onPick: (v: ClientCar) => void; needCar?: boolean }) {
  const { wsId, can } = useAuth()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [deb, setDeb] = useState('')
  const [form, setForm] = useState<null | { clientId?: string; clientName?: string }>(null)
  const [f, setF] = useState({ name: '', phone: '', plate: '', model: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDeb(q.trim()), 250); return () => clearTimeout(t) }, [q])
  useEffect(() => { if (open) { setQ(''); setForm(null); setF({ name: '', phone: '', plate: '', model: '' }) } }, [open])

  const list = useQuery({
    queryKey: ['client-sheet', wsId, deb],
    enabled: open,
    queryFn: async () => {
      if (deb.length < 2) {
        const { data, error } = await supabase.from('clients').select(SELECT).eq('workshop_id', wsId).is('archived_at', null).is('merged_into', null)
          .order('updated_at', { ascending: false }).limit(15)
        if (error) throw error
        return toRows(data ?? [])
      }
      const hits = await rpc<any[]>('search_clients_vehicles', { p_workshop: wsId, p_q: deb, p_limit: 20 })
      const ids = [...new Set(hits.map((h) => h.client_id).filter(Boolean))]
      if (!ids.length) return []
      const { data, error } = await supabase.from('clients').select(SELECT).in('id', ids)
      if (error) throw error
      return toRows(data ?? []).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    },
  })

  function pick(r: Row, car?: Row['cars'][number]) {
    if (needCar && !car) {
      if (r.cars.length === 1) car = r.cars[0]
      else if (r.cars.length === 0) { setForm({ clientId: r.id, clientName: r.name }); return }
      else return
    }
    onPick({ clientId: r.id, clientName: r.name, phone: r.phone, vehicleId: car?.id ?? null, plate: car?.plate ?? null, label: car?.label ?? '' })
  }

  const plateErr = f.plate && !isValidPlate(f.plate) ? 'Placa inválida (ex.: ABC1D23 ou ABC1234)' : undefined
  async function save() {
    if (busy || plateErr) return
    setBusy(true)
    try {
      const r = await rpc<any[]>('quick_register', { p_workshop: wsId, p_client: form?.clientId ? { id: form.clientId } : { name: f.name, phone: f.phone },
        p_vehicle: needCar || f.model ? { plate: f.plate, model: f.model } : null, p_km: null })
      onPick({ clientId: r[0].client_id, clientName: form?.clientName ?? f.name, phone: f.phone || null, vehicleId: r[0].vehicle_id, plate: f.plate || null, label: f.model })
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={form ? (form.clientId ? `Carro de ${form.clientName}` : 'Novo cliente') : 'Qual cliente?'}>
      {form ? (
        <div className="space-y-3">
          {!form.clientId && <>
            <Input label="Nome *" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} autoFocus autoComplete="off" />
            <Input label="WhatsApp" inputMode="tel" value={f.phone} onChange={(e) => setF((s) => ({ ...s, phone: e.target.value }))} placeholder="(49) 99999-9999" />
          </>}
          <div className="grid grid-cols-2 gap-3">
            <Input label={needCar ? 'Placa *' : 'Placa'} value={f.plate} error={plateErr} onChange={(e) => setF((s) => ({ ...s, plate: e.target.value.toUpperCase() }))}
              className="[&_input]:plate [&_input]:text-lg" placeholder="ABC1D23" autoCapitalize="characters" />
            <Input label={needCar ? 'Carro *' : 'Carro'} value={f.model} onChange={(e) => setF((s) => ({ ...s, model: e.target.value }))} placeholder="Ex.: Onix" />
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" className="flex-1" onClick={() => setForm(null)}>Voltar</Button>
            <Button className="flex-1" loading={busy} onClick={save}
              disabled={(!form.clientId && f.name.trim().length < 2) || (needCar && (!f.plate || !f.model.trim())) || !!plateErr}>Salvar</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <input className="input h-12 rounded-xl" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, telefone ou placa" aria-label="Buscar cliente" />
          {can('clients.create') && (
            <button onClick={() => setForm({})} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 font-medium active:bg-slate-50">
              <Plus className="size-5" />Novo cliente
            </button>
          )}
          {list.isLoading ? <Loading /> : list.data?.length ? (
            <ul className="divide-y divide-slate-100">{list.data.map((r) => (
              <li key={r.id}>
                <div role="button" tabIndex={0} onClick={() => pick(r)} onKeyDown={(e) => e.key === 'Enter' && pick(r)} className="cursor-pointer py-3 active:bg-slate-50">
                  <p className="font-semibold uppercase">{r.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {r.cars.map((c) => (
                      <button key={c.id} onClick={(e) => { e.stopPropagation(); pick(r, c) }} title={c.label} aria-label={`${fmtPlate(c.plate)} ${c.label}`}><Plate value={c.plate} /></button>
                    ))}
                    {needCar && r.cars.length !== 1 && can('vehicles.create') && (
                      <button onClick={(e) => { e.stopPropagation(); setForm({ clientId: r.id, clientName: r.name }) }} className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-600">+ carro</button>
                    )}
                    {r.phone && <span className="text-sm text-slate-500">{fmtPhone(r.phone)}</span>}
                  </div>
                  {needCar && r.cars.length > 1 && <p className="mt-1 text-xs text-slate-500">Toque na placa do carro</p>}
                </div>
              </li>
            ))}</ul>
          ) : <p className="py-4 text-center text-sm text-slate-500">{deb.length >= 2 ? 'Ninguém encontrado. Toque em Novo cliente.' : 'Nenhum cliente ainda.'}</p>}
        </div>
      )}
    </Modal>
  )
}

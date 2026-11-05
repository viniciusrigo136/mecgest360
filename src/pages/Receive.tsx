import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Camera, Check, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { useTeam } from '@/components/pickers'
import { Button, Input, Textarea, useToast, useUnsavedWarning } from '@/components/ui'
import { fmtPlate, isValidPlate, localToISO, normPlate, todayLocal } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'

// Recebimento rápido do carro: uma tela, poucos toques. Cliente e veículo
// são cadastrados na hora quando a placa ainda não existe.

const FUEL = [{ v: 0, l: 'Reserva' }, { v: 2, l: '1/4' }, { v: 4, l: '1/2' }, { v: 6, l: '3/4' }, { v: 8, l: 'Cheio' }]
const PARTS = ['Para-choque dianteiro', 'Capô', 'Para-lama diant. esq.', 'Para-lama diant. dir.', 'Porta diant. esq.', 'Porta diant. dir.',
  'Porta tras. esq.', 'Porta tras. dir.', 'Lateral tras. esq.', 'Lateral tras. dir.', 'Teto', 'Tampa traseira', 'Para-choque traseiro',
  'Retrovisor esq.', 'Retrovisor dir.', 'Para-brisa', 'Vidros', 'Rodas', 'Faróis/lanternas', 'Interior']
const ITEMS = ['Estepe', 'Macaco', 'Chave de roda', 'Triângulo', 'Tapetes', 'Rádio/multimídia', 'Chave reserva', 'Documento']

type Hit = { kind: string; id: string; title: string; subtitle: string; client_id: string | null; vehicle_id: string | null }

export function ReceivePage() {
  const { wsId, tz, can } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const team = useTeam()
  const [plate, setPlate] = useState('')
  const [noPlate, setNoPlate] = useState(false)
  const [picked, setPicked] = useState<{ client: string; clientName: string; vehicle: string; label: string } | null>(null)
  const [newCar, setNewCar] = useState({ name: '', phone: '', brand: '', model: '' })
  const [km, setKm] = useState('')
  const [kmJust, setKmJust] = useState<string | null>(null)
  const [fuel, setFuel] = useState<number | null>(null)
  const [complaint, setComplaint] = useState('')
  const [due, setDue] = useState<'hoje' | 'amanha' | 'data' | ''>('')
  const [dueDate, setDueDate] = useState(todayLocal(tz, 2))
  const [damages, setDamages] = useState<string[]>([])
  const [items, setItems] = useState<string[]>([])
  const [belongings, setBelongings] = useState('')
  const [mechanic, setMechanic] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  useUnsavedWarning(!!(plate || complaint || photos.length))

  const norm = normPlate(plate)
  const search = useQuery({
    queryKey: ['receive-plate', wsId, norm],
    enabled: !noPlate && norm.length >= 3 && !picked,
    queryFn: () => rpc<Hit[]>('search_clients_vehicles', { p_workshop: wsId, p_q: norm, p_limit: 6 }),
  })
  const hits = (search.data ?? []).filter((h) => h.kind === 'vehicle' && h.client_id)
  const exact = hits.find((h) => normPlate(h.title.split(' ')[0]) === norm)
  useEffect(() => {
    if (exact && !picked) setPicked({ client: exact.client_id!, clientName: exact.subtitle, vehicle: exact.vehicle_id!, label: exact.title })
  }, [exact, picked])

  const isNew = !picked && (noPlate || (norm.length >= 7 && !search.isLoading && !exact))
  const plateOk = noPlate || isValidPlate(plate)
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const canSubmit = (picked || (isNew && plateOk && newCar.name.trim().length >= 2 && newCar.model.trim())) && complaint.trim()

  async function submit() {
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      let clientId = picked?.client, vehicleId = picked?.vehicle
      if (!picked) {
        const r = await rpc<any[]>('quick_register', { p_workshop: wsId, p_client: { name: newCar.name, phone: newCar.phone },
          p_vehicle: { plate: noPlate ? '' : plate, brand: newCar.brand, model: newCar.model }, p_km: null })
        clientId = r[0].client_id; vehicleId = r[0].vehicle_id
        setPicked({ client: clientId!, clientName: newCar.name, vehicle: vehicleId!, label: `${fmtPlate(plate)} ${newCar.brand} ${newCar.model}` })
      }
      const expected = due === 'hoje' ? localToISO(todayLocal(tz), '18:00', tz) : due === 'amanha' ? localToISO(todayLocal(tz, 1), '18:00', tz)
        : due === 'data' ? localToISO(dueDate, '18:00', tz) : null
      const orderId = await rpc<string>('open_order', { p_workshop: wsId, p_client: clientId, p_vehicle: vehicleId, p_complaint: complaint,
        p_km: km ? Number(km) : null, p_fuel: fuel, p_expected_delivery: expected, p_mechanics: mechanic ? [mechanic] : [], p_km_justification: kmJust })

      // checklist de entrada com o que foi marcado
      const { data: ck } = await supabase.from('order_checklists').select('items').eq('order_id', orderId).eq('kind', 'entry').maybeSingle()
      if (ck) {
        const filled = (ck.items as any[]).map((i) =>
          i.key === 'lataria' ? { ...i, state: damages.length ? 'avaria' : 'ok', note: damages.join(', ') }
          : i.key === 'acessorios' ? { ...i, state: 'ok', note: items.length ? `Presentes: ${items.join(', ')}` : '' }
          : i.key === 'objetos' ? { ...i, state: belongings ? 'ok' : 'na', note: belongings } : i)
        await rpc('save_checklist', { p_order: orderId, p_kind: 'entry', p_items: filled, p_belongings: belongings || null, p_complete: false })
      }
      for (const file of photos) {
        const ext = file.type.split('/')[1] || 'jpg'
        const path = `${wsId}/${orderId}/${crypto.randomUUID()}.${ext}`
        const up = await supabase.storage.from('order-files').upload(path, file, { contentType: file.type })
        if (!up.error) await supabase.from('order_attachments').insert({ workshop_id: wsId, order_id: orderId, storage_path: path, mime_type: file.type,
          size_bytes: file.size, kind: 'photo', stage: 'entrada' })
      }
      toast.success('Carro recebido')
      nav(`/os/${orderId}`, { replace: true })
    } catch (e: any) {
      if (e?.code === 'P0002') setKmJust(kmJust ?? '')
      toast.error(e)
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 pb-20">
      <h1 className="font-heading text-2xl font-extrabold">Receber carro</h1>

      <Section n={1} title="Qual carro?">
        {picked ? (
          <div className="flex items-center gap-3 rounded-md border-2 border-brand bg-brand-soft p-3">
            <Check className="size-5 text-brand" />
            <div className="min-w-0 flex-1"><p className="plate text-xl">{picked.label}</p><p className="truncate text-sm text-slate-600">{picked.clientName}</p></div>
            <button className="rounded-full p-2 text-slate-500 active:bg-slate-100" aria-label="Trocar carro" onClick={() => { setPicked(null); setPlate('') }}><X className="size-5" /></button>
          </div>
        ) : (
          <>
            {!noPlate && <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="ABC1D23" autoFocus aria-label="Placa"
              className="plate input h-16 text-center text-3xl" maxLength={8} autoCapitalize="characters" autoComplete="off" />}
            <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={noPlate} onChange={(e) => setNoPlate(e.target.checked)} className="size-4" />Carro sem placa</label>
            {hits.length > 0 && !exact && (
              <div className="space-y-2">{hits.map((h) => (
                <button key={h.id} onClick={() => setPicked({ client: h.client_id!, clientName: h.subtitle, vehicle: h.vehicle_id!, label: h.title })}
                  className="w-full rounded-md border border-slate-200 bg-card p-3 text-left active:bg-slate-50">
                  <p className="plate text-lg">{h.title}</p><p className="text-sm text-slate-500">{h.subtitle}</p>
                </button>
              ))}</div>
            )}
            {isNew && can('clients.create') && (
              <div className="space-y-3 rounded-md border border-dashed border-slate-300 p-3">
                <p className="text-sm font-medium"><Plus className="mr-1 inline size-4" />Carro novo — cadastre agora</p>
                {!noPlate && !plateOk && <p className="text-sm text-red-600">Placa inválida (ex.: ABC1D23 ou ABC1234)</p>}
                <Input label="Nome do cliente *" value={newCar.name} onChange={(e) => setNewCar((s) => ({ ...s, name: e.target.value }))} autoComplete="off" />
                <Input label="WhatsApp" inputMode="tel" value={newCar.phone} onChange={(e) => setNewCar((s) => ({ ...s, phone: e.target.value }))} placeholder="(11) 99999-9999" />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Marca" value={newCar.brand} onChange={(e) => setNewCar((s) => ({ ...s, brand: e.target.value }))} placeholder="Fiat, VW…" />
                  <Input label="Modelo *" value={newCar.model} onChange={(e) => setNewCar((s) => ({ ...s, model: e.target.value }))} placeholder="Onix" />
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      <Section n={2} title="Entrada">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Km no painel" inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ''))} placeholder="Ex.: 48500" />
          <div><p className="label">Previsão</p><Chips options={[['hoje', 'Hoje'], ['amanha', 'Amanhã'], ['data', 'Data']]} value={due} onChange={(v) => setDue(v === due ? '' : v as typeof due)} /></div>
        </div>
        {due === 'data' && <Input label="Entregar em" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />}
        {kmJust !== null && <Input label="Km menor que a última leitura — por quê?" value={kmJust} onChange={(e) => setKmJust(e.target.value)} placeholder="Ex.: troca de painel" />}
        <div><p className="label">Combustível</p><Chips options={FUEL.map((f) => [String(f.v), f.l])} value={fuel === null ? '' : String(fuel)} onChange={(v) => setFuel(fuel === Number(v) ? null : Number(v))} /></div>
        <Textarea label="O que o cliente pediu? *" value={complaint} onChange={(e) => setComplaint(e.target.value)} placeholder="Ex.: barulho na suspensão dianteira, revisão dos 50 mil" />
        {team.data && team.data.filter((m) => m.status === 'active' && m.role === 'mechanic').length > 0 && (
          <div><p className="label">Mecânico</p><Chips options={team.data.filter((m) => m.status === 'active' && m.role === 'mechanic').map((m) => [m.id, m.name.split(' ')[0]])}
            value={mechanic} onChange={(v) => setMechanic(v === mechanic ? '' : v)} /></div>
        )}
      </Section>

      <Section n={3} title="Avarias que o carro já tem" hint="Toque nas partes com risco, amassado ou quebra">
        <div className="flex flex-wrap gap-2">{PARTS.map((p) => <Chip key={p} on={damages.includes(p)} tone="red" onClick={() => toggle(damages, setDamages, p)}>{p}</Chip>)}</div>
        {damages.length === 0 && <p className="text-sm text-slate-500">Nenhuma avaria marcada.</p>}
        <p className="label mt-2">Itens no veículo</p>
        <div className="flex flex-wrap gap-2">{ITEMS.map((p) => <Chip key={p} on={items.includes(p)} onClick={() => toggle(items, setItems, p)}>{p}</Chip>)}</div>
        <Input label="Objetos deixados no carro" value={belongings} onChange={(e) => setBelongings(e.target.value)} placeholder="Ex.: cadeirinha, óculos no porta-luvas" />
      </Section>

      <Section n={4} title="Fotos" hint="Fotos da entrada protegem a oficina e ajudam o cliente a entender o serviço">
        <div className="grid grid-cols-3 gap-2">
          {photos.map((f, i) => (
            <div key={i} className="relative aspect-square overflow-hidden rounded-md bg-slate-100">
              <img src={URL.createObjectURL(f)} alt={`Foto ${i + 1}`} className="size-full object-cover" />
              <button className="absolute right-1 top-1 rounded-full bg-ink/60 p-1 text-white" aria-label="Remover foto" onClick={() => setPhotos((s) => s.filter((_, j) => j !== i))}><X className="size-4" /></button>
            </div>
          ))}
          <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-slate-300 text-sm text-slate-500 active:bg-slate-50">
            <Camera className="size-6" />Tirar foto
            <input type="file" accept="image/*" capture="environment" multiple className="sr-only"
              onChange={(e) => { setPhotos((s) => [...s, ...Array.from(e.target.files ?? []).filter((f) => f.size <= 15 * 1024 * 1024)]); e.target.value = '' }} />
          </label>
        </div>
      </Section>

      <div className="fixed inset-x-0 bottom-16 z-20 border-t border-slate-200 bg-card/95 p-3 backdrop-blur lg:bottom-0 lg:left-64">
        <div className="mx-auto max-w-xl"><Button size="lg" className="w-full" loading={busy} disabled={!canSubmit} onClick={submit}>Receber carro</Button>
          {!canSubmit && <p className="mt-1 text-center text-xs text-slate-500">{!picked && !isNew ? 'Digite a placa do carro' : !complaint.trim() ? 'Diga o que o cliente pediu' : 'Preencha nome e modelo'}</p>}
        </div>
      </div>
    </div>
  )
}

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">{n}</span>
        <h2 className="text-lg font-bold">{title}</h2></div>
      {hint && <p className="-mt-1 text-sm text-slate-500">{hint}</p>}
      {children}
    </section>
  )
}

export function Chip({ on, onClick, children, tone = 'blue' }: { on: boolean; onClick: () => void; children: React.ReactNode; tone?: 'blue' | 'red' }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={clsx('min-h-10 rounded-full border px-3.5 text-sm font-medium transition-colors',
        on ? (tone === 'red' ? 'border-red-600 bg-red-50 text-red-700' : 'border-brand bg-brand-soft text-brand-strong') : 'border-slate-300 bg-card text-slate-700 active:bg-slate-50')}>
      {children}
    </button>
  )
}

export function Chips({ options, value, onChange }: { options: string[][]; value: string; onChange: (v: string) => void }) {
  return <div className="flex flex-wrap gap-2">{options.map(([v, l]) => <Chip key={v} on={value === v} onClick={() => onChange(v)}>{l}</Chip>)}</div>
}

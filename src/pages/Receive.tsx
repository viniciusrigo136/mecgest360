import clsx from 'clsx'
import { Camera, ChevronLeft, ChevronRight, User, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { ClientSheet, type ClientCar } from '@/components/ClientSheet'
import { Plate } from '@/components/Plate'
import { Button, useToast, useUnsavedWarning } from '@/components/ui'
import { localToISO, todayLocal } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'

// Receber carro em poucos toques: quem é, km, o que fazer, fotos.

export function ReceivePage() {
  const { wsId, tz } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const [picked, setPicked] = useState<ClientCar | null>(null)
  const [sheet, setSheet] = useState(false)
  const [km, setKm] = useState('')
  const [kmJust, setKmJust] = useState<string | null>(null)
  const [complaint, setComplaint] = useState('')
  const [due, setDue] = useState<'' | 'hoje' | 'amanha' | 'data'>('')
  const [dueDate, setDueDate] = useState(todayLocal(tz, 2))
  const [photos, setPhotos] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  useUnsavedWarning(!!(picked || complaint || photos.length))
  const canSubmit = !!picked?.vehicleId && complaint.trim().length > 0

  async function submit() {
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      const expected = due === 'hoje' ? localToISO(todayLocal(tz), '18:00', tz) : due === 'amanha' ? localToISO(todayLocal(tz, 1), '18:00', tz)
        : due === 'data' ? localToISO(dueDate, '18:00', tz) : null
      const orderId = await rpc<string>('open_order', { p_workshop: wsId, p_client: picked!.clientId, p_vehicle: picked!.vehicleId, p_complaint: complaint.trim(),
        p_km: km ? Number(km) : null, p_expected_delivery: expected, p_km_justification: kmJust || null })
      for (const file of photos) {
        const path = `${wsId}/${orderId}/${crypto.randomUUID()}.${file.type.split('/')[1] || 'jpg'}`
        const up = await supabase.storage.from('order-files').upload(path, file, { contentType: file.type })
        if (!up.error) await supabase.from('order_attachments').insert({ workshop_id: wsId, order_id: orderId, storage_path: path, mime_type: file.type,
          size_bytes: file.size, kind: 'photo', stage: 'entrada' })
      }
      toast.success('Carro recebido')
      nav(`/os/${orderId}`, { replace: true })
    } catch (e: any) {
      if (e?.code === 'P0002') setKmJust('')
      toast.error(e)
    } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-3 pb-24">
      <div className="flex items-center gap-2">
        <button onClick={() => nav(-1)} aria-label="Voltar" className="flex size-10 items-center justify-center rounded-full text-slate-600 active:bg-slate-100"><ChevronLeft className="size-6" /></button>
        <h1 className="font-heading text-2xl font-extrabold">Receber carro</h1>
      </div>

      <button onClick={() => setSheet(true)} className={clsx('flex w-full items-center gap-3 rounded-2xl border-2 bg-card p-4 text-left',
        picked ? 'border-slate-200' : 'border-brand')}>
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><User className="size-6" /></span>
        {picked ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold uppercase">{picked.clientName}</span>
            <span className="mt-1 flex items-center gap-2"><Plate value={picked.plate} /><span className="truncate text-sm text-slate-500">{picked.label}</span></span>
          </span>
        ) : (
          <span className="flex-1"><span className="block font-heading text-lg font-bold text-brand-strong">Escolher cliente e carro</span>
            <span className="text-sm text-slate-500">Busque pelo nome ou placa</span></span>
        )}
        <ChevronRight className="size-5 text-slate-400" />
      </button>

      <section className="card space-y-4 p-4">
        <div>
          <label htmlFor="rc-what" className="label">O que precisa ser feito? *</label>
          <textarea id="rc-what" className="input min-h-24" value={complaint} onChange={(e) => setComplaint(e.target.value)}
            placeholder="Ex.: troca de óleo e barulho na suspensão" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="rc-km" className="label">Km do painel</label>
            <input id="rc-km" className="input" inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ''))} placeholder="48500" />
          </div>
          <div>
            <p className="label">Entrega</p>
            <div className="flex gap-1.5">
              {([['hoje', 'Hoje'], ['amanha', 'Amanhã'], ['data', 'Outro']] as const).map(([v, l]) => (
                <button key={v} type="button" aria-pressed={due === v} onClick={() => setDue(due === v ? '' : v)}
                  className={clsx('min-h-11 flex-1 rounded-[8px] border text-sm font-medium', due === v ? 'border-brand bg-brand-soft text-brand-strong' : 'border-slate-300 bg-card')}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        {due === 'data' && <input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Data de entrega" />}
        {kmJust !== null && (
          <div>
            <label htmlFor="rc-just" className="label">Km menor que a última anotada — por quê?</label>
            <input id="rc-just" className="input" value={kmJust} onChange={(e) => setKmJust(e.target.value)} placeholder="Ex.: troca de painel" />
          </div>
        )}
      </section>

      <section className="card p-4">
        <p className="label">Fotos do carro</p>
        <div className="grid grid-cols-4 gap-2">
          {photos.map((f, i) => (
            <div key={i} className="relative aspect-square overflow-hidden rounded-[8px] bg-slate-100">
              <img src={URL.createObjectURL(f)} alt={`Foto ${i + 1}`} className="size-full object-cover" />
              <button className="absolute right-1 top-1 rounded-full bg-ink/60 p-1 text-white" aria-label="Remover foto" onClick={() => setPhotos((s) => s.filter((_, j) => j !== i))}><X className="size-3.5" /></button>
            </div>
          ))}
          <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border-2 border-dashed border-slate-300 text-xs text-slate-500 active:bg-slate-50">
            <Camera className="size-6" />Foto
            <input type="file" accept="image/*" capture="environment" multiple className="sr-only"
              onChange={(e) => { setPhotos((s) => [...s, ...Array.from(e.target.files ?? []).filter((f) => f.size <= 15 * 1024 * 1024)]); e.target.value = '' }} />
          </label>
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-16 z-20 border-t border-slate-200 bg-card/95 p-3 backdrop-blur lg:bottom-0 lg:left-72">
        <div className="mx-auto max-w-2xl">
          <Button size="lg" className="w-full" loading={busy} disabled={!canSubmit} onClick={submit}>Receber carro</Button>
        </div>
      </div>

      <ClientSheet open={sheet} onClose={() => setSheet(false)} onPick={(v) => { setPicked(v); setSheet(false) }} />
    </div>
  )
}

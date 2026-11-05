import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { BellRing, Plus } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { fmtDate, fmtKm } from '@/lib/format'
import { rpc } from '@/lib/supabase'
import { Button, Modal, useToast } from './ui'

export type ReturnChoice = { label: string; months: number; km: number }

export const MONTHS: [number, string][] = [[3, '3 meses'], [6, '6 meses'], [12, '1 ano'], [24, '2 anos']]
export const KMS: [number, string][] = [[5000, '5 mil km'], [10000, '10 mil km'], [20000, '20 mil km'], [40000, '40 mil km']]

export function describeReturn(months: number | null, km: number | null) {
  const t = months ? (MONTHS.find((m) => m[0] === months)?.[1] ?? `${months} meses`) : null
  const k = km ? (KMS.find((m) => m[0] === km)?.[1] ?? fmtKm(km)) : null
  return [t, k].filter(Boolean).join(' ou ')
}

/** Escolha rápida de "voltar depois de quanto tempo ou km" (toque para marcar/desmarcar). */
export function ReturnPicker({ value, onChange }: { value: { months: number; km: number }; onChange: (v: { months: number; km: number }) => void }) {
  const chip = (on: boolean) => clsx('min-h-10 rounded-full border px-3 text-sm font-medium', on ? 'border-emerald-600 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-card text-slate-700')
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">{MONTHS.map(([m, l]) => (
        <button key={m} type="button" aria-pressed={value.months === m} className={chip(value.months === m)} onClick={() => onChange({ ...value, months: value.months === m ? 0 : m })}>{l}</button>
      ))}</div>
      <div className="flex flex-wrap gap-1.5">{KMS.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value.km === k} className={chip(value.km === k)} onClick={() => onChange({ ...value, km: value.km === k ? 0 : k })}>{l}</button>
      ))}</div>
    </div>
  )
}

/** Lembretes de retorno deste serviço + botão para adicionar a qualquer momento. */
export function RemindersCard({ orderId, items }: { orderId: string; items: string[] }) {
  const { can } = useAuth()
  const list = useQuery({ queryKey: ['order-reminders', orderId], enabled: can('maintenance.view') || can('orders.execute'), queryFn: () => rpc<any[]>('order_reminders', { p_order: orderId }) })
  const [open, setOpen] = useState(false)
  const canAdd = can('orders.execute') || can('maintenance.edit')
  return (
    <section className="card border-emerald-200 p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><BellRing className="size-5 text-emerald-700" />Lembrar o cliente de voltar</h2>
        {canAdd && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus className="size-4" />Lembrete</Button>}
      </div>
      <p className="mb-2 text-sm text-slate-500">O sistema avisa quando estiver chegando a hora e o WhatsApp sai pronto.</p>
      {list.data?.length ? (
        <ul className="divide-y divide-slate-100">{list.data.map((r) => (
          <li key={r.plan_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="font-medium">{r.label}</span>
            <span className="text-sm text-slate-600">{describeReturn(r.interval_months, r.interval_km)}{r.target_date && ` · ${fmtDate(r.target_date)}`}{r.target_km && ` · ${fmtKm(r.target_km)}`}</span>
          </li>
        ))}</ul>
      ) : <p className="text-sm text-slate-500">Nenhum lembrete ainda.</p>}
      <AddReminder open={open} onClose={() => setOpen(false)} orderId={orderId} suggestions={items} />
    </section>
  )
}

function AddReminder({ open, onClose, orderId, suggestions }: { open: boolean; onClose: () => void; orderId: string; suggestions: string[] }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [v, setV] = useState({ months: 0, km: 0 })
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      await rpc('add_return_reminder', { p_order: orderId, p_label: label, p_months: v.months || null, p_km: v.km || null })
      toast.success('Lembrete criado'); qc.invalidateQueries({ queryKey: ['order-reminders', orderId] }); setLabel(''); setV({ months: 0, km: 0 }); onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Lembrete de retorno">
      <div className="space-y-3">
        <div>
          <label htmlFor="rr-label" className="label">O que foi feito?</label>
          <input id="rr-label" className="input" list="rr-sug" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: Amortecedores" autoFocus />
          <datalist id="rr-sug">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
        </div>
        <p className="label">Voltar depois de</p>
        <ReturnPicker value={v} onChange={setV} />
        <Button size="lg" className="w-full" loading={busy} disabled={!label.trim() || (!v.months && !v.km)} onClick={save}>Criar lembrete</Button>
      </div>
    </Modal>
  )
}

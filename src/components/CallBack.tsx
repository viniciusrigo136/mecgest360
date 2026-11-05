import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, CalendarPlus, Check, MessageCircle } from 'lucide-react'
import { Link } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { fmtDate } from '@/lib/format'
import { techStatus } from '@/lib/labels'
import { rpc } from '@/lib/supabase'
import { waLink } from '@/lib/whatsapp'
import { Plate } from './Plate'
import { StatusBadge, useToast } from './ui'

const DUE = ['overdue_date', 'overdue_km', 'due_soon', 'estimated']

/** Destaque "Chamar de volta": clientes cujo retorno está chegando ou passou. */
export function CallBack({ limit = 5, full = false }: { limit?: number; full?: boolean }) {
  const { wsId, ws, can } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['callback', wsId, limit], enabled: can('maintenance.view'),
    queryFn: () => rpc<any[]>('maintenance_board', { p_workshop: wsId, p_tech_status: DUE, p_contact_status: ['not_contacted', 'pending', 'contacted', 'responded', 'postponed'], p_limit: limit }),
  })
  if (!can('maintenance.view')) return null
  const rows = q.data ?? []
  const total = Number(rows[0]?.total_count ?? 0)

  function message(r: any) {
    return `Olá, ${(r.client_name ?? '').split(' ')[0]}! Aqui é da ${ws?.name}. Já está chegando a hora de conferir ${r.component_label.toLowerCase()} do seu ${r.vehicle_label} (fizemos em ${fmtDate(r.base_date)}). Quer agendar um horário?`
  }
  async function send(r: any) {
    const url = waLink(r.client_whatsapp, message(r))
    if (!url) return toast.error({ message: 'Cliente sem WhatsApp cadastrado' })
    window.open(url, '_blank', 'noopener,noreferrer')
    rpc('log_contact', { p_workshop: wsId, p_client: r.client_id, p_channel: 'whatsapp', p_kind: 'conversation_opened', p_message: message(r), p_outcome: null, p_cycle: r.cycle_id })
      .then(() => qc.invalidateQueries({ queryKey: ['callback'] })).catch(() => {})
  }
  async function scheduled(r: any) {
    try {
      await rpc('log_contact', { p_workshop: wsId, p_client: r.client_id, p_channel: 'whatsapp', p_kind: 'response', p_message: 'Agendou', p_outcome: 'agendou', p_cycle: r.cycle_id })
      toast.success('Marcado como agendado'); qc.invalidateQueries({ queryKey: ['callback'] }); qc.invalidateQueries({ queryKey: ['returns-count'] })
    } catch (e) { toast.error(e) }
  }

  return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold"><BellRing className="size-5 text-emerald-700" />Chamar de volta{total > 0 && <span className="rounded-full bg-emerald-700 px-2 py-0.5 text-xs text-white">{total}</span>}</h2>
        {!full && <Link to="/preventiva" className="text-sm font-medium text-brand">Ver todos</Link>}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-600">Ninguém para chamar agora. Ao finalizar um serviço, marque depois de quanto tempo ou km o cliente deve voltar.</p>
      ) : (
        <ul className="space-y-2">{rows.map((r) => (
          <li key={r.cycle_id} className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-3">
            <Plate value={r.plate} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{r.client_name} · <span className="font-normal text-slate-600">{r.component_label}</span></p>
              <p className="text-xs text-slate-500">Feito em {fmtDate(r.base_date)}{r.target_date && ` · voltar em ${fmtDate(r.target_date)}`} {r.last_contact_at && '· já contatado'}</p>
            </div>
            <StatusBadge map={techStatus} value={r.tech_status} />
            <div className="flex gap-1.5">
              {can('messages.send') && <button onClick={() => send(r)} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-wa px-3 text-sm font-medium text-white"><MessageCircle className="size-4" />WhatsApp</button>}
              {can('contacts.edit') && <button onClick={() => scheduled(r)} title="Cliente agendou" className="inline-flex h-10 items-center gap-1 rounded-xl border border-slate-200 bg-card px-3 text-sm"><Check className="size-4" />Agendou</button>}
              {can('schedule.create') && <Link to="/agenda?novo=1" title="Agendar" className="inline-flex size-10 items-center justify-center rounded-xl border border-slate-200 bg-card"><CalendarPlus className="size-4" /></Link>}
            </div>
          </li>
        ))}</ul>
      )}
    </section>
  )
}

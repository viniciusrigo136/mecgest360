import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Sparkles, Target } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { brl, todayLocal } from '@/lib/format'
import { rpc } from '@/lib/supabase'
import { Button, Modal } from './ui'

const KEY = 'mecgest.resumo'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
}

/** "Resumo do dia": abre no primeiro acesso de cada dia neste aparelho (padrão ChapGest). */
export function DaySummary() {
  const { wsId, tz } = useAuth()
  const today = todayLocal(tz)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try { const v = localStorage.getItem(KEY); if (v !== 'nunca' && v !== today) setOpen(true) } catch { /* sem armazenamento: não mostra */ }
  }, [today])
  const q = useQuery({ queryKey: ['day-summary', wsId], enabled: open, queryFn: () => rpc<any>('day_summary', { p_workshop: wsId }) })
  const close = (never = false) => { try { localStorage.setItem(KEY, never ? 'nunca' : today) } catch { /* ignorado */ } setOpen(false) }
  const d = q.data
  const urgent = d ? Number(d.late) + Number(d.parts_pending) + Number(d.awaiting_approval) : 0
  const tip = !d ? '' : Number(d.ready) > 0 ? `${d.ready} carro(s) pronto(s): avise os clientes para buscar.`
    : Number(d.in_shop) === 0 ? 'Oficina livre: bom dia para mandar orçamentos e chamar clientes antigos.'
    : `${d.in_shop} carro(s) na oficina. Mantenha os clientes informados pelo recado.`
  const date = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())

  return (
    <Modal open={open} onClose={() => close()} title="Resumo do dia">
      <div className="space-y-4">
        <div>
          <p className="font-heading text-2xl font-extrabold">{greeting()}</p>
          <p className="text-slate-500 first-letter:uppercase">{date}</p>
        </div>
        {d && <>
          <p className="flex gap-2.5 rounded-2xl bg-brand-soft p-4 text-brand-strong"><Target className="mt-0.5 size-5 shrink-0" />{tip}</p>
          <div>
            <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Ontem</p>
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="text-slate-700">{Number(d.delivered_yesterday) === 0 ? 'Nenhum carro entregue' : `${d.delivered_yesterday} carro(s) entregue(s)`}
                {d.received_yesterday_cents !== null && <> e entraram {brl(d.received_yesterday_cents)} em pagamentos</>}.</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Num n={d.delivered_yesterday} l="entregues ontem" /><Num n={d.services_7d} l="serviços em 7 dias" /><Num n={d.in_shop} l="na oficina agora" />
              </div>
            </div>
          </div>
          <div>
            <p className="mb-2 flex items-center justify-between text-sm font-semibold uppercase tracking-wide text-slate-500">Urgências
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-600">{urgent}</span></p>
            {urgent === 0 ? (
              <p className="flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-emerald-800"><Sparkles className="size-5" />Nada urgente. Bom trabalho!</p>
            ) : (
              <ul className="space-y-1.5 rounded-2xl bg-amber-50 p-4 text-amber-900">
                {Number(d.late) > 0 && <li>{d.late} serviço(s) atrasado(s) — avise o cliente e combine nova data</li>}
                {Number(d.parts_pending) > 0 && <li>{d.parts_pending} esperando peça</li>}
                {Number(d.awaiting_approval) > 0 && <li>{d.awaiting_approval} orçamento(s) esperando o cliente aprovar</li>}
              </ul>
            )}
          </div>
        </>}
        <div className="flex items-center justify-between gap-3 pt-1">
          <button onClick={() => close(true)} className="text-slate-500 underline-offset-2 hover:underline">Nunca mostrar</button>
          <Button size="lg" onClick={() => close()}><CheckCircle2 className="size-5" />Entendi</Button>
        </div>
      </div>
    </Modal>
  )
}

function Num({ n, l }: { n: number | string; l: string }) {
  return <div><p className="font-heading text-2xl font-extrabold">{n}</p><p className="text-sm text-slate-500">{l}</p></div>
}

import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDownRight, ArrowUpRight, ChevronLeft, Minus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { ErrorBox, Loading } from '@/components/ui'
import { brl } from '@/lib/format'
import { rpc } from '@/lib/supabase'

const PERIODS = [7, 30, 60, 90]
const ORIGIN: Record<string, string> = { balcao: 'Chegou na oficina', agendamento: 'Agendado', garantia: 'Garantia', portal: 'Pelo link', retorno_preventivo: 'Retorno de revisão' }

type Pair = { cur: number | string | null; prev: number | string | null } | null

function compact(cents: number) {
  const v = cents / 100
  if (Math.abs(v) >= 1000) return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`
  return brl(cents)
}

export function IndicatorsPage() {
  const { wsId } = useAuth()
  const nav = useNavigate()
  const [days, setDays] = useState(30)
  const q = useQuery({ queryKey: ['indicators', wsId, days], queryFn: () => rpc<any>('indicators', { p_workshop: wsId, p_days: days }) })
  const d = q.data
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <button onClick={() => nav(-1)} aria-label="Voltar" className="mt-0.5 flex size-10 items-center justify-center rounded-full text-slate-600 active:bg-slate-100 lg:hidden"><ChevronLeft className="size-6" /></button>
        <div><h1 className="font-heading text-3xl font-extrabold">Indicadores</h1>
          <p className="text-slate-500">Últimos {days} dias comparados aos {days} dias anteriores</p></div>
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {PERIODS.map((p) => (
          <button key={p} onClick={() => setDays(p)} className={clsx('h-11 shrink-0 rounded-full border px-5 font-medium', days === p ? 'border-brand bg-brand text-white' : 'border-slate-200 bg-card')}>Últ. {p} dias</button>
        ))}
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {d && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          {d.sales && <Kpi label="Vendas (serviços abertos)" pair={d.sales} fmt={(v) => compact(v)} />}
          {d.received && <Kpi label="Recebido" pair={d.received} fmt={(v) => compact(v)} />}
          <Kpi label="Serviços" pair={d.services} fmt={(v) => String(v)} />
          {d.ticket && <Kpi label="Ticket médio" pair={d.ticket} fmt={(v) => brl(v)} />}
          <Kpi label="Orçamentos aprovados" pair={d.quotes_pct} fmt={(v) => `${v}%`} />
          <Kpi label="Clientes novos" pair={d.new_clients} fmt={(v) => String(v)} />
        </div>
        <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
          {d.daily && <section className="card p-5"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold">Vendas por dia</h2>
            <span className="flex items-center gap-4 text-sm text-slate-500"><span className="flex items-center gap-1.5"><span className="h-0.5 w-5 bg-brand" />Atual</span>
              <span className="flex items-center gap-1.5"><span className="w-5 border-t-2 border-dashed border-slate-400" />Período anterior</span></span></div>
            <SalesChart data={d.daily} /></section>}
          <section className="card p-5"><h2 className="mb-3 text-lg font-bold">Como os carros chegaram</h2>
            {Object.keys(d.origins).length === 0 ? <p className="text-slate-500">Sem serviços no período.</p> : (
              <ul className="space-y-2">{Object.entries(d.origins as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
                const total = Object.values(d.origins as Record<string, number>).reduce((s, x) => s + Number(x), 0)
                return (
                  <li key={k}><div className="flex justify-between text-sm"><span>{ORIGIN[k] ?? k}</span><b>{n}</b></div>
                    <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand" style={{ width: `${(Number(n) / total) * 100}%` }} /></div></li>
                )
              })}</ul>
            )}</section>
        </div>
        <section className="card p-5">
          <h2 className="text-lg font-bold">Serviços por marca</h2>
          <p className="mb-3 text-sm text-slate-500">Tempo médio conta só os carros já entregues.</p>
          {d.by_brand.length === 0 ? <p className="text-slate-500">Sem serviços no período.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr><th className="th">Marca</th><th className="th text-right">Serviços</th>{d.sales && <th className="th text-right">Valor</th>}<th className="th text-right">Tempo méd.</th></tr></thead>
              <tbody>{d.by_brand.map((b: any) => (
                <tr key={b.brand} className="border-t border-slate-100"><td className="td font-medium">{b.brand}</td><td className="td text-right">{b.n}</td>
                  {d.sales && <td className="td text-right">{brl(b.revenue)}</td>}<td className="td text-right">{b.avg_days !== null ? `${String(b.avg_days).replace('.', ',')} dias` : '—'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </>}
    </div>
  )
}

function Kpi({ label, pair, fmt }: { label: string; pair: Pair; fmt: (v: number) => string }) {
  const cur = pair?.cur === null || pair?.cur === undefined ? null : Number(pair.cur)
  const prev = pair?.prev === null || pair?.prev === undefined ? null : Number(pair.prev)
  const diff = cur !== null && prev ? Math.round(((cur - prev) / prev) * 100) : null
  return (
    <div className="card p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 font-heading text-2xl font-extrabold">{cur === null ? '—' : fmt(cur)}</p>
      <span className={clsx('mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
        diff === null ? 'bg-slate-100 text-slate-600' : diff >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>
        {diff === null ? <><Minus className="size-3" />{prev === null ? 'novo' : 'sem dados'}</>
          : diff >= 0 ? <><ArrowUpRight className="size-3" />{diff}%</> : <><ArrowDownRight className="size-3" />{Math.abs(diff)}%</>}
      </span>
    </div>
  )
}

function SalesChart({ data }: { data: { day: string; cur: number; prev: number }[] }) {
  const W = 640, H = 220, P = { l: 56, r: 12, t: 12, b: 28 }
  const max = Math.max(1, ...data.map((d) => Math.max(Number(d.cur), Number(d.prev))))
  const x = (i: number) => P.l + (i / Math.max(1, data.length - 1)) * (W - P.l - P.r)
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b)
  const path = (k: 'cur' | 'prev') => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(d[k])).toFixed(1)}`).join(' ')
  const empty = data.every((d) => Number(d.cur) === 0)
  const ticks = data.filter((_, i) => i % Math.max(1, Math.ceil(data.length / 6)) === 0)
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" role="img" aria-label="Vendas por dia">
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={P.l} x2={W - P.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-slate-200)" />
          <text x={P.l - 6} y={y(max * f) + 4} textAnchor="end" fontSize="11" fill="var(--color-slate-500)">{f === 0 ? '0' : compact(max * f)}</text></g>)}
        <path d={path('prev')} fill="none" stroke="var(--color-slate-400)" strokeWidth="2" strokeDasharray="5 4" />
        <path d={path('cur')} fill="none" stroke="var(--color-brand)" strokeWidth="2.5" strokeLinejoin="round" />
        {ticks.map((d) => { const i = data.indexOf(d); return <text key={d.day} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--color-slate-500)">{d.day.slice(8, 10)}/{d.day.slice(5, 7)}</text> })}
      </svg>
      {empty && <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-slate-500">Sem vendas no período.</p>}
    </div>
  )
}

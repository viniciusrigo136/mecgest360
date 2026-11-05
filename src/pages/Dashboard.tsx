import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CalendarPlus, CarFront, ChevronRight, Clock, FileText, PackageX, Timer } from 'lucide-react'
import { Link } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { CallBack } from '@/components/CallBack'
import { DaySummary } from '@/components/DaySummary'
import { Plate } from '@/components/Plate'
import { ErrorBox, Loading, StatusBadge } from '@/components/ui'
import { brl, fmtDateTime, fmtPlate } from '@/lib/format'
import { orderStatus } from '@/lib/labels'
import { rpc } from '@/lib/supabase'

const IN_SHOP = ['open', 'diagnosis', 'awaiting_approval', 'approved', 'in_progress', 'quality_check', 'ready']

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
}

export function Dashboard() {
  const { wsId, can, tz, session, ws } = useAuth()
  const q = useQuery({ queryKey: ['dashboard', wsId], queryFn: () => rpc<any>('dashboard_summary', { p_workshop: wsId }), refetchInterval: 60_000 })
  const board = useQuery({
    queryKey: ['dash-board', wsId], enabled: can('orders.view'),
    queryFn: () => rpc<any[]>('orders_board', { p_workshop: wsId, p_status: IN_SHOP, p_limit: 30 }), refetchInterval: 60_000,
  })
  const d = q.data ?? {}
  const cars = board.data ?? []
  const name = (session?.user.user_metadata?.full_name as string | undefined)?.split(' ')[0]
  const ready = cars.filter((o) => o.status === 'ready').length
  const waiting = cars.filter((o) => o.status === 'awaiting_approval').length
  const urgent = [
    ...cars.filter((o) => o.late).map((o) => ({ o, icon: Clock, text: 'Atrasado — avise o cliente e combine nova data' })),
    ...cars.filter((o) => o.parts_pending).map((o) => ({ o, icon: PackageX, text: 'Esperando peça' })),
    ...cars.filter((o) => o.status === 'awaiting_approval').map((o) => ({ o, icon: Timer, text: 'Esperando o cliente aprovar o orçamento' })),
  ]

  return (
    <div className="space-y-5">
      <DaySummary />
      <div>
        <p className="text-sm text-slate-500">{ws?.name}</p>
        <h1 className="font-heading text-2xl font-extrabold">{greeting()}{name ? `, ${name}` : ''}!</h1>
      </div>

      {/* Ações principais: poucos toques quando o carro chega */}
      <div className="grid grid-cols-2 gap-3">
        {can('orders.create') && <BigAction to="/receber" icon={CarFront} title="Receber carro" sub="Placa, km e fotos" primary />}
        {can('quotes.create') && <BigAction to="/orcamentos/novo" icon={FileText} title="Fazer orçamento" sub="Mandar no WhatsApp" />}
        {can('schedule.create') && !can('quotes.create') && <BigAction to="/agenda?novo=1" icon={CalendarPlus} title="Agendar" sub="Marcar horário" />}
      </div>

      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}

      <CallBack />

      {/* Resumo do dia */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {can('orders.view') && <Mini label="Na oficina" value={cars.length} to="/os" />}
        {can('orders.view') && <Mini label="Prontos p/ entrega" value={ready} tone={ready ? 'green' : undefined} to="/os?f=ready" />}
        {can('quotes.view') && <Mini label="Esperando aprovação" value={d.quotes_awaiting ?? waiting} tone={(d.quotes_awaiting ?? 0) > 0 ? 'amber' : undefined} to="/orcamentos" />}
        {'appointments_today' in d && <Mini label="Agendados hoje" value={d.appointments_today} to="/agenda" />}
        {'received_today_cents' in d && <Mini label="Recebido hoje" value={brl(d.received_today_cents)} to="/financeiro" />}
        {'receivable_overdue_cents' in d && <Mini label="A receber vencido" value={brl(d.receivable_overdue_cents)} tone={d.receivable_overdue_cents > 0 ? 'red' : undefined} to="/financeiro" />}
      </div>

      {d.my_open_timer && (
        <Link to={`/os/${d.my_open_timer.order_id}`} className="flex items-center gap-3 rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-700">
          <Timer className="size-5" />Você está apontando tempo desde {fmtDateTime(d.my_open_timer.started_at, tz)}<ChevronRight className="ml-auto size-4" />
        </Link>
      )}

      {urgent.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-lg font-bold"><AlertTriangle className="size-5 text-amber-700" />Urgências</h2>
          <div className="space-y-2">{urgent.slice(0, 6).map(({ o, icon: I, text }, i) => (
            <Link key={o.id + i} to={`/os/${o.id}`} className="card flex items-center gap-3 p-3 active:bg-slate-50">
              <I className="size-5 shrink-0 text-amber-700" />
              <div className="min-w-0 flex-1"><p className="plate text-base">{fmtPlate(o.plate)} <span className="font-sans text-sm font-normal normal-case tracking-normal text-slate-500">{o.vehicle_label}</span></p>
                <p className="truncate text-sm text-slate-600">{text}</p></div>
              <ChevronRight className="size-4 text-slate-400" />
            </Link>
          ))}</div>
        </section>
      )}

      {can('orders.view') && (
        <section>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Carros na oficina</h2><Link to="/os" className="text-sm font-medium text-brand">Ver todos</Link></div>
          {board.isLoading ? <Loading /> : cars.length ? (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{cars.map((o) => <CarCard key={o.id} o={o} tz={tz} />)}</div>
          ) : (
            <div className="card p-6 text-center text-sm text-slate-500">Nenhum carro na oficina.{can('orders.create') && <> <Link className="font-medium text-brand" to="/receber">Receber um carro</Link></>}</div>
          )}
        </section>
      )}

      {q.isLoading && <Loading />}
    </div>
  )
}

export function CarCard({ o, tz }: { o: any; tz: string }) {
  return (
    <Link to={`/os/${o.id}`} className="card flex items-center gap-3 p-3 active:bg-slate-50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><Plate value={o.plate} /><span className="text-xs text-slate-400">{o.number}</span></div>
        <p className="truncate text-sm text-slate-700">{o.vehicle_label} · {o.client_name}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusBadge map={orderStatus} value={o.status} />
          {o.parts_pending && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">Esperando peça</span>}
          {o.expected_delivery_at && <span className={o.late ? 'text-xs font-semibold text-red-600' : 'text-xs text-slate-500'}>{o.late ? 'Atrasado · ' : 'Entrega '}{fmtDateTime(o.expected_delivery_at, tz)}</span>}
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-slate-400" />
    </Link>
  )
}

function BigAction({ to, icon: I, title, sub, primary }: { to: string; icon: typeof CarFront; title: string; sub: string; primary?: boolean }) {
  return (
    <Link to={to} className={primary
      ? 'flex min-h-28 flex-col justify-between rounded-xl bg-brand p-4 text-white shadow-md shadow-brand/25 active:scale-[0.98]'
      : 'flex min-h-28 flex-col justify-between rounded-xl border border-slate-200 bg-card p-4 active:scale-[0.98]'}>
      <I className={primary ? 'size-7' : 'size-7 text-brand'} aria-hidden />
      <span><span className="block font-heading text-lg font-bold leading-tight">{title}</span><span className={primary ? 'text-sm text-white/80' : 'text-sm text-slate-500'}>{sub}</span></span>
    </Link>
  )
}

function Mini({ label, value, tone, to }: { label: string; value: React.ReactNode; tone?: 'green' | 'amber' | 'red'; to: string }) {
  const c = tone === 'green' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : tone === 'red' ? 'text-red-600' : 'text-ink'
  return (
    <Link to={to} className="card p-3 active:bg-slate-50">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-0.5 font-heading text-xl font-extrabold ${c}`}>{value}</p>
    </Link>
  )
}

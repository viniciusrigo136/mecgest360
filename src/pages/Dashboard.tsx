import { useQuery } from '@tanstack/react-query'
import { CalendarPlus, Car, Plus, Wrench } from 'lucide-react'
import { Link } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Card, ErrorBox, Loading, PageHeader, Stat, StatusBadge } from '@/components/ui'
import { brl, fmtDateTime } from '@/lib/format'
import { orderStatus, techStatus } from '@/lib/labels'
import { rpc } from '@/lib/supabase'

export function Dashboard() {
  const { wsId, can, tz } = useAuth()
  const q = useQuery({ queryKey: ['dashboard', wsId], queryFn: () => rpc<any>('dashboard_summary', { p_workshop: wsId }), refetchInterval: 60_000 })
  const board = useQuery({
    queryKey: ['dash-board', wsId], enabled: can('orders.view'),
    queryFn: () => rpc<any[]>('orders_board', { p_workshop: wsId, p_status: ['open', 'diagnosis', 'awaiting_approval', 'approved', 'in_progress', 'quality_check', 'ready'], p_limit: 12 }),
  })
  const d = q.data ?? {}
  const inShop = Object.values(d.in_shop ?? {}).reduce((a: number, b) => a + Number(b), 0)

  return (
    <div>
      <PageHeader title="Visão geral" subtitle="Indicadores de hoje. Valores financeiros só para perfis autorizados." actions={<>
        {can('orders.create') && <Link to="/os/nova" className="inline-flex h-10 items-center gap-1.5 rounded-md bg-brand px-4 text-sm font-medium text-white"><Plus className="size-4" />Novo atendimento</Link>}
        {can('schedule.create') && <Link to="/agenda?novo=1" className="inline-flex h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium"><CalendarPlus className="size-4" />Agendar</Link>}
        {can('vehicles.view') && <Link to="/veiculos" className="inline-flex h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium"><Car className="size-4" />Localizar veículo</Link>}
      </>} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {'appointments_today' in d && <Stat label="Agendamentos hoje" value={d.appointments_today} hint={`${d.appointments_next_days} nos próximos 7 dias`} />}
            {'in_shop' in d && <Stat label="Veículos na oficina" value={inShop} hint="OS abertas não entregues" />}
            {'late' in d && <Stat label="Serviços atrasados" value={d.late} tone={d.late ? 'red' : undefined} hint="Previsão de entrega vencida" />}
            {'deliveries_today' in d && <Stat label="Entregas previstas hoje" value={d.deliveries_today} />}
            {'quotes_awaiting' in d && <Stat label="Orçamentos aguardando" value={d.quotes_awaiting} tone={d.quotes_awaiting ? 'amber' : undefined} hint="Enviados sem decisão" />}
            {'parts_pending' in d && <Stat label="OS com pendência de peças" value={d.parts_pending} />}
            {'low_stock' in d && <Stat label="Estoque baixo" value={d.low_stock} tone={d.low_stock ? 'amber' : undefined} hint="Disponível ≤ mínimo" />}
            {'contact_tasks_open' in d && <Stat label="Contatos pendentes" value={d.contact_tasks_open} hint="Tarefas vencidas ou de hoje" />}
            {'receivable_overdue_cents' in d && <Stat label="A receber vencido" value={brl(d.receivable_overdue_cents)} tone={d.receivable_overdue_cents > 0 ? 'red' : undefined} hint="Saldo de parcelas vencidas" />}
            {'received_today_cents' in d && <Stat label="Recebido hoje" value={brl(d.received_today_cents)} hint="Pagamentos registrados hoje (líquido de estornos)" />}
            {'payable_due_7d_cents' in d && <Stat label="A pagar em 7 dias" value={brl(d.payable_due_7d_cents)} hint="Inclui vencidas" />}
          </div>
          {'maintenance' in d && (
            <Card title="Retornos preventivos (ciclos abertos)" actions={<Link className="text-sm text-brand" to="/preventiva">Abrir painel</Link>}>
              <div className="flex flex-wrap gap-3">
                {Object.entries(d.maintenance as Record<string, number>).map(([k, n]) => (
                  <div key={k} className="flex items-center gap-2"><StatusBadge map={techStatus} value={k} /><span className="font-semibold">{n}</span></div>
                ))}
                {Object.keys(d.maintenance).length === 0 && <p className="text-sm text-slate-500">Nenhum plano preventivo cadastrado.</p>}
              </div>
            </Card>
          )}
          {d.my_open_timer && <div className="rounded-md bg-violet-50 p-3 text-sm text-violet-800">Você tem um apontamento em andamento desde {fmtDateTime(d.my_open_timer.started_at, tz)}. <Link className="underline" to={`/os/${d.my_open_timer.order_id}`}>Abrir OS</Link></div>}
          {can('orders.view') && (
            <Card title={<span className="inline-flex items-center gap-2"><Wrench className="size-4" />Veículos em atendimento</span>} actions={<Link className="text-sm text-brand" to="/os">Ver todas</Link>}>
              {board.isLoading ? <Loading /> : board.data?.length ? (
                <ul className="divide-y divide-slate-100">
                  {board.data.map((o) => (
                    <li key={o.id}><Link to={`/os/${o.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm hover:bg-slate-50">
                      <span className="font-medium">{o.number}</span><span>{o.plate}</span><span className="text-slate-500">{o.vehicle_label} · {o.client_name}</span>
                      <span className="ml-auto flex gap-2">{o.parts_pending && <span className="text-xs text-amber-700">peças pendentes</span>}{o.late && <span className="text-xs text-red-600">atrasada</span>}<StatusBadge map={orderStatus} value={o.status} /></span>
                    </Link></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-slate-500">Nenhum veículo em atendimento.</p>}
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

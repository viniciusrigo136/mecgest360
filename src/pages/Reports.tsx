import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Button, Card, ErrorBox, Input, Loading, PageHeader, Stat, Table, Tabs, useToast } from '@/components/ui'
import { downloadText, toCSV } from '@/lib/csv'
import { brl, fmtDate, fmtPhone, todayLocal } from '@/lib/format'
import { orderStatus } from '@/lib/labels'
import { rpc } from '@/lib/supabase'

export function ReportsPage() {
  const { wsId, can, tz } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState('operacao')
  const [from, setFrom] = useState(todayLocal(tz, -30))
  const [to, setTo] = useState(todayLocal(tz))
  const [months, setMonths] = useState('6')
  const args = { p_workshop: wsId, p_from: from, p_to: to }
  const ops = useQuery({ queryKey: ['rep-ops', from, to], enabled: tab === 'operacao', queryFn: () => rpc<any>('report_operations', args) })
  const quotes = useQuery({ queryKey: ['rep-quotes', from, to], enabled: tab === 'orcamentos', queryFn: () => rpc<any>('report_quotes', args) })
  const fin = useQuery({ queryKey: ['rep-fin', from, to], enabled: tab === 'financeiro', queryFn: () => rpc<any>('report_financial', args) })
  const maint = useQuery({ queryKey: ['rep-maint', from, to], enabled: tab === 'preventiva', queryFn: () => rpc<any>('report_maintenance', args) })
  const inactive = useQuery({ queryKey: ['rep-inactive', months], enabled: tab === 'inativos', queryFn: () => rpc<any[]>('report_inactive_clients', { p_workshop: wsId, p_months: Number(months) || 6 }) })
  const team = useQuery({ queryKey: ['rep-team', from, to], enabled: tab === 'equipe', queryFn: () => rpc<any[]>('report_team', args) })

  async function exportRows(name: string, rows: any[], cols: { key: string; label: string }[]) {
    try {
      await rpc('log_export', { p_workshop: wsId, p_resource: `report:${name}`, p_filters: { from, to, months }, p_rows: rows.length })
      downloadText(`${name}_${from}_${to}.csv`, toCSV(rows, cols))
    } catch (e) { toast.error(e) }
  }
  const period = <p className="mb-3 text-xs text-slate-500">Período: {fmtDate(from)} a {fmtDate(to)} (datas no fuso da oficina).</p>
  const tabs = [{ key: 'operacao', label: 'Operação' }, { key: 'orcamentos', label: 'Orçamentos' }, ...(can('reports.financial') ? [{ key: 'financeiro', label: 'Financeiro' }] : []),
    { key: 'preventiva', label: 'Retorno preventivo' }, ...(can('clients.view') ? [{ key: 'inativos', label: 'Clientes sem atendimento' }] : []), { key: 'equipe', label: 'Equipe' }]

  return (
    <div>
      <PageHeader title="Relatórios" actions={<div className="flex items-end gap-2"><Input label="De" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input label="Até" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'operacao' && (ops.isLoading ? <Loading /> : ops.error ? <ErrorBox error={ops.error} /> : ops.data && <div className="space-y-3">{period}
        <p className="text-xs text-slate-500">{ops.data.definicao}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="OS abertas no período" value={ops.data.orders_opened} /><Stat label="Entregues" value={ops.data.delivered} /><Stat label="Canceladas" value={ops.data.cancelled} /><Stat label="Atrasadas agora" value={ops.data.late_now} tone={ops.data.late_now ? 'red' : undefined} /></div>
        <Card title="Tempo médio por etapa (horas)"><ul className="grid gap-1 text-sm sm:grid-cols-3">{Object.entries(ops.data.stage_hours ?? {}).map(([k, v]) => <li key={k}>{orderStatus[k]?.[0] ?? k}: <strong>{String(v)}</strong></li>)}</ul>
          <p className="mt-2 text-xs text-slate-500">Entrada até pronta: {ops.data.avg_hours_entry_to_ready ?? '—'} h em média.</p></Card>
        <div className="grid gap-3 md:grid-cols-2">
          <Card title="Serviços mais executados"><ol className="list-decimal pl-5 text-sm">{ops.data.top_services.map((s: any) => <li key={s.description}>{s.description} — {s.n}</li>)}</ol></Card>
          <Card title="Peças mais consumidas"><ol className="list-decimal pl-5 text-sm">{ops.data.top_parts.map((s: any) => <li key={s.name}>{s.name} — {s.qty}</li>)}</ol></Card>
        </div></div>)}
      {tab === 'orcamentos' && (quotes.isLoading ? <Loading /> : quotes.error ? <ErrorBox error={quotes.error} /> : quotes.data && <div>{period}<p className="mb-3 text-xs text-slate-500">{quotes.data.definicao}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Enviados" value={quotes.data.sent} /><Stat label="Aprovados" value={quotes.data.approved} /><Stat label="Parciais" value={quotes.data.partial} /><Stat label="Recusados" value={quotes.data.declined} />
          <Stat label="Expirados" value={quotes.data.expired} /><Stat label="Sem decisão" value={quotes.data.pending} /><Stat label="Conversão" value={quotes.data.conversion_pct === null ? '—' : `${quotes.data.conversion_pct}%`} />
          {quotes.data.approved_total_cents !== null && <Stat label="Valor aprovado" value={brl(quotes.data.approved_total_cents)} hint={`de ${brl(quotes.data.sent_total_cents)} enviados`} />}</div></div>)}
      {tab === 'financeiro' && (fin.isLoading ? <Loading /> : fin.error ? <ErrorBox error={fin.error} /> : fin.data && <div>{period}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Previsto a receber" value={brl(fin.data.previsto_cents)} hint={fin.data.definicoes.previsto} />
          <Stat label="Recebido" value={brl(fin.data.recebido_cents)} hint={fin.data.definicoes.recebido} />
          <Stat label="Vencido (hoje)" value={brl(fin.data.vencido_cents)} tone={fin.data.vencido_cents > 0 ? 'red' : undefined} hint={fin.data.definicoes.vencido} />
          <Stat label="Faturado (OS entregues)" value={brl(fin.data.faturado_cents)} hint={fin.data.definicoes.faturado} />
          <Stat label="Ticket médio" value={brl(fin.data.ticket_medio_cents)} hint={fin.data.definicoes.ticket_medio} />
          <Stat label="Despesas pagas" value={brl(fin.data.despesas_pagas_cents)} />
          <Stat label="A pagar no período" value={brl(fin.data.a_pagar_periodo_cents)} />
          <Stat label="Taxas" value={brl(fin.data.taxas_cents)} />
          {fin.data.margem_gerencial_cents !== null && <Stat label="Margem gerencial" value={brl(fin.data.margem_gerencial_cents)} hint={fin.data.definicoes.margem_gerencial} />}
        </div>
        <Card title="Recebido por forma" className="mt-3"><ul className="text-sm">{Object.entries(fin.data.by_method ?? {}).map(([k, v]) => <li key={k}>{k}: {brl(v as number)}</li>)}</ul></Card></div>)}
      {tab === 'preventiva' && (maint.isLoading ? <Loading /> : maint.error ? <ErrorBox error={maint.error} /> : maint.data && <div>{period}<p className="mb-3 text-xs text-slate-500">{maint.data.definicao}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label="Ciclos com alvo no período" value={maint.data.eligible} /><Stat label="Contatados" value={maint.data.contacted} /><Stat label="Agendaram" value={maint.data.scheduled} />
          <Stat label="Concluídos aqui" value={maint.data.completed_here} /><Stat label="Concluídos após contato" value={maint.data.completed_after_contact} /><Stat label="Feitos em outra oficina" value={maint.data.completed_elsewhere} />
          <Stat label="Recusaram" value={maint.data.refused} /><Stat label="Sem consentimento" value={maint.data.no_consent} /></div></div>)}
      {tab === 'inativos' && <Card title="Clientes sem atendimento" actions={<div className="flex items-end gap-2"><Input label="Há mais de (meses)" value={months} onChange={(e) => setMonths(e.target.value)} className="w-32" />
        {can('reports.export') && inactive.data && <Button size="sm" variant="secondary" onClick={() => exportRows('clientes_inativos', inactive.data!, [{ key: 'name', label: 'Nome' }, { key: 'phone', label: 'Telefone' }, { key: 'last_visit', label: 'Última visita' }, { key: 'vehicles', label: 'Veículos' }])}>CSV</Button>}</div>}>
        <p className="mb-2 text-xs text-slate-500">Lista para análise. Não gera campanhas automaticamente.</p>
        {inactive.isLoading ? <Loading /> : <Table head={['Cliente', 'Telefone', 'Última visita', 'Veículos']} empty={!inactive.data?.length}>
          {inactive.data?.map((r) => <tr key={r.client_id}><td className="td"><Link className="text-brand" to={`/clientes/${r.client_id}`}>{r.name}</Link></td><td className="td">{fmtPhone(r.phone)}</td><td className="td">{fmtDate(r.last_visit)}</td><td className="td">{r.vehicles}</td></tr>)}
        </Table>}</Card>}
      {tab === 'equipe' && <Card title="Produção da equipe" actions={can('reports.export') && team.data && <Button size="sm" variant="secondary" onClick={() => exportRows('equipe', team.data!, [{ key: 'name', label: 'Funcionário' }, { key: 'hours', label: 'Horas apontadas' }, { key: 'orders', label: 'OS' }, { key: 'items_done', label: 'Itens executados' }])}>CSV</Button>}>
        <p className="mb-2 text-xs text-slate-500">Tempo apontado isolado não é avaliação de desempenho.</p>
        {team.isLoading ? <Loading /> : <Table head={['Funcionário', 'Horas apontadas', 'OS com apontamento', 'Itens executados']}>{team.data?.map((r) => <tr key={r.membership_id}><td className="td">{r.name}</td><td className="td">{r.hours}</td><td className="td">{r.orders}</td><td className="td">{r.items_done}</td></tr>)}</Table>}</Card>}
    </div>
  )
}

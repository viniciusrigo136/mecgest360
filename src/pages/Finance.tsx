import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDown, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Badge, Button, ErrorBox, Input, Loading, Modal, MoneyInput, PageHeader, Select, Stat, Table, Tabs, Textarea, useToast } from '@/components/ui'
import { brl, fmtDate, fmtDateTime, todayLocal } from '@/lib/format'
import { paymentMethodLabel } from '@/lib/labels'
import { loadWorkshopDoc } from '@/lib/workshop'
import { rpc, supabase } from '@/lib/supabase'

export function FinancePage() {
  const { can } = useAuth()
  const [params] = useSearchParams()
  const [tab, setTab] = useState('receber')
  return (
    <div>
      <PageHeader title="Financeiro" subtitle="Previsto, recebido e vencido são mostrados separadamente. Pix registrado manualmente não é confirmação bancária." />
      <Tabs value={tab} onChange={setTab} tabs={[...(can('finance.view') ? [{ key: 'receber', label: 'A receber' }, { key: 'pagar', label: 'A pagar' }] : [])]} />
      {tab === 'receber' && <Accounts kind="receivable" focus={params.get('conta')} />}
      {tab === 'pagar' && <Accounts kind="payable" />}
    </div>
  )
}

function Accounts({ kind, focus }: { kind: 'receivable' | 'payable'; focus?: string | null }) {
  const { wsId, can, tz } = useAuth()
  const [status, setStatus] = useState('open')
  const [pay, setPay] = useState<any>(null)
  const [create, setCreate] = useState(false)
  const [receipt, setReceipt] = useState<any>(null)
  const today = todayLocal(tz)
  const q = useQuery({ queryKey: ['accounts', wsId, kind, status], queryFn: async () => {
    let s = supabase.from('accounts').select('*, clients(name), suppliers(name), service_orders(number), account_installments(*, account_payments(*))').eq('workshop_id', wsId).eq('kind', kind).order('created_at', { ascending: false }).limit(200)
    if (status) s = s.eq('status', status)
    if (focus) s = s.eq('id', focus)
    const { data, error } = await s
    if (error) throw error
    return data ?? []
  } })
  const sums = (q.data ?? []).reduce((acc, a) => {
    for (const i of a.account_installments) { const bal = Number(i.amount_cents) - Number(i.paid_cents); acc.open += bal; if (i.due_date < today) acc.overdue += bal }
    return acc
  }, { open: 0, overdue: 0 })
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={kind === 'receivable' ? 'Saldo a receber (lista)' : 'Saldo a pagar (lista)'} value={brl(sums.open)} />
        <Stat label="Vencido" value={brl(sums.overdue)} tone={sums.overdue ? 'red' : undefined} hint="Parcelas com vencimento antes de hoje" />
      </div>
      <div className="card">
        <div className="flex flex-wrap items-end justify-between gap-3 p-3">
          <div className="w-48"><Select label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Em aberto</option><option value="paid">Quitadas</option><option value="cancelled">Canceladas</option><option value="">Todas</option></Select></div>
          {can('finance.edit') && <Button onClick={() => setCreate(true)}><Plus className="size-4" />{kind === 'receivable' ? 'Conta a receber avulsa' : 'Conta a pagar'}</Button>}
        </div>
        {q.error ? <div className="p-3"><ErrorBox error={q.error} /></div> : q.isLoading ? <Loading /> : (
          <Table head={['Descrição', kind === 'receivable' ? 'Cliente' : 'Fornecedor', 'Parcelas', 'Total', '']} empty={!q.data?.length}>
            {q.data?.map((a: any) => (
              <tr key={a.id} className="align-top">
                <td className="td">{a.description}{a.service_orders && <Link className="block text-xs text-brand" to={`/os/${a.order_id}`}>OS {a.service_orders.number}</Link>}<span className="block text-xs text-slate-500">{a.category}{a.cost_type && ` · ${a.cost_type}`}</span></td>
                <td className="td">{a.clients?.name ?? a.suppliers?.name ?? '—'}</td>
                <td className="td"><ul className="space-y-1">{a.account_installments.sort((x: any, y: any) => x.seq - y.seq).map((i: any) => {
                  const bal = Number(i.amount_cents) - Number(i.paid_cents)
                  return (
                    <li key={i.id} className="text-xs">
                      <span className={bal > 0 && i.due_date < today ? 'font-medium text-red-600' : ''}>{i.seq}ª {fmtDate(i.due_date)} · {brl(i.amount_cents)}</span>
                      {Number(i.paid_cents) > 0 && <span className="text-emerald-700"> · pago {brl(i.paid_cents)}</span>}
                      {bal > 0 && a.status === 'open' && (kind === 'receivable' ? can('payments.receive') : can('finance.edit')) && <button className="ml-1 text-brand" onClick={() => setPay({ inst: i, account: a })}>{kind === 'receivable' ? 'receber' : 'pagar'}</button>}
                      {i.account_payments?.map((p: any) => (
                        <div key={p.id} className="ml-3 text-slate-500">{fmtDateTime(p.paid_at, tz)} {paymentMethodLabel[p.method] ?? p.method} {brl(p.amount_cents)}{p.reversed_at && <Badge tone="red">estornado</Badge>}{p.reverses_payment_id && <Badge tone="red">estorno</Badge>}{p.reference && ` · ref ${p.reference}`}
                          {!p.reverses_payment_id && !p.reversed_at && can('payments.refund') && <ReverseButton id={p.id} />}
                          {kind === 'receivable' && p.receipt_number && !p.reverses_payment_id && <button className="ml-1 text-brand" onClick={() => setReceipt({ p, a, i })}>recibo</button>}
                        </div>
                      ))}
                    </li>
                  )
                })}</ul></td>
                <td className="td">{brl(a.total_cents)}<br />{a.status === 'paid' ? <Badge tone="green">Quitada</Badge> : a.status === 'cancelled' ? <Badge>Cancelada</Badge> : <Badge tone="amber">Em aberto</Badge>}</td>
                <td className="td">{a.status === 'open' && can('finance.edit') && <CancelAccount id={a.id} />}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <PaymentModal ctx={pay} onClose={() => setPay(null)} />
      <AccountModal open={create} kind={kind} onClose={() => setCreate(false)} />
      <ReceiptModal ctx={receipt} onClose={() => setReceipt(null)} />
    </div>
  )
}

function ReverseButton({ id }: { id: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  return <button className="ml-1 text-red-600" onClick={async () => { const r = prompt('Motivo do estorno (o pagamento original é preservado):'); if (!r) return; try { await rpc('reverse_payment', { p_payment: id, p_reason: r }); toast.success('Estorno registrado'); qc.invalidateQueries() } catch (e) { toast.error(e) } }}>estornar</button>
}
function CancelAccount({ id }: { id: string }) {
  const toast = useToast()
  const qc = useQueryClient()
  return <Button size="sm" variant="ghost" onClick={async () => { const r = prompt('Motivo do cancelamento:'); if (!r) return; try { await rpc('cancel_account', { p_account: id, p_reason: r }); qc.invalidateQueries({ queryKey: ['accounts'] }) } catch (e) { toast.error(e) } }}>Cancelar</Button>
}

function PaymentModal({ ctx, onClose }: { ctx: any; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [amount, setAmount] = useState<number | null>(null)
  const [f, setF] = useState({ method: 'pix', fee: 0 as number | null, reference: '', notes: '' })
  const [idem, setIdem] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const bal = ctx ? Number(ctx.inst.amount_cents) - Number(ctx.inst.paid_cents) : 0
  async function save() {
    if (busy) return
    setBusy(true)
    try {
      await rpc('register_payment', { p_installment: ctx.inst.id, p_amount_cents: amount ?? bal, p_method: f.method, p_idem: idem, p_fee_cents: f.fee ?? 0, p_reference: f.reference || null, p_notes: f.notes || null })
      toast.success('Pagamento registrado'); qc.invalidateQueries(); setIdem(crypto.randomUUID()); setAmount(null); onClose()
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={!!ctx} onClose={onClose} title={ctx?.account.kind === 'receivable' ? 'Receber pagamento' : 'Registrar pagamento'} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} onClick={save}>Confirmar</Button></>}>
      <p className="mb-3 text-sm">Saldo da parcela: <strong>{brl(bal)}</strong></p>
      <div className="grid gap-3 sm:grid-cols-2">
        <MoneyInput label="Valor" cents={amount ?? bal} onCents={setAmount} />
        <Select label="Forma" value={f.method} onChange={(e) => setF((s) => ({ ...s, method: e.target.value }))}>{Object.entries(paymentMethodLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <MoneyInput label="Taxa (cartão etc.)" cents={f.fee} onCents={(c) => setF((s) => ({ ...s, fee: c }))} />
        <Input label="Referência (ex.: ID do Pix)" value={f.reference} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} />
        <Textarea className="sm:col-span-2" label="Observações" value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} />
      </div>
      <p className="mt-2 text-xs text-slate-500">Dados de cartão nunca são armazenados. Dinheiro exige caixa aberto.</p>
    </Modal>
  )
}

function AccountModal({ open, kind, onClose }: { open: boolean; kind: string; onClose: () => void }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ description: '', category: kind === 'payable' ? 'despesas' : 'servicos', cost_type: 'fixa', due: todayLocal(), amount: null as number | null, n: '1' })
  async function save() {
    const n = Math.max(1, Number(f.n) || 1), total = f.amount ?? 0, base = Math.floor(total / n)
    const inst = Array.from({ length: n }, (_, i) => { const d = new Date(`${f.due}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i); return { due_date: d.toISOString().slice(0, 10), amount_cents: i === n - 1 ? total - base * (n - 1) : base } })
    try { await rpc('create_account', { p_workshop: wsId, p_kind: kind, p_description: f.description, p_category: f.category, p_installments: inst, p_cost_type: kind === 'payable' ? f.cost_type : null }); qc.invalidateQueries({ queryKey: ['accounts'] }); onClose() } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={open} onClose={onClose} title={kind === 'payable' ? 'Nova conta a pagar' : 'Nova conta a receber'} footer={<Button disabled={!f.description || !f.amount} onClick={save}>Salvar</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input className="sm:col-span-2" label="Descrição" value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} />
        <Input label="Categoria" value={f.category} onChange={(e) => setF((s) => ({ ...s, category: e.target.value }))} />
        {kind === 'payable' && <Select label="Tipo de despesa" value={f.cost_type} onChange={(e) => setF((s) => ({ ...s, cost_type: e.target.value }))}><option value="fixa">Fixa</option><option value="variavel">Variável</option></Select>}
        <MoneyInput label="Valor total" cents={f.amount} onCents={(c) => setF((s) => ({ ...s, amount: c }))} />
        <Input label="1º vencimento" type="date" value={f.due} onChange={(e) => setF((s) => ({ ...s, due: e.target.value }))} />
        <Input label="Parcelas" inputMode="numeric" value={f.n} onChange={(e) => setF((s) => ({ ...s, n: e.target.value }))} />
      </div>
    </Modal>
  )
}

function ReceiptModal({ ctx, onClose }: { ctx: any; onClose: () => void }) {
  const { ws, tz, wsId } = useAuth()
  const toast = useToast()
  async function pdf() {
    try {
      const [workshop, { buildPdf, sharePdf }] = await Promise.all([loadWorkshopDoc(wsId), import('@/lib/pdf')])
      const blob = await buildPdf({ kind: 'RECIBO', number: ctx.p.receipt_number, date: ctx.p.paid_at, workshop, client: { name: ctx.a.clients?.name ?? '—' },
        items: [{ description: `${ctx.a.description} — parcela ${ctx.i.seq} (${paymentMethodLabel[ctx.p.method] ?? ctx.p.method})`, quantity: 1, unit_cents: Number(ctx.p.amount_cents), total_cents: Number(ctx.p.amount_cents) }],
        total_cents: Number(ctx.p.amount_cents), notes: [`Recebemos de ${ctx.a.clients?.name ?? '—'} a quantia acima em ${fmtDateTime(ctx.p.paid_at, tz)}.`] })
      await sharePdf(blob, `Recibo-${ctx.p.receipt_number}.pdf`)
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={!!ctx} onClose={onClose} title="Recibo" footer={<Button onClick={pdf}><FileDown className="size-4" />Baixar PDF</Button>}>
      {ctx && <div className="space-y-2 text-sm print:text-base">
        <p className="text-lg font-semibold">{ws?.name}</p>
        <p className="font-semibold">RECIBO Nº {ctx.p.receipt_number} — documento não fiscal</p>
        <p>Recebemos de <strong>{ctx.a.clients?.name ?? '—'}</strong> a quantia de <strong>{brl(ctx.p.amount_cents)}</strong>, referente a {ctx.a.description} (parcela {ctx.i.seq}), em {fmtDateTime(ctx.p.paid_at, tz)}, via {paymentMethodLabel[ctx.p.method] ?? ctx.p.method}.</p>
        <p className="text-xs text-slate-500">Este recibo não substitui nota fiscal. Emissão fiscal não está integrada a este sistema.</p>
      </div>}
    </Modal>
  )
}


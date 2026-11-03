import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Badge, Button, Card, ErrorBox, Input, Loading, Modal, MoneyInput, PageHeader, Select, Table, Tabs, Textarea, useToast } from '@/components/ui'
import { brl, fmtDate, fmtPhone, fmtQty } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'

const poStatus: Record<string, [string, 'gray' | 'blue' | 'amber' | 'green' | 'red']> = { draft: ['Rascunho', 'gray'], sent: ['Pedido enviado', 'blue'], partial: ['Recebido parcialmente', 'amber'], received: ['Recebido', 'green'], cancelled: ['Cancelado', 'red'] }

export function PurchasingPage() {
  const { wsId, can } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [tab, setTab] = useState('pedidos')
  const [newPo, setNewPo] = useState(false)
  const [receive, setReceive] = useState<any>(null)
  const [supplier, setSupplier] = useState<any>(null)
  const suppliers = useQuery({ queryKey: ['suppliers', wsId], queryFn: async () => (await supabase.from('suppliers').select('*').eq('workshop_id', wsId).is('archived_at', null).order('name')).data ?? [] })
  const pos = useQuery({ queryKey: ['purchases', wsId], queryFn: async () => {
    const { data, error } = await supabase.from('purchase_orders').select('*, suppliers(name)').eq('workshop_id', wsId).order('created_at', { ascending: false }).limit(100)
    if (error) throw error
    return data ?? []
  } })
  return (
    <div>
      <PageHeader title="Compras e fornecedores" actions={can('purchasing.edit') && <>{tab === 'pedidos' ? <Button onClick={() => setNewPo(true)}><Plus className="size-4" />Pedido de compra</Button> : <Button onClick={() => setSupplier({})}><Plus className="size-4" />Fornecedor</Button>}</>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'pedidos', label: 'Pedidos' }, { key: 'fornecedores', label: 'Fornecedores' }]} />
      {tab === 'pedidos' && (pos.error ? <ErrorBox error={pos.error} /> : pos.isLoading ? <Loading /> : (
        <div className="card"><Table head={['Número', 'Fornecedor', 'Previsão', 'Situação', '']} empty={!pos.data?.length}>
          {pos.data?.map((p: any) => <tr key={p.id}><td className="td font-medium">{p.number}</td><td className="td">{p.suppliers?.name}</td><td className="td">{fmtDate(p.expected_on)}</td>
            <td className="td"><Badge tone={poStatus[p.status][1]}>{poStatus[p.status][0]}</Badge>{p.cancel_reason && <span className="block text-xs text-slate-500">{p.cancel_reason}</span>}</td>
            <td className="td"><div className="flex justify-end gap-1">
              {['sent', 'partial'].includes(p.status) && can('purchasing.receive') && <Button size="sm" onClick={() => setReceive(p)}>Receber</Button>}
              {['draft', 'sent', 'partial'].includes(p.status) && can('purchasing.edit') && <Button size="sm" variant="ghost" onClick={async () => { const r = prompt('Motivo do cancelamento (recebimentos já feitos são mantidos):'); if (r) { try { await rpc('cancel_purchase', { p_purchase: p.id, p_reason: r }); qc.invalidateQueries({ queryKey: ['purchases'] }) } catch (e) { toast.error(e) } } }}>Cancelar</Button>}
            </div></td></tr>)}
        </Table></div>
      ))}
      {tab === 'fornecedores' && <div className="card"><Table head={['Nome', 'Documento', 'Telefone', 'E-mail', 'Condições', '']} empty={!suppliers.data?.length}>
        {suppliers.data?.map((s: any) => <tr key={s.id}><td className="td font-medium">{s.name}</td><td className="td">{s.document}</td><td className="td">{fmtPhone(s.phone)}</td><td className="td">{s.email}</td><td className="td">{s.payment_terms}</td>
          <td className="td">{can('purchasing.edit') && <Button size="sm" variant="ghost" onClick={() => setSupplier(s)}>Editar</Button>}</td></tr>)}
      </Table></div>}
      <NewPurchaseModal open={newPo} onClose={() => setNewPo(false)} suppliers={suppliers.data ?? []} />
      <ReceiveModal po={receive} onClose={() => setReceive(null)} />
      <SupplierModal s={supplier} onClose={() => setSupplier(null)} />
    </div>
  )
}

function SupplierModal({ s, onClose }: { s: any; onClose: () => void }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState<any>({})
  const cur = { name: '', document: '', phone: '', email: '', payment_terms: '', notes: '', ...s, ...f }
  const set = (k: string) => (e: { target: { value: string } }) => setF((x: any) => ({ ...x, [k]: e.target.value }))
  async function save() {
    const row = { workshop_id: wsId, name: cur.name, document: cur.document || null, phone: cur.phone || null, email: cur.email || null, payment_terms: cur.payment_terms || null, notes: cur.notes || null }
    const r = s?.id ? await supabase.from('suppliers').update(row).eq('id', s.id) : await supabase.from('suppliers').insert(row)
    if (r.error) return toast.error(r.error)
    qc.invalidateQueries({ queryKey: ['suppliers'] }); setF({}); onClose()
  }
  return (
    <Modal open={!!s} onClose={() => { setF({}); onClose() }} title={s?.id ? 'Editar fornecedor' : 'Novo fornecedor'} footer={<Button disabled={!cur.name} onClick={save}>Salvar</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input className="sm:col-span-2" label="Nome *" value={cur.name} onChange={set('name')} /><Input label="CNPJ/CPF" value={cur.document ?? ''} onChange={set('document')} />
        <Input label="Telefone" value={cur.phone ?? ''} onChange={set('phone')} /><Input label="E-mail" value={cur.email ?? ''} onChange={set('email')} />
        <Input label="Condições de pagamento" value={cur.payment_terms ?? ''} onChange={set('payment_terms')} />
        <Textarea className="sm:col-span-2" label="Observações" value={cur.notes ?? ''} onChange={set('notes')} />
      </div>
    </Modal>
  )
}

function NewPurchaseModal({ open, onClose, suppliers }: { open: boolean; onClose: () => void; suppliers: any[] }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [sup, setSup] = useState('')
  const [expected, setExpected] = useState('')
  const [items, setItems] = useState<{ product_id: string; description: string; quantity: string; unit_cost_cents: number | null }[]>([])
  const [pq, setPq] = useState('')
  const prods = useQuery({ queryKey: ['po-prod', pq], enabled: pq.length >= 2, queryFn: () => rpc<any[]>('product_list', { p_workshop: wsId, p_q: pq, p_limit: 8 }) })
  async function save() {
    try {
      await rpc('save_purchase', { p_workshop: wsId, p_supplier: sup, p_expected: expected || null, p_notes: null,
        p_items: items.map((i) => ({ product_id: i.product_id, description: i.description, quantity: Number(i.quantity.replace(',', '.')), unit_cost_cents: i.unit_cost_cents ?? 0 })) })
      toast.success('Pedido criado. A entrada no estoque ocorre só no recebimento.'); qc.invalidateQueries({ queryKey: ['purchases'] }); setItems([]); onClose()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Pedido de compra" wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!sup || !items.length} onClick={save}>Criar pedido</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Fornecedor" value={sup} onChange={(e) => setSup(e.target.value)}><option value="">Selecione</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Input label="Previsão de entrega" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
        <div className="sm:col-span-2"><Input label="Adicionar peça" value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Buscar no cadastro de peças" />
          <ul>{prods.data?.map((p) => <li key={p.id}><button className="w-full px-2 py-1 text-left text-sm hover:bg-slate-50" onClick={() => { setItems((s) => [...s, { product_id: p.id, description: p.name, quantity: '1', unit_cost_cents: p.avg_cost_cents ? Number(p.avg_cost_cents) : null }]); setPq('') }}>{p.sku} · {p.name}</button></li>)}</ul></div>
      </div>
      <ul className="mt-3 space-y-2">{items.map((i, idx) => (
        <li key={idx} className="grid items-end gap-2 sm:grid-cols-[1fr_6rem_9rem_auto]"><span className="pb-2 text-sm">{i.description}</span>
          <Input label="Qtd" value={i.quantity} onChange={(e) => setItems((s) => s.map((x, j) => j === idx ? { ...x, quantity: e.target.value } : x))} />
          <MoneyInput label="Custo unit." cents={i.unit_cost_cents} onCents={(c) => setItems((s) => s.map((x, j) => j === idx ? { ...x, unit_cost_cents: c } : x))} />
          <button className="pb-2 text-slate-400 hover:text-red-600" aria-label="Remover" onClick={() => setItems((s) => s.filter((_, j) => j !== idx))}><Trash2 className="size-4" /></button></li>
      ))}</ul>
    </Modal>
  )
}

function ReceiveModal({ po, onClose }: { po: any; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [qty, setQty] = useState<Record<string, string>>({})
  const [f, setF] = useState({ invoice: '', due: '', installments: '1' })
  const [idem] = useState(() => crypto.randomUUID())
  const items = useQuery({ queryKey: ['po-items', po?.id], enabled: !!po, queryFn: async () => (await supabase.from('purchase_order_items').select('*').eq('purchase_id', po.id)).data ?? [] })
  async function save() {
    try {
      await rpc('receive_purchase', { p_purchase: po.id, p_items: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ po_item_id: id, quantity: Number(v.replace(',', '.')) })),
        p_invoice: f.invoice || null, p_due_date: f.due || null, p_idem: idem, p_installments: Number(f.installments) || 1 })
      toast.success('Recebimento registrado: estoque atualizado e conta a pagar gerada'); qc.invalidateQueries(); setQty({}); onClose()
    } catch (e) { toast.error(e) }
  }
  return (
    <Modal open={!!po} onClose={onClose} title={`Receber ${po?.number ?? ''}`} wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={save}>Registrar recebimento</Button></>}>
      {items.isLoading ? <Loading /> : <table className="w-full text-sm"><thead><tr><th className="th">Item</th><th className="th">Pedido</th><th className="th">Já recebido</th><th className="th">Recebendo agora</th></tr></thead><tbody>
        {items.data?.map((i: any) => <tr key={i.id}><td className="td">{i.description}<span className="block text-xs text-slate-500">{brl(i.unit_cost_cents)} un.</span></td><td className="td">{fmtQty(i.quantity)}</td><td className="td">{fmtQty(i.received_qty)}</td>
          <td className="td"><input className="input h-8 w-24 py-0" inputMode="decimal" aria-label={`Receber ${i.description}`} value={qty[i.id] ?? ''} onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value }))} /></td></tr>)}
      </tbody></table>}
      <Card title="Nota e pagamento" className="mt-3"><div className="grid gap-3 sm:grid-cols-3">
        <Input label="Nº da nota / referência" value={f.invoice} onChange={(e) => setF((s) => ({ ...s, invoice: e.target.value }))} />
        <Input label="1º vencimento" type="date" value={f.due} onChange={(e) => setF((s) => ({ ...s, due: e.target.value }))} />
        <Input label="Parcelas" inputMode="numeric" value={f.installments} onChange={(e) => setF((s) => ({ ...s, installments: e.target.value }))} />
      </div></Card>
    </Modal>
  )
}

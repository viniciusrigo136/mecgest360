import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Badge, Button, Card, Checkbox, ErrorBox, Input, Loading, Modal, MoneyInput, PageHeader, Pager, Select, Table, Tabs, useToast } from '@/components/ui'
import { brl, fmtDateTime, fmtQty } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'

const PAGE = 30
const movLabel: Record<string, string> = { purchase_receipt: 'Recebimento de compra', adjustment_in: 'Ajuste (entrada)', adjustment_out: 'Ajuste (saída)', return_in: 'Devolução de OS',
  consumption: 'Consumo em OS', sale: 'Venda avulsa', loss: 'Perda', reversal: 'Estorno', inventory: 'Inventário' }

export function InventoryPage() {
  const { wsId, can, tz } = useAuth()
  const [tab, setTab] = useState('produtos')
  const [q, setQ] = useState('')
  const [low, setLow] = useState(false)
  const [page, setPage] = useState(0)
  const [edit, setEdit] = useState<any>(null)
  const [adjust, setAdjust] = useState<any>(null)
  const list = useQuery({ queryKey: ['products', wsId, q, low, page], queryFn: () => rpc<any[]>('product_list', { p_workshop: wsId, p_q: q || null, p_low_only: low, p_limit: PAGE, p_offset: page * PAGE }) })
  const moves = useQuery({ queryKey: ['stock-moves', wsId], enabled: tab === 'mov' && can('costs.view'), queryFn: async () => {
    const { data, error } = await supabase.from('stock_movements').select('*, products(name, sku, unit)').eq('workshop_id', wsId).order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    return data ?? []
  } })
  return (
    <div>
      <PageHeader title="Estoque" actions={can('inventory.edit') && <Button onClick={() => setEdit({})}><Plus className="size-4" />Nova peça</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'produtos', label: 'Peças e produtos' }, ...(can('costs.view') ? [{ key: 'mov', label: 'Movimentações' }] : [])]} />
      {tab === 'produtos' && <div className="card">
        <div className="grid gap-3 p-3 sm:grid-cols-3"><Input label="Buscar" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Nome, código interno, fabricante ou código de barras" />
          <div className="flex items-end pb-2"><Checkbox label="Somente estoque baixo" checked={low} onChange={(v) => { setLow(v); setPage(0) }} /></div></div>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : list.isLoading ? <Loading /> : <>
          <Table head={['Código', 'Descrição', 'Local', 'Físico', 'Reservado', 'Disponível', 'Mínimo', 'Venda', ...(can('costs.view') ? ['Custo médio'] : []), '']} empty={!list.data?.length}>
            {list.data?.map((p) => (
              <tr key={p.id}>
                <td className="td font-mono text-xs">{p.sku}</td><td className="td">{p.name}<span className="block text-xs text-slate-500">{p.category} {p.manufacturer_code}</span></td><td className="td">{p.location}</td>
                <td className="td">{fmtQty(p.on_hand, p.qty_decimals)} {p.unit}</td><td className="td">{fmtQty(p.reserved, p.qty_decimals)}</td>
                <td className="td font-medium">{fmtQty(p.available, p.qty_decimals)} {p.low && <Badge tone="amber">baixo</Badge>}{Number(p.on_hand) < 0 && <Badge tone="red">negativo</Badge>}</td>
                <td className="td">{fmtQty(p.min_stock, p.qty_decimals)}</td><td className="td">{brl(p.sale_price_cents)}</td>
                {can('costs.view') && <td className="td">{brl(p.avg_cost_cents)}</td>}
                <td className="td"><div className="flex gap-1">{can('inventory.edit') && <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Editar</Button>}
                  {can('inventory.adjust') && <Button size="sm" variant="secondary" onClick={() => setAdjust(p)}>Ajustar</Button>}</div></td>
              </tr>
            ))}
          </Table>
          <Pager page={page} pageSize={PAGE} total={Number(list.data?.[0]?.total_count ?? 0)} onPage={setPage} />
        </>}
      </div>}
      {tab === 'mov' && <Card title="Últimas movimentações">{moves.isLoading ? <Loading /> : (
        <Table head={['Data', 'Peça', 'Tipo', 'Qtd', 'Saldo após', 'Custo unit.', 'Motivo']} empty={!moves.data?.length}>
          {moves.data?.map((m: any) => <tr key={m.id}><td className="td whitespace-nowrap">{fmtDateTime(m.created_at, tz)}</td><td className="td">{m.products?.sku} {m.products?.name}</td><td className="td">{movLabel[m.kind]}</td>
            <td className={`td ${Number(m.quantity) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtQty(m.quantity)}</td><td className="td">{fmtQty(m.balance_after)}</td><td className="td">{brl(m.unit_cost_cents)}</td>
            <td className="td text-xs">{m.reason}{m.negative_override_reason && <span className="block text-red-600">Saldo negativo autorizado: {m.negative_override_reason}</span>}</td></tr>)}
        </Table>)}</Card>}
      <ProductModal p={edit} onClose={() => setEdit(null)} />
      <AdjustModal p={adjust} onClose={() => setAdjust(null)} />
    </div>
  )
}

function ProductModal({ p, onClose }: { p: any; onClose: () => void }) {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState<any>({})
  const open = !!p
  const cur = { sku: '', name: '', category: '', unit: 'un', qty_decimals: 0, location: '', min_stock: 0, sale_price_cents: 0, manufacturer_code: '', barcode: '', ...p, ...f }
  const set = (k: string) => (e: { target: { value: string } }) => setF((s: any) => ({ ...s, [k]: e.target.value }))
  async function save() {
    const row = { workshop_id: wsId, sku: cur.sku, name: cur.name, category: cur.category || null, unit: cur.unit, qty_decimals: Number(cur.qty_decimals), location: cur.location || null,
      min_stock: Number(String(cur.min_stock).replace(',', '.')), sale_price_cents: Number(cur.sale_price_cents), manufacturer_code: cur.manufacturer_code || null, barcode: cur.barcode || null }
    const r = p?.id ? await supabase.from('products').update(row).eq('id', p.id) : await supabase.from('products').insert(row)
    if (r.error) return toast.error(r.error)
    toast.success('Peça salva'); qc.invalidateQueries({ queryKey: ['products'] }); setF({}); onClose()
  }
  return (
    <Modal open={open} onClose={() => { setF({}); onClose() }} title={p?.id ? 'Editar peça' : 'Nova peça'} wide footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!cur.sku || !cur.name} onClick={save}>Salvar</Button></>}>
      <p className="mb-3 text-xs text-slate-500">O saldo não é editável aqui: entradas ocorrem por recebimento de compra, ajuste ou inventário.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Código interno *" value={cur.sku} onChange={set('sku')} /><Input className="sm:col-span-2" label="Descrição *" value={cur.name} onChange={set('name')} />
        <Input label="Código do fabricante" value={cur.manufacturer_code ?? ''} onChange={set('manufacturer_code')} /><Input label="Código de barras" value={cur.barcode ?? ''} onChange={set('barcode')} />
        <Input label="Categoria" value={cur.category ?? ''} onChange={set('category')} />
        <Select label="Unidade" value={cur.unit} onChange={set('unit')}>{['un', 'l', 'ml', 'kg', 'g', 'm', 'cj', 'par'].map((u) => <option key={u}>{u}</option>)}</Select>
        <Select label="Casas decimais" value={cur.qty_decimals} onChange={set('qty_decimals')}><option value={0}>0 (inteiro)</option><option value={1}>1</option><option value={2}>2</option><option value={3}>3 (ex.: litros)</option></Select>
        <Input label="Localização" value={cur.location ?? ''} onChange={set('location')} />
        <Input label="Estoque mínimo" inputMode="decimal" value={String(cur.min_stock)} onChange={set('min_stock')} />
        <MoneyInput label="Preço de venda" cents={Number(cur.sale_price_cents)} onCents={(c) => setF((s: any) => ({ ...s, sale_price_cents: c ?? 0 }))} />
      </div>
    </Modal>
  )
}

function AdjustModal({ p, onClose }: { p: any; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { can } = useAuth()
  const [f, setF] = useState({ kind: 'adjustment_in', qty: '', reason: '', cost: null as number | null, neg: '' })
  const [needNeg, setNeedNeg] = useState(false)
  async function save() {
    const q = Number(f.qty.replace(',', '.'))
    try {
      await rpc('adjust_stock', { p_product: p.id, p_qty_delta: f.kind === 'adjustment_in' ? q : -q, p_kind: f.kind, p_reason: f.reason, p_idem: crypto.randomUUID(), p_unit_cost: f.cost, p_negative_reason: f.neg || null })
      toast.success('Movimentação registrada'); qc.invalidateQueries({ queryKey: ['products'] }); setF({ kind: 'adjustment_in', qty: '', reason: '', cost: null, neg: '' }); setNeedNeg(false); onClose()
    } catch (e: any) { if (e?.code === 'P0011' && can('inventory.negative')) setNeedNeg(true); toast.error(e) }
  }
  return (
    <Modal open={!!p} onClose={onClose} title={`Movimentar: ${p?.name ?? ''}`} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button disabled={!f.qty || !f.reason} onClick={save}>Registrar</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Tipo" value={f.kind} onChange={(e) => setF((s) => ({ ...s, kind: e.target.value }))}><option value="adjustment_in">Ajuste de entrada</option><option value="adjustment_out">Ajuste de saída</option><option value="sale">Venda avulsa</option><option value="loss">Perda / avaria</option></Select>
        <Input label={`Quantidade (${p?.unit ?? ''})`} inputMode="decimal" value={f.qty} onChange={(e) => setF((s) => ({ ...s, qty: e.target.value }))} />
        <Input className="sm:col-span-2" label="Motivo *" value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} />
        {needNeg && <Input className="sm:col-span-2" label="Justificativa para saldo negativo (exceção)" value={f.neg} onChange={(e) => setF((s) => ({ ...s, neg: e.target.value }))} />}
      </div>
    </Modal>
  )
}

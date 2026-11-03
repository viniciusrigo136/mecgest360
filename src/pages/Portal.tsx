import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Checkbox, ErrorBox, Input, Loading, StatusBadge, Textarea } from '@/components/ui'
import { errorMessage } from '@/lib/errors'
import { brl, fmtDate, fmtDateTime, fmtKm, fmtQty } from '@/lib/format'
import { itemStatus, orderStatus, quoteStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'

// O token vem no fragmento (#t=...) e nunca é enviado ao servidor web nem a analytics.
function useToken() {
  const [t] = useState(() => new URLSearchParams(location.hash.slice(1)).get('t') ?? '')
  return t
}

const STEPS = ['open', 'diagnosis', 'awaiting_approval', 'approved', 'in_progress', 'quality_check', 'ready', 'delivered']

export function PortalPage() {
  const token = useToken()
  // o portal nunca usa sessão de funcionário: evita misturar acessos no mesmo navegador
  useEffect(() => { document.title = 'Acompanhamento do atendimento' }, [])
  const q = useQuery({ queryKey: ['portal', token], enabled: !!token, retry: false, queryFn: () => rpc<any>('portal_view', { p_token: token }) })
  if (!token) return <Shell><ErrorBox error={{ message: 'Link incompleto. Peça um novo link à oficina.' }} /></Shell>
  if (q.isLoading) return <Shell><Loading /></Shell>
  if (q.error) return <Shell><ErrorBox error={{ message: errorMessage(q.error) + ' Peça um novo link à oficina.' }} /></Shell>
  const d = q.data
  return (
    <Shell color={d.workshop.color} name={d.workshop.name}>
      <p className="text-sm text-slate-600">Olá{d.client_first_name ? `, ${d.client_first_name}` : ''}! Veículo: <strong>{d.vehicle.brand} {d.vehicle.model} {d.vehicle.year ?? ''}</strong> {d.vehicle.plate_masked && <span className="text-slate-500">({d.vehicle.plate_masked})</span>}</p>
      {d.order && <OrderView o={d.order} token={token} />}
      {d.quote && <QuoteView qd={d.quote} token={token} purpose={d.purpose} onDone={() => q.refetch()} />}
      {d.next_care?.length > 0 && <section className="card p-4"><h2 className="mb-2 font-semibold">Próximos cuidados</h2>
        <ul className="text-sm">{d.next_care.map((c: any, i: number) => <li key={i}>{c.component}: {c.target_date && `a partir de ${fmtDate(c.target_date)}`} {c.target_km && `ou ${fmtKm(c.target_km)}`}</li>)}</ul>
        <p className="mt-1 text-xs text-slate-500">Datas e quilometragens são referências cadastradas pela oficina; confirme com ela.</p></section>}
      <Requests token={token} />
      <footer className="pt-4 text-center text-xs text-slate-500">{d.workshop.name} {d.workshop.phone && `· ${d.workshop.phone}`} · link válido até {fmtDateTime(d.expires_at)}</footer>
    </Shell>
  )
}

function Shell({ children, color, name }: { children: React.ReactNode; color?: string; name?: string }) {
  useEffect(() => { if (color) document.documentElement.style.setProperty('--brand', color) }, [color])
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="bg-navy-900 px-4 py-3 text-white"><p className="mx-auto max-w-2xl font-semibold">{name ?? 'Acompanhamento'}</p></header>
      <main className="mx-auto max-w-2xl space-y-4 p-4">{children}</main>
    </div>
  )
}

function OrderView({ o, token }: { o: any; token: string }) {
  const idx = STEPS.indexOf(o.status)
  const [urls, setUrls] = useState<Record<string, string>>({})
  useEffect(() => {
    o.photos.forEach((p: any) => supabase.functions.invoke('portal-file', { body: { token, attachment_id: p.id } })
      .then(({ data }) => data?.url && setUrls((s) => ({ ...s, [p.id]: data.url }))).catch(() => {}))
  }, [o.photos, token])
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Atendimento {o.number}</h2><StatusBadge map={orderStatus} value={o.status} /></div>
      {o.status !== 'cancelled' && <ol className="flex gap-1" aria-label="Etapas">{STEPS.slice(0, 8).map((s, i) => <li key={s} title={orderStatus[s][0]} className={`h-2 flex-1 rounded ${i <= idx ? 'bg-brand' : 'bg-slate-200'}`} />)}</ol>}
      <p className="text-sm">Etapa atual: <strong>{orderStatus[o.status][0]}</strong>{o.parts_pending && ' — aguardando peças'}</p>
      {o.expected_delivery_at && o.status !== 'delivered' && <p className="text-sm">Previsão de entrega: {fmtDateTime(o.expected_delivery_at)}</p>}
      {o.notes_client && <p className="rounded bg-blue-50 p-2 text-sm">{o.notes_client}</p>}
      {o.items.length > 0 && <div><h3 className="mb-1 text-sm font-semibold">Serviços aprovados</h3><ul className="divide-y divide-slate-100 text-sm">{o.items.map((i: any, k: number) => (
        <li key={k} className="flex items-center gap-2 py-1">{i.description} <span className="text-slate-500">× {fmtQty(i.quantity)}</span><span className="ml-auto">{brl(i.total_cents)}</span><StatusBadge map={itemStatus} value={i.status} /></li>))}</ul></div>}
      {o.photos.length > 0 && <div className="grid grid-cols-3 gap-2">{o.photos.map((p: any) => urls[p.id] ? <img key={p.id} src={urls[p.id]} alt={p.caption ?? 'Foto do serviço'} className="aspect-square w-full rounded object-cover" /> : <div key={p.id} className="aspect-square rounded bg-slate-100" />)}</div>}
      {o.timeline.length > 0 && <details><summary className="cursor-pointer text-sm text-brand">Histórico</summary><ul className="mt-1 text-xs text-slate-600">{o.timeline.map((e: any, k: number) => <li key={k}>{fmtDateTime(e.at)} — {e.message}</li>)}</ul></details>}
      {o.warranty_terms && <p className="text-xs text-slate-500">Garantia da oficina: {o.warranty_terms}</p>}
    </section>
  )
}

function QuoteView({ qd, token, purpose, onDone }: { qd: any; token: string; purpose: string; onDone: () => void }) {
  const [sel, setSel] = useState<string[]>(() => qd.items.map((i: any) => i.id))
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const total = useMemo(() => qd.items.filter((i: any) => sel.includes(i.id)).reduce((s: number, i: any) => s + Number(i.total_cents), 0), [sel, qd.items])
  // conjuntos: marcar/desmarcar um item afeta todos do mesmo conjunto
  function toggle(item: any, v: boolean) {
    const group = item.group_key ? qd.items.filter((i: any) => i.group_key === item.group_key).map((i: any) => i.id) : [item.id]
    setSel((s) => v ? [...new Set([...s, ...group])] : s.filter((x) => !group.includes(x)))
  }
  const decide = useMutation({
    mutationFn: (approved: string[]) => rpc<any>('portal_decide', { p_token: token, p_code: code || null, p_approved: approved, p_name: name, p_confirm: confirm }),
    onSuccess: (r) => {
      if (!r.ok) return setMsg({ ok: false, text: `Código incorreto. Tentativas restantes: ${r.attempts_left}.` })
      setMsg({ ok: true, text: `Decisão registrada: ${quoteStatus[r.decision][0]}. A oficina foi notificada no sistema.` }); onDone()
    },
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) }),
  })
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Orçamento {qd.number} <span className="text-sm font-normal text-slate-500">versão {qd.version_no}</span></h2><StatusBadge map={quoteStatus} value={qd.status} /></div>
      <p className="text-sm text-slate-600">Válido até {fmtDate(qd.valid_until)}{qd.estimated_days && ` · prazo estimado ${qd.estimated_days} dia(s)`}</p>
      <ul className="divide-y divide-slate-100">{qd.items.map((i: any) => (
        <li key={i.id} className="flex items-start gap-2 py-2 text-sm">
          {qd.can_decide ? <Checkbox label="" checked={sel.includes(i.id)} onChange={(v) => toggle(i, v)} /> : null}
          <div className="flex-1">{i.description} <span className="text-slate-500">× {fmtQty(i.quantity)}</span>{i.group_key && <Badge tone="violet">aprovar em conjunto</Badge>}{i.priority === 'critica' && <Badge tone="red">importante para segurança</Badge>}
            {Number(i.discount_cents) > 0 && <span className="block text-xs text-slate-500">desconto {brl(i.discount_cents)}</span>}</div>
          <span className="font-medium">{brl(i.total_cents)}</span>
        </li>))}</ul>
      <div className="text-right text-sm"><p>Total do orçamento: <strong>{brl(qd.total_cents)}</strong></p>{qd.can_decide && <p>Selecionado: <strong>{brl(total)}</strong></p>}</div>
      {qd.payment_terms && <p className="text-sm">Pagamento: {qd.payment_terms}</p>}
      {qd.conditions && <p className="text-xs text-slate-500">{qd.conditions}</p>}
      {qd.notes_client && <p className="rounded bg-blue-50 p-2 text-sm">{qd.notes_client}</p>}
      {qd.decision && <p className="flex items-center gap-2 rounded bg-emerald-50 p-2 text-sm text-emerald-800"><CheckCircle2 className="size-4" />Decisão registrada em {fmtDateTime(qd.decision.at)} por {qd.decision.name}.</p>}
      {qd.can_decide && (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <Input label="Seu nome" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          {qd.requires_code && <Input label="Código de verificação (enviado pela oficina)" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}
          <Checkbox label="Li os itens e valores e confirmo minha decisão." checked={confirm} onChange={setConfirm} />
          <p className="text-xs text-slate-500">Registro de aceite eletrônico simples (nome, data e versão). Não é assinatura digital certificada. Itens não selecionados ficam como recomendação para depois.</p>
          {msg && <p role="alert" className={msg.ok ? 'text-sm text-emerald-700' : 'text-sm text-red-600'}>{msg.text}</p>}
          <div className="flex flex-wrap gap-2">
            <Button loading={decide.isPending} disabled={!name || !confirm || sel.length === 0 || (qd.requires_code && code.length !== 6)} onClick={() => decide.mutate(sel)}>{sel.length === qd.items.length ? 'Aprovar orçamento' : 'Aprovar itens selecionados'}</Button>
            <Button variant="secondary" disabled={!name || !confirm || decide.isPending || (qd.requires_code && code.length !== 6)} onClick={() => decide.mutate([])}>Recusar tudo</Button>
          </div>
        </div>
      )}
      {!qd.can_decide && purpose === 'approve' && !qd.decision && <p className="text-sm text-amber-700">Este orçamento não está mais disponível para aprovação (vencido ou substituído). Fale com a oficina.</p>}
    </section>
  )
}

function Requests({ token }: { token: string }) {
  const [kind, setKind] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [km, setKm] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  async function send() {
    setErr(null)
    try {
      if (kind === 'km') await rpc('portal_report_km', { p_token: token, p_km: Number(km) })
      else if (kind === 'stop') await rpc('portal_stop_reminders', { p_token: token })
      else await rpc('portal_request', { p_token: token, p_kind: kind, p_message: text })
      setDone(kind === 'stop' ? 'Pronto: você não receberá mais lembretes preventivos.' : kind === 'km' ? 'Obrigado! A oficina vai conferir a quilometragem.' : 'Pedido enviado. A oficina entrará em contato — o horário só vale após confirmação.')
      setKind(null); setText(''); setKm('')
    } catch (e) { setErr(errorMessage(e)) }
  }
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">Precisa de algo?</h2>
      {done && <p className="text-sm text-emerald-700">{done}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setKind('km')}>Informar quilometragem</Button>
        <Button size="sm" variant="secondary" onClick={() => setKind('horario')}>Pedir horário</Button>
        <Button size="sm" variant="secondary" onClick={() => setKind('reagendamento')}>Reagendar</Button>
        <Button size="sm" variant="secondary" onClick={() => setKind('contato')}>Pedir contato</Button>
        <Button size="sm" variant="ghost" onClick={() => setKind('stop')}>Parar lembretes</Button>
      </div>
      {kind && <div className="space-y-2">
        {kind === 'km' ? <Input label="Quilometragem atual" inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ''))} />
          : kind === 'stop' ? <p className="text-sm">Você deixará de receber lembretes de manutenção preventiva e promoções. Avisos sobre um atendimento em andamento continuam.</p>
            : <Textarea label="Mensagem (dia/horário de preferência, etc.)" value={text} onChange={(e) => setText(e.target.value)} />}
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <div className="flex gap-2"><Button size="sm" onClick={send} disabled={kind === 'km' && !km}>Enviar</Button><Button size="sm" variant="ghost" onClick={() => setKind(null)}>Cancelar</Button></div>
      </div>}
    </section>
  )
}

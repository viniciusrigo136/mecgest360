import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { Badge, Button, Card, Checkbox, ErrorBox, Input, Loading, Modal, MoneyInput, PageHeader, Select, Table, Tabs, Textarea, useToast } from '@/components/ui'
import { brl, fmtDateTime } from '@/lib/format'
import { COMPONENTS } from '@/lib/labels'
import { supabase } from '@/lib/supabase'
import { renderTemplate } from '@/lib/whatsapp'

const DAYS = [['1', 'Segunda'], ['2', 'Terça'], ['3', 'Quarta'], ['4', 'Quinta'], ['5', 'Sexta'], ['6', 'Sábado'], ['0', 'Domingo']]

export function SettingsPage() {
  const { can } = useAuth()
  const [tab, setTab] = useState('oficina')
  return (
    <div>
      <PageHeader title="Configurações" />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'oficina', label: 'Sua oficina' }, { key: 'catalogo', label: 'Serviços e preços' },
        { key: 'mensagens', label: 'Mensagens' }, { key: 'horarios', label: 'Horários' },
        ...(can('integrations.manage') ? [{ key: 'integracoes', label: 'Integrações' }] : [])]} />
      {tab === 'oficina' && <WorkshopForm />}
      {tab === 'horarios' && <Hours />}
      {tab === 'catalogo' && <Catalog />}
      {tab === 'mensagens' && <Messages />}
      {tab === 'integracoes' && <Integrations />}
    </div>
  )
}

function useWorkshop() {
  const { wsId } = useAuth()
  return useQuery({ queryKey: ['workshop', wsId], queryFn: async () => { const { data, error } = await supabase.from('workshops').select('*').eq('id', wsId).single(); if (error) throw error; return data } })
}

function WorkshopForm() {
  const { wsId, refresh } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const w = useWorkshop()
  const [f, setF] = useState<any>(null)
  useEffect(() => { if (w.data) setF({ ...w.data, ...w.data.address }) }, [w.data])
  if (w.isLoading || !f) return <Loading />
  const set = (k: string) => (e: { target: { value: string } }) => setF((s: any) => ({ ...s, [k]: e.target.value }))
  async function save() {
    const { data, error } = await supabase.from('workshops').update({ name: f.name, legal_name: f.legal_name || null, document: f.document || null, phone: f.phone || null, whatsapp: f.whatsapp || null,
      email: f.email || null, primary_color: f.primary_color, timezone: f.timezone, commercial_terms: f.commercial_terms || null, warranty_terms: f.warranty_terms || null,
      max_discount_pct: Number(f.max_discount_pct), payment_methods: f.payment_methods, pix_key: f.pix_key || null, pix_name: f.pix_name || null, pix_city: f.pix_city || null, address: { street: f.street, city: f.city, state: f.state, zip: f.zip } }).eq('id', wsId).eq('version', w.data.version).select('id')
    if (error) return toast.error(error)
    if (!data?.length) return toast.error({ code: '40001' })
    toast.success('Configurações salvas'); qc.invalidateQueries({ queryKey: ['workshop'] }); refresh()
  }
  async function uploadLogo(file?: File) {
    if (!file) return
    const path = `${wsId}/logo-${Date.now()}.${file.type.split('/')[1]}`
    const up = await supabase.storage.from('workshop-assets').upload(path, file, { contentType: file.type })
    if (up.error) return toast.error(up.error)
    await supabase.from('workshops').update({ logo_path: path }).eq('id', wsId)
    qc.invalidateQueries({ queryKey: ['workshop'] }); refresh(); toast.success('Logo atualizado')
  }
  const methods = ['dinheiro', 'pix', 'cartao_debito', 'cartao_credito', 'transferencia', 'boleto', 'outro']
  return (
    <Card title="Dados da oficina">
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Nome exibido *" value={f.name} onChange={set('name')} /><Input label="Razão social" value={f.legal_name ?? ''} onChange={set('legal_name')} /><Input label="CNPJ/CPF (opcional)" value={f.document ?? ''} onChange={set('document')} />
        <Input label="Telefone" value={f.phone ?? ''} onChange={set('phone')} /><Input label="WhatsApp" value={f.whatsapp ?? ''} onChange={set('whatsapp')} /><Input label="E-mail" value={f.email ?? ''} onChange={set('email')} />
        <Input className="sm:col-span-2" label="Endereço" value={f.street ?? ''} onChange={set('street')} /><Input label="Cidade" value={f.city ?? ''} onChange={set('city')} />
        <Input label="UF" value={f.state ?? ''} onChange={set('state')} /><Input label="CEP" value={f.zip ?? ''} onChange={set('zip')} />
        <Select label="Fuso horário" value={f.timezone} onChange={set('timezone')}>{['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Rio_Branco', 'America/Noronha'].map((t) => <option key={t}>{t}</option>)}</Select>
        <Input label="Cor principal" type="color" value={f.primary_color} onChange={set('primary_color')} />
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 sm:col-span-3"><p className="mb-2 font-semibold">Pix da oficina</p>
          <p className="mb-3 text-sm text-slate-600">Aparece como QR Code no orçamento em PDF, na entrega e na página do cliente. O pagamento não é confirmado automaticamente: confira no banco.</p>
          <div className="grid gap-3 sm:grid-cols-3"><Input label="Chave Pix" value={f.pix_key ?? ''} onChange={set('pix_key')} placeholder="CPF, CNPJ, e-mail, celular ou aleatória" />
          <Input label="Nome de quem recebe" value={f.pix_name ?? ''} onChange={set('pix_name')} />
          <Input label="Cidade" value={f.pix_city ?? ''} onChange={set('pix_city')} /></div></div>
        <Input label="Desconto máximo sem autorização (%)" inputMode="decimal" value={String(f.max_discount_pct)} onChange={set('max_discount_pct')} />
        <div><p className="label">Logo</p><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => uploadLogo(e.target.files?.[0])} className="text-sm" />{f.logo_path && <p className="text-xs text-slate-500">Logo cadastrado</p>}</div>
        <div className="sm:col-span-3"><p className="label">Meios de pagamento aceitos</p><div className="flex flex-wrap gap-3">{methods.map((m) => (
          <Checkbox key={m} label={m} checked={f.payment_methods.includes(m)} onChange={(v) => setF((s: any) => ({ ...s, payment_methods: v ? [...s.payment_methods, m] : s.payment_methods.filter((x: string) => x !== m) }))} />))}</div></div>
        <Textarea className="sm:col-span-3" label="Termos comerciais (orçamentos)" value={f.commercial_terms ?? ''} onChange={set('commercial_terms')} />
        <Textarea className="sm:col-span-3" label="Condições de garantia da oficina" value={f.warranty_terms ?? ''} onChange={set('warranty_terms')} hint="Defina as condições da sua oficina. O sistema não presume prazos legais." />
      </div>
      <div className="mt-3 flex justify-end"><Button onClick={save}>Salvar</Button></div>
    </Card>
  )
}

function Hours() {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const w = useWorkshop()
  const [hours, setHours] = useState<Record<string, string[][]>>({})
  const blocks = useQuery({ queryKey: ['blocks', wsId], queryFn: async () => (await supabase.from('schedule_blocks').select('*').eq('workshop_id', wsId).gte('ends_at', new Date().toISOString()).order('starts_at')).data ?? [] })
  const [blk, setBlk] = useState({ start: '', end: '', reason: '' })
  useEffect(() => { if (w.data) setHours(w.data.business_hours) }, [w.data])
  async function saveHours() {
    const { error } = await supabase.from('workshops').update({ business_hours: hours }).eq('id', wsId)
    if (error) toast.error(error); else { toast.success('Horários salvos'); qc.invalidateQueries({ queryKey: ['workshop'] }) }
  }
  return (
    <div className="space-y-4">
      <Card title="Horário de funcionamento" actions={<Button size="sm" onClick={saveHours}>Salvar</Button>}>
        <p className="mb-2 text-xs text-slate-500">Até dois turnos por dia (a pausa entre eles bloqueia agendamentos).</p>
        {DAYS.map(([d, label]) => {
          const slots = hours[d] ?? []
          const setSlot = (i: number, j: number, v: string) => setHours((h) => { const s = [...(h[d] ?? [])].map((x) => [...x]); s[i][j] = v; return { ...h, [d]: s } })
          return (
            <div key={d} className="flex flex-wrap items-center gap-2 py-1 text-sm"><span className="w-24">{label}</span>
              {slots.map((s, i) => <span key={i} className="flex items-center gap-1"><input type="time" className="input h-8 w-28 py-0" value={s[0]} onChange={(e) => setSlot(i, 0, e.target.value)} aria-label={`${label} início ${i + 1}`} />–<input type="time" className="input h-8 w-28 py-0" value={s[1]} onChange={(e) => setSlot(i, 1, e.target.value)} aria-label={`${label} fim ${i + 1}`} /></span>)}
              {slots.length < 2 && <Button size="sm" variant="ghost" onClick={() => setHours((h) => ({ ...h, [d]: [...(h[d] ?? []), ['08:00', '12:00']] }))}>+ turno</Button>}
              {slots.length > 0 && <Button size="sm" variant="ghost" onClick={() => setHours((h) => ({ ...h, [d]: [] }))}>fechado</Button>}
            </div>
          )
        })}
      </Card>
      <Card title="Feriados e bloqueios">
        <div className="mb-3 grid gap-2 sm:grid-cols-4"><Input label="Início" type="datetime-local" value={blk.start} onChange={(e) => setBlk((s) => ({ ...s, start: e.target.value }))} /><Input label="Fim" type="datetime-local" value={blk.end} onChange={(e) => setBlk((s) => ({ ...s, end: e.target.value }))} />
          <Input label="Motivo" value={blk.reason} onChange={(e) => setBlk((s) => ({ ...s, reason: e.target.value }))} />
          <div className="flex items-end"><Button disabled={!blk.start || !blk.end || !blk.reason} onClick={async () => { const { error } = await supabase.from('schedule_blocks').insert({ workshop_id: wsId, starts_at: new Date(blk.start).toISOString(), ends_at: new Date(blk.end).toISOString(), reason: blk.reason }); if (error) toast.error(error); else { setBlk({ start: '', end: '', reason: '' }); qc.invalidateQueries({ queryKey: ['blocks'] }) } }}>Adicionar</Button></div></div>
        <ul className="text-sm">{blocks.data?.map((b: any) => <li key={b.id}>{fmtDateTime(b.starts_at)} → {fmtDateTime(b.ends_at)} · {b.reason}</li>)}</ul>
      </Card>
    </div>
  )
}

function Catalog() {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [edit, setEdit] = useState<any>(null)
  const list = useQuery({ queryKey: ['catalog', wsId], queryFn: async () => (await supabase.from('service_catalog').select('*').eq('workshop_id', wsId).is('archived_at', null).order('name')).data ?? [] })
  async function save() {
    const row = { workshop_id: wsId, name: edit.name, description: edit.description || null, category: edit.category || null, duration_min: Number(edit.duration_min) || 60,
      base_price_cents: edit.base_price_cents ?? 0, maintenance_component: edit.maintenance_component || null,
      suggested_interval_months: edit.suggested_interval_months ? Number(edit.suggested_interval_months) : null, suggested_interval_km: edit.suggested_interval_km ? Number(edit.suggested_interval_km) : null }
    const r = edit.id ? await supabase.from('service_catalog').update(row).eq('id', edit.id) : await supabase.from('service_catalog').insert(row)
    if (r.error) return toast.error(r.error)
    qc.invalidateQueries({ queryKey: ['catalog'] }); setEdit(null)
  }
  return (
    <Card title="Catálogo de serviços" actions={<Button size="sm" onClick={() => setEdit({ duration_min: 60, base_price_cents: 0 })}><Plus className="size-4" />Serviço</Button>}>
      <p className="mb-2 text-xs text-slate-500">Preços do catálogo são copiados para orçamentos/OS; mudar aqui não altera documentos já emitidos.</p>
      <Table head={['Serviço', 'Categoria', 'Duração', 'Valor base', 'Componente preventivo', '']} empty={!list.data?.length}>
        {list.data?.map((s: any) => <tr key={s.id}><td className="td">{s.name}</td><td className="td">{s.category}</td><td className="td">{s.duration_min} min</td><td className="td">{brl(s.base_price_cents)}</td>
          <td className="td">{COMPONENTS.find((c) => c.key === s.maintenance_component)?.label}</td><td className="td"><Button size="sm" variant="ghost" onClick={() => setEdit(s)}>Editar</Button>
            <Button size="sm" variant="ghost" onClick={async () => { await supabase.from('service_catalog').update({ archived_at: new Date().toISOString() }).eq('id', s.id); qc.invalidateQueries({ queryKey: ['catalog'] }) }}>Arquivar</Button></td></tr>)}
      </Table>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Serviço do catálogo" footer={<Button disabled={!edit?.name} onClick={save}>Salvar</Button>}>
        {edit && <div className="grid gap-3 sm:grid-cols-2">
          <Input className="sm:col-span-2" label="Nome" value={edit.name ?? ''} onChange={(e) => setEdit((s: any) => ({ ...s, name: e.target.value }))} />
          <Input label="Categoria" value={edit.category ?? ''} onChange={(e) => setEdit((s: any) => ({ ...s, category: e.target.value }))} />
          <Input label="Duração estimada (min)" value={edit.duration_min ?? ''} onChange={(e) => setEdit((s: any) => ({ ...s, duration_min: e.target.value }))} />
          <MoneyInput label="Valor base" cents={edit.base_price_cents === undefined ? null : Number(edit.base_price_cents)} onCents={(c) => setEdit((s: any) => ({ ...s, base_price_cents: c }))} />
          <Select label="Componente preventivo atendido" value={edit.maintenance_component ?? ''} onChange={(e) => setEdit((s: any) => ({ ...s, maintenance_component: e.target.value }))}><option value="">Nenhum</option>{COMPONENTS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
          <Input label="Sugestão de intervalo (meses)" value={edit.suggested_interval_months ?? ''} onChange={(e) => setEdit((s: any) => ({ ...s, suggested_interval_months: e.target.value }))} hint="Apenas sugestão editável; nunca aplicada sem confirmação." />
          <Input label="Sugestão de intervalo (km)" value={edit.suggested_interval_km ?? ''} onChange={(e) => setEdit((s: any) => ({ ...s, suggested_interval_km: e.target.value }))} />
          <Textarea className="sm:col-span-2" label="Descrição" value={edit.description ?? ''} onChange={(e) => setEdit((s: any) => ({ ...s, description: e.target.value }))} />
        </div>}
      </Modal>
    </Card>
  )
}

function Messages() {
  const { wsId, ws } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const w = useWorkshop()
  const tpls = useQuery({ queryKey: ['templates', wsId], queryFn: async () => (await supabase.from('message_templates').select('*').eq('workshop_id', wsId).order('name')).data ?? [] })
  const [policy, setPolicy] = useState<any>(null)
  useEffect(() => { if (w.data) setPolicy(w.data.reminder_policy) }, [w.data])
  const sample = { nome: 'Maria', oficina: ws?.name, veiculo: 'Onix 2020', placa: 'ABC-**23', servico: 'Óleo do motor', data: '15/03', km: '45.000', link: 'https://…', telefone: '(11) 9…' }
  async function savePolicy() {
    const { error } = await supabase.from('workshops').update({ reminder_policy: { ...policy, max_auto_contacts_per_cycle: Number(policy.max_auto_contacts_per_cycle), min_days_between_contacts: Number(policy.min_days_between_contacts), max_km_per_day: Number(policy.max_km_per_day) } }).eq('id', wsId)
    if (error) toast.error(error); else { toast.success('Política salva'); qc.invalidateQueries({ queryKey: ['workshop'] }) }
  }
  return (
    <div className="space-y-4">
      {policy && <Card title="Política de lembretes" actions={<Button size="sm" onClick={savePolicy}>Salvar</Button>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="Janela: início" type="time" value={policy.window_start} onChange={(e) => setPolicy((p: any) => ({ ...p, window_start: e.target.value }))} />
          <Input label="Janela: fim" type="time" value={policy.window_end} onChange={(e) => setPolicy((p: any) => ({ ...p, window_end: e.target.value }))} />
          <div className="flex items-end pb-2"><Checkbox label="Somente dias úteis" checked={policy.business_days_only} onChange={(v) => setPolicy((p: any) => ({ ...p, business_days_only: v }))} /></div>
          <Input label="Máx. contatos automáticos por ciclo" value={policy.max_auto_contacts_per_cycle} onChange={(e) => setPolicy((p: any) => ({ ...p, max_auto_contacts_per_cycle: e.target.value }))} />
          <Input label="Intervalo mínimo entre contatos (dias)" value={policy.min_days_between_contacts} onChange={(e) => setPolicy((p: any) => ({ ...p, min_days_between_contacts: e.target.value }))} />
          <Input label="Km/dia máximo aceito na estimativa" value={policy.max_km_per_day} onChange={(e) => setPolicy((p: any) => ({ ...p, max_km_per_day: e.target.value }))} />
          <div className="flex items-end pb-2"><Checkbox label="Usar estimativa de km por uso" checked={policy.km_estimates_enabled} onChange={(v) => setPolicy((p: any) => ({ ...p, km_estimates_enabled: v }))} /></div>
        </div>
        <p className="mt-2 text-xs text-slate-500">Campanhas promocionais estão desativadas nesta versão e exigem consentimento próprio.</p>
      </Card>}
      <Card title="Modelos de mensagem">
        <p className="mb-2 text-xs text-slate-500">Variáveis: {'{nome} {oficina} {veiculo} {placa} {servico} {data} {km} {link} {telefone}'}. Não inclua informações internas.</p>
        {tpls.data?.map((t: any) => <TemplateEditor key={t.id} t={t} sample={sample} />)}
      </Card>
    </div>
  )
}
function TemplateEditor({ t, sample }: { t: any; sample: Record<string, any> }) {
  const toast = useToast()
  const [body, setBody] = useState(t.body)
  const { text, missing } = renderTemplate(body, sample)
  const unknown = [...body.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).filter((k) => !(k in sample))
  return (
    <div className="mb-4 rounded-md border border-slate-200 p-3">
      <p className="mb-1 text-sm font-semibold">{t.name} <span className="font-normal text-slate-500">({t.purpose})</span></p>
      <Textarea label="Texto" value={body} onChange={(e) => setBody(e.target.value)} error={unknown.length ? `Variável desconhecida: ${unknown.join(', ')}` : undefined} />
      <p className="mt-2 rounded bg-emerald-50 p-2 text-sm">Prévia: {text}</p>
      {missing.length > 0 && <p className="text-xs text-amber-700">Sem valor na prévia: {missing.join(', ')}</p>}
      <Button size="sm" className="mt-2" disabled={unknown.length > 0} onClick={async () => { const { error } = await supabase.from('message_templates').update({ body }).eq('id', t.id); if (error) toast.error(error); else toast.success('Modelo salvo') }}>Salvar</Button>
    </div>
  )
}

function Integrations() {
  const { wsId } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const w = useWorkshop()
  const jobs = useQuery({ queryKey: ['job-runs'], queryFn: async () => (await supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(20)).data ?? [] })
  const status = useQuery({ queryKey: ['wa-status'], queryFn: async () => { const { data, error } = await supabase.functions.invoke('integration-status'); return error ? { error: error.message } : data } })
  const auto = w.data?.messaging_mode === 'automatic'
  async function toggle() {
    if (!auto && !status.data?.whatsapp_configured) return toast.error({ message: 'A API oficial do WhatsApp ainda não está configurada no servidor. O modo manual continua disponível.' })
    const { error } = await supabase.from('workshops').update({ messaging_mode: auto ? 'manual' : 'automatic' }).eq('id', wsId)
    if (error) toast.error(error); else qc.invalidateQueries({ queryKey: ['workshop'] })
  }
  return (
    <div className="space-y-4">
      <Card title="WhatsApp">
        <p className="text-sm">Modo atual: <Badge tone={auto ? 'green' : 'blue'}>{auto ? 'Automático (API oficial)' : 'Manual (wa.me)'}</Badge></p>
        <p className="mt-2 text-sm">API oficial do WhatsApp Business: {status.isLoading ? '…' : status.data?.whatsapp_configured ? <Badge tone="green">configurada</Badge> : <Badge tone="amber">pendente — sem credenciais</Badge>}</p>
        <p className="mt-2 text-xs text-slate-500">O envio automático exige conta Meta Business, número aprovado, templates aprovados e possível cobrança por conversa. Credenciais ficam somente no servidor (secrets da função). Veja docs/INTEGRACOES.md.</p>
        <Button size="sm" className="mt-3" variant="secondary" onClick={toggle}>{auto ? 'Voltar ao modo manual' : 'Ativar modo automático'}</Button>
      </Card>
      <Card title="Execuções de jobs no servidor">
        {jobs.error ? <ErrorBox error={jobs.error} /> : <Table head={['Job', 'Início', 'Fim', 'Resultado']} empty={!jobs.data?.length}>
          {jobs.data?.map((j: any) => <tr key={j.id}><td className="td">{j.job}</td><td className="td">{fmtDateTime(j.started_at)}</td><td className="td">{j.finished_at ? fmtDateTime(j.finished_at) : <Badge tone="amber">sem término</Badge>}</td><td className="td text-xs">{j.ok === false ? <Badge tone="red">falhou</Badge> : JSON.stringify(j.detail)}</td></tr>)}
        </Table>}
        <p className="mt-2 text-xs text-slate-500">Lembretes são gerados de hora em hora pelo agendador do banco (pg_cron), sem depender de alguém abrir o sistema. Se a lista estiver vazia, o agendamento ainda não rodou ou não foi configurado.</p>
      </Card>
      <Card title="Backups"><p className="text-sm">Backups são responsabilidade do provedor (Supabase) e dependem do plano contratado. Este sistema não exibe "backup feito" sem confirmação. Procedimento de restauração e teste: docs/OPERACAO.md.</p></Card>
    </div>
  )
}


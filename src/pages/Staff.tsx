import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Copy, MessageCircle, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { useTeam } from '@/components/pickers'
import { Badge, Button, Input, Loading, Modal, useToast } from '@/components/ui'
import { rpc, supabase } from '@/lib/supabase'
import { waLink } from '@/lib/whatsapp'

// Funções prontas: o dono escolhe uma e o sistema aplica as permissões.
// Ninguém além do dono vê lucro, custos, financeiro ou mexe na equipe.
const ROLES = [
  { key: 'mechanic', title: 'Mecânico', can: 'Vê os carros na oficina, atualiza o serviço, tira fotos e marca como pronto.',
    cannot: 'Não vê valores, dados dos clientes, financeiro nem indicadores.', overrides: { 'orders.view_all': true }, scope: 'all' },
  { key: 'reception', title: 'Atendente', can: 'Recebe carros, cadastra clientes, faz orçamentos, entrega e recebe pagamentos.',
    cannot: 'Não vê custos, lucro, financeiro geral, indicadores nem a equipe.', overrides: { 'payments.receive': true }, scope: 'all' },
  { key: 'manager', title: 'Gerente', can: 'Tudo do dia a dia, estoque e indicadores da operação.',
    cannot: 'Não vê o financeiro nem pode cadastrar ou bloquear funcionários.', overrides: {}, scope: 'all' },
] as const

const roleTitle: Record<string, string> = { owner: 'Dono', mechanic: 'Mecânico', reception: 'Atendente', manager: 'Gerente', finance: 'Financeiro', stock: 'Estoquista', viewer: 'Consulta' }

export function StaffSettings() {
  const { session, can } = useAuth()
  const team = useTeam()
  const toast = useToast()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  async function toggle(m: any) {
    const blocking = m.status === 'active'
    if (blocking && !confirm(`Bloquear ${m.name}? O acesso dele(a) é cortado na hora.`)) return
    try { await rpc('set_member_status', { p_membership: m.id, p_status: blocking ? 'blocked' : 'active', p_reason: blocking ? 'Bloqueado pelo dono' : null }); qc.invalidateQueries({ queryKey: ['team'] }) }
    catch (e) { toast.error(e) }
  }
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div><h2 className="text-lg font-bold">Funcionários</h2><p className="text-sm text-slate-500">Cada pessoa tem o próprio login. Valores e financeiro ficam só com você.</p></div>
        {can('team.manage') && <Button onClick={() => setAdding(true)}><UserPlus className="size-4" />Adicionar</Button>}
      </div>
      {team.isLoading ? <Loading /> : (
        <ul className="divide-y divide-slate-100">{team.data?.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-brand-soft font-bold text-brand-strong">{m.name.slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{m.name}</p><p className="truncate text-sm text-slate-500">{roleTitle[m.role] ?? m.role} · {m.profiles?.email}</p></div>
            {m.status === 'blocked' && <Badge tone="red">Bloqueado</Badge>}
            {can('team.manage') && m.user_id !== session?.user.id && m.role !== 'owner' &&
              <Button size="sm" variant={m.status === 'active' ? 'ghost' : 'secondary'} onClick={() => toggle(m)}>{m.status === 'active' ? 'Bloquear' : 'Reativar'}</Button>}
          </li>
        ))}</ul>
      )}
      <AddStaff open={adding} onClose={() => setAdding(false)} />
    </section>
  )
}

function AddStaff({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wsId, ws } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<(typeof ROLES)[number]['key']>('mechanic')
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  function reset() { setName(''); setEmail(''); setPhone(''); setRole('mechanic'); setLink(null) }
  async function save() {
    setBusy(true)
    try {
      const r = ROLES.find((x) => x.key === role)!
      const inv = await rpc<any[]>('create_invite', { p_workshop: wsId, p_email: email.trim(), p_full_name: name.trim(), p_role: role,
        p_order_scope: r.scope, p_overrides: r.overrides })
      const url = `${location.origin}/convite#t=${inv[0].token}`
      let sent = false
      const { data, error } = await supabase.functions.invoke('send-invite', { body: { email: email.trim(), full_name: name.trim(), redirect_to: url } })
      if (!error && data?.status === 'invited') sent = true
      else if (!error && data?.status === 'exists') sent = !(await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: url, shouldCreateUser: false } })).error
      setLink(url)
      toast[sent ? 'success' : 'info'](sent ? 'Convite enviado por e-mail' : 'Convite criado. Mande o link pelo WhatsApp.')
      qc.invalidateQueries({ queryKey: ['team'] })
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  const wa = link ? waLink(phone, `Olá, ${name.split(' ')[0]}! Este é o seu acesso ao sistema da ${ws?.name}: ${link} (vale por 3 dias).`) : null
  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title={link ? 'Convite pronto' : 'Adicionar funcionário'}>
      {link ? (
        <div className="space-y-3">
          <p className="text-slate-600">{name.split(' ')[0]} recebe um e-mail para criar a senha. Se preferir, mande o link abaixo (vale 3 dias, uso único).</p>
          {wa && <a href={wa} target="_blank" rel="noopener noreferrer" className="flex h-12 items-center justify-center gap-2 rounded-xl bg-wa font-semibold text-white"><MessageCircle className="size-5" />Mandar no WhatsApp</a>}
          <Button variant="secondary" size="lg" className="w-full" onClick={() => { navigator.clipboard.writeText(link).then(() => toast.success('Link copiado')).catch(() => toast.info(link)) }}><Copy className="size-4" />Copiar link</Button>
          <Button variant="ghost" className="w-full" onClick={() => { reset(); onClose() }}>Concluir</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Input label="E-mail (para entrar no sistema)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="WhatsApp (opcional, para mandar o convite)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <p className="label">Função</p>
          <div className="space-y-2">{ROLES.map((r) => (
            <button key={r.key} onClick={() => setRole(r.key)} aria-pressed={role === r.key}
              className={clsx('w-full rounded-2xl border p-4 text-left', role === r.key ? 'border-brand bg-brand-soft' : 'border-slate-200')}>
              <span className="block font-semibold">{r.title}</span>
              <span className="block text-sm text-slate-600">{r.can}</span>
              <span className="mt-1 block text-sm text-red-700">{r.cannot}</span>
            </button>
          ))}</div>
          <Button size="lg" className="w-full" loading={busy} disabled={name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email.trim())} onClick={save}>Criar acesso</Button>
        </div>
      )}
    </Modal>
  )
}

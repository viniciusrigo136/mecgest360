import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { useTeam } from '@/components/pickers'
import { Badge, Button, Card, ErrorBox, Input, Loading, Modal, PageHeader, Select, Table, useToast } from '@/components/ui'
import { fmtDateTime } from '@/lib/format'
import { roleLabel } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'

export function TeamPage() {
  const { wsId, can, session, tz } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const team = useTeam()
  const [invite, setInvite] = useState(false)
  const [edit, setEdit] = useState<any>(null)
  const invites = useQuery({ queryKey: ['invites', wsId], enabled: can('team.manage'), queryFn: async () => (await supabase.from('invites').select('*').eq('workshop_id', wsId).is('used_at', null).is('revoked_at', null).order('created_at', { ascending: false })).data ?? [] })
  async function block(m: any) {
    const blocking = m.status === 'active'
    const reason = blocking ? prompt('Motivo do bloqueio (o acesso é removido imediatamente; a autoria histórica é preservada):') : ''
    if (blocking && !reason) return
    try { await rpc('set_member_status', { p_membership: m.id, p_status: blocking ? 'blocked' : 'active', p_reason: reason }); qc.invalidateQueries({ queryKey: ['team'] }) } catch (e) { toast.error(e) }
  }
  return (
    <div>
      <PageHeader title="Equipe" subtitle="Cada pessoa tem conta própria. Ninguém altera o próprio perfil; somente proprietário concede perfil de proprietário." actions={can('team.manage') && <Button onClick={() => setInvite(true)}><Plus className="size-4" />Convidar</Button>} />
      {team.error ? <ErrorBox error={team.error} /> : team.isLoading ? <Loading /> : (
        <div className="card"><Table head={['Nome', 'E-mail', 'Perfil', 'Escopo de OS', 'Situação', '']}>
          {team.data?.map((m: any) => (
            <tr key={m.id}><td className="td font-medium">{m.name}<span className="block text-xs text-slate-500">{m.job_title}</span></td><td className="td">{m.profiles?.email}</td><td className="td">{roleLabel[m.role]}</td>
              <td className="td">{m.role === 'owner' ? 'Todas' : m.order_scope === 'all' ? 'Todas' : 'Somente atribuídas'}</td>
              <td className="td">{m.status === 'active' ? <Badge tone="green">Ativo</Badge> : <Badge tone="red">Bloqueado</Badge>}</td>
              <td className="td">{can('team.manage') && m.user_id !== session?.user.id && <div className="flex justify-end gap-1"><Button size="sm" variant="secondary" onClick={() => setEdit(m)}>Permissões</Button><Button size="sm" variant="ghost" onClick={() => block(m)}>{m.status === 'active' ? 'Bloquear' : 'Reativar'}</Button></div>}</td></tr>
          ))}
        </Table></div>
      )}
      {can('team.manage') && invites.data && invites.data.length > 0 && <Card title="Convites pendentes" className="mt-4"><ul className="text-sm">{invites.data.map((i: any) => (
        <li key={i.id} className="flex items-center gap-2 py-1">{i.full_name} · {i.email} · {roleLabel[i.role]} <span className="text-slate-500">expira {fmtDateTime(i.expires_at, tz)}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={async () => { await rpc('revoke_invite', { p_invite: i.id }).catch(toast.error); qc.invalidateQueries({ queryKey: ['invites'] }) }}>Revogar</Button></li>
      ))}</ul></Card>}
      <AccessModal open={invite} onClose={() => setInvite(false)} />
      <AccessModal open={!!edit} onClose={() => setEdit(null)} member={edit} />
    </div>
  )
}

function AccessModal({ open, onClose, member }: { open: boolean; onClose: () => void; member?: any }) {
  const { wsId, ws } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const [f, setF] = useState({ email: '', name: '', role: 'mechanic', scope: 'assigned', job: '' })
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setLink(null)
    if (member) {
      setF({ email: member.profiles?.email ?? '', name: member.name, role: member.role, scope: member.order_scope, job: member.job_title ?? '' })
      supabase.from('member_permission_overrides').select('permission, granted').eq('membership_id', member.id).then(({ data }) => setOverrides(Object.fromEntries((data ?? []).map((o) => [o.permission, o.granted]))))
    } else { setF({ email: '', name: '', role: 'mechanic', scope: 'assigned', job: '' }); setOverrides({}) }
  }, [open, member])
  const preview = useQuery({ queryKey: ['preview', f.role, overrides], enabled: open, queryFn: () => rpc<any[]>('preview_access', { p_role: f.role, p_overrides: overrides }) })
  const byModule = (preview.data ?? []).reduce<Record<string, any[]>>((acc, p) => { (acc[p.module] ??= []).push(p); return acc }, {})
  async function save() {
    setBusy(true)
    try {
      if (member) {
        await rpc('update_member', { p_membership: member.id, p_role: f.role, p_order_scope: f.scope, p_overrides: overrides, p_job_title: f.job || null, p_expected_version: member.version })
        toast.success('Permissões atualizadas (registrado na auditoria)'); qc.invalidateQueries({ queryKey: ['team'] }); onClose()
      } else {
        const r = await rpc<any[]>('create_invite', { p_workshop: wsId, p_email: f.email, p_full_name: f.name, p_role: f.role, p_job_title: f.job || null, p_order_scope: f.scope, p_overrides: overrides })
        const tok = (Array.isArray(r) ? r[0] : r as any).token
        const url = `${location.origin}/convite#t=${tok}`
        // e-mail de acesso enviado pela função de servidor (cadastro público fica desativado)
        let sent = false
        const { data, error } = await supabase.functions.invoke('send-invite', { body: { email: f.email, full_name: f.name, redirect_to: url } })
        if (!error && data?.status === 'invited') sent = true
        else if (!error && data?.status === 'exists') {
          const r2 = await supabase.auth.signInWithOtp({ email: f.email, options: { emailRedirectTo: url, shouldCreateUser: false } })
          sent = !r2.error
        }
        setLink(url)
        toast[sent ? 'success' : 'info'](sent ? 'Convite criado e e-mail de acesso enviado' : 'Convite criado. O e-mail não pôde ser enviado (função de servidor não configurada?) — copie o link abaixo.')
        qc.invalidateQueries({ queryKey: ['invites'] })
      }
    } catch (e) { toast.error(e) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title={member ? `Permissões de ${member.name}` : 'Convidar funcionário'} wide
      footer={!link && <><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!member && (!f.email || !f.name)} onClick={save}>{member ? 'Salvar' : 'Criar convite'}</Button></>}>
      {link ? (
        <div className="space-y-2 text-sm"><p>Convite de uso único, válido por 72 horas. A pessoa recebe um e-mail de acesso; se não chegar, envie este link:</p><Input label="Link do convite" readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button size="sm" onClick={() => { navigator.clipboard.writeText(link); toast.success('Copiado') }}>Copiar</Button></div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            {!member && <><Input label="Nome" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} /><Input label="E-mail" type="email" value={f.email} onChange={(e) => setF((s) => ({ ...s, email: e.target.value }))} /></>}
            <Input label="Função / cargo" value={f.job} onChange={(e) => setF((s) => ({ ...s, job: e.target.value }))} />
            <Select label="Perfil" value={f.role} onChange={(e) => { setF((s) => ({ ...s, role: e.target.value, scope: e.target.value === 'mechanic' ? 'assigned' : 'all' })); setOverrides({}) }}>
              {Object.entries(roleLabel).filter(([k]) => k !== 'owner' || ws?.role === 'owner').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select label="Escopo de ordens de serviço" value={f.scope} onChange={(e) => setF((s) => ({ ...s, scope: e.target.value }))}><option value="assigned">Somente OS atribuídas</option><option value="all">Todas da oficina (se tiver "ver todas as OS")</option></Select>
            <p className="text-xs text-slate-500">Marque/desmarque para ajustar individualmente. Você não pode conceder permissões que não possui.</p>
          </div>
          <div className="max-h-[55vh] overflow-y-auto rounded-md border border-slate-200 p-3">
            <p className="mb-2 text-sm font-semibold">Prévia do acesso resultante</p>
            {preview.isLoading ? <Loading /> : Object.entries(byModule).map(([mod, list]) => (
              <div key={mod} className="mb-2"><p className="text-xs font-semibold uppercase text-slate-500">{mod}</p>
                {list.map((p) => (
                  <label key={p.permission} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={p.granted} disabled={f.role === 'owner'} onChange={(e) => setOverrides((s) => ({ ...s, [p.permission]: e.target.checked }))} />
                    <span className={p.granted ? '' : 'text-slate-400'}>{p.label}</span>{p.sensitive && <Badge tone="amber">sensível</Badge>}{p.permission in overrides && <Badge tone="violet">ajuste</Badge>}
                  </label>
                ))}</div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { useTeam } from '@/components/pickers'
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, Select, StatusBadge, Table, Tabs, useToast } from '@/components/ui'
import { fmtDate, fmtDateTime, todayLocal } from '@/lib/format'
import { messageStatus } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'
import { waLink } from '@/lib/whatsapp'

export function ContactsPage() {
  const { wsId, can, tz } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const team = useTeam()
  const [tab, setTab] = useState('tarefas')
  const [status, setStatus] = useState('open')
  const tasks = useQuery({ queryKey: ['contact-tasks', wsId, status], queryFn: async () => {
    const { data, error } = await supabase.from('contact_tasks').select('*, clients(name, whatsapp_norm, phone), vehicles(plate, model)')
      .eq('workshop_id', wsId).eq('status', status).order('due_on').limit(200)
    if (error) throw error
    return data ?? []
  } })
  const queue = useQuery({ queryKey: ['message-queue', wsId], enabled: tab === 'fila' && can('messages.send'), queryFn: async () => {
    const { data, error } = await supabase.from('message_queue').select('*, clients(name)').eq('workshop_id', wsId).order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    return data ?? []
  } })
  const today = todayLocal(tz)

  async function finish(t: any, outcome: string) {
    try {
      await rpc('log_contact', { p_workshop: wsId, p_client: t.client_id, p_channel: 'telefone', p_kind: 'note', p_message: t.reason, p_outcome: outcome, p_cycle: t.cycle_id, p_task: t.id })
      qc.invalidateQueries({ queryKey: ['contact-tasks'] })
    } catch (e) { toast.error(e) }
  }
  async function assign(t: any, mid: string) {
    const { error } = await supabase.from('contact_tasks').update({ assigned_membership_id: mid || null }).eq('id', t.id)
    if (error) toast.error(error); else qc.invalidateQueries({ queryKey: ['contact-tasks'] })
  }
  async function review(m: any, action: string) {
    const note = prompt(action === 'mark_sent' ? 'Como confirmou que a mensagem foi enviada?' : 'Observação:') ?? ''
    try { await rpc('review_message', { p_message: m.id, p_action: action, p_note: note }); qc.invalidateQueries({ queryKey: ['message-queue'] }) } catch (e) { toast.error(e) }
  }

  return (
    <div>
      <PageHeader title="Contatos e retornos" subtitle="Tarefas com responsável e prazo. Mensagens pelo modo manual são registradas como 'conversa aberta' — o sistema não confirma envio." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'tarefas', label: 'Tarefas de contato' }, ...(can('messages.send') ? [{ key: 'fila', label: 'Fila de mensagens automáticas' }] : [])]} />
      {tab === 'tarefas' && (
        <div className="card">
          <div className="p-3 sm:w-56"><Select label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Abertas</option><option value="done">Concluídas</option><option value="cancelled">Canceladas</option></Select></div>
          {tasks.error ? <div className="p-3"><ErrorBox error={tasks.error} /></div> : tasks.isLoading ? <Loading /> : (
            <Table head={['Prazo', 'Cliente', 'Motivo', 'Responsável', '']} empty={!tasks.data?.length}>
              {tasks.data?.map((t: any) => {
                const wa = waLink(t.clients?.whatsapp_norm ?? t.clients?.phone, `Olá, ${t.clients?.name?.split(' ')[0] ?? ''}!`)
                return (
                  <tr key={t.id}>
                    <td className="td whitespace-nowrap">{fmtDate(t.due_on)} {t.due_on < today && t.status === 'open' && <Badge tone="red">vencida</Badge>}</td>
                    <td className="td"><Link className="text-brand" to={`/clientes/${t.client_id}`}>{t.clients?.name}</Link><br /><span className="text-xs text-slate-500">{t.vehicles?.plate} {t.vehicles?.model}</span></td>
                    <td className="td">{t.reason}{t.notes && <p className="text-xs text-slate-500">{t.notes}</p>}{t.result && <p className="text-xs">Resultado: {t.result}</p>}</td>
                    <td className="td">{can('contacts.edit') && t.status === 'open' ? (
                      <select className="input h-8 py-0" value={t.assigned_membership_id ?? ''} onChange={(e) => assign(t, e.target.value)} aria-label="Responsável">
                        <option value="">—</option>{team.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>) : team.data?.find((m) => m.id === t.assigned_membership_id)?.name}</td>
                    <td className="td">{t.status === 'open' && can('contacts.edit') && <div className="flex flex-wrap justify-end gap-1">
                      {wa && can('messages.send') && <a className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 px-2 text-sm" href={wa} target="_blank" rel="noopener noreferrer"
                        onClick={() => rpc('log_contact', { p_workshop: wsId, p_client: t.client_id, p_channel: 'whatsapp', p_kind: 'conversation_opened', p_message: null, p_outcome: null, p_cycle: t.cycle_id }).catch(() => {})}><MessageCircle className="size-4" />WhatsApp</a>}
                      <select className="input h-8 w-40 py-0" defaultValue="" aria-label="Registrar resultado" onChange={(e) => e.target.value && finish(t, e.target.value)}>
                        <option value="">Registrar resultado…</option><option value="respondeu">Respondeu</option><option value="agendou">Agendou</option><option value="adiou">Adiou</option>
                        <option value="recusou">Recusou</option><option value="sem_resposta">Sem resposta</option><option value="pediu_pausa">Pediu para parar</option><option value="resolvido">Resolvido</option>
                      </select>
                    </div>}</td>
                  </tr>
                )
              })}
            </Table>
          )}
        </div>
      )}
      {tab === 'fila' && (
        <Card title="Fila de mensagens">
          <p className="mb-3 text-xs text-slate-500">"Entregue" e "Lido" só aparecem com confirmação real do provedor (webhook). "Envio incerto" exige revisão manual antes de reenviar.</p>
          {queue.isLoading ? <Loading /> : queue.error ? <ErrorBox error={queue.error} /> : (
            <Table head={['Criada', 'Cliente', 'Mensagem', 'Situação', '']} empty={!queue.data?.length}>
              {queue.data?.map((m: any) => (
                <tr key={m.id}>
                  <td className="td whitespace-nowrap">{fmtDateTime(m.created_at, tz)}</td><td className="td">{m.clients?.name}</td>
                  <td className="td max-w-md"><p className="line-clamp-2 text-xs">{m.rendered_body}</p>{m.last_error && <p className="text-xs text-red-600">{m.last_error}</p>}</td>
                  <td className="td"><StatusBadge map={messageStatus} value={m.status} /><span className="block text-xs text-slate-500">{m.attempts} tentativa(s)</span></td>
                  <td className="td"><div className="flex gap-1">
                    {['failed', 'uncertain'].includes(m.status) && <Button size="sm" variant="secondary" onClick={() => review(m, 'retry')}>Reenviar</Button>}
                    {m.status === 'uncertain' && <Button size="sm" variant="secondary" onClick={() => review(m, 'mark_sent')}>Confirmar enviado</Button>}
                    {['pending', 'failed', 'uncertain'].includes(m.status) && <Button size="sm" variant="ghost" onClick={() => review(m, 'cancel')}>Cancelar</Button>}
                  </div></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </div>
  )
}

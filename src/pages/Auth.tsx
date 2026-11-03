import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Button, ErrorBox, Input, Loading } from '@/components/ui'
import { errorMessage } from '@/lib/errors'
import { roleLabel } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-navy-900 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-xl">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand">MecGest 360</p>
        <h1 className="mb-4 mt-1 text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  )
}

export function Login() {
  const { session } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (session) return <Navigate to="/" replace />

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    if (mode === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setMsg({ ok: false, text: error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : errorMessage(error) })
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/redefinir-senha` })
      // mesma resposta exista ou não a conta (evita enumeração de e-mails)
      setMsg(error && !/rate/i.test(error.message) ? { ok: false, text: errorMessage(error) }
        : { ok: true, text: 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.' })
    }
    setBusy(false)
  }

  return (
    <Shell title={mode === 'login' ? 'Entrar' : 'Recuperar senha'}>
      <form onSubmit={submit} className="space-y-3">
        <Input label="E-mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode === 'login' && <Input label="Senha" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
        {msg && <p role="alert" className={msg.ok ? 'text-sm text-emerald-700' : 'text-sm text-red-600'}>{msg.text}</p>}
        <Button type="submit" loading={busy} className="w-full">{mode === 'login' ? 'Entrar' : 'Enviar link'}</Button>
        <button type="button" className="w-full text-center text-sm text-brand hover:underline" onClick={() => { setMode(mode === 'login' ? 'forgot' : 'login'); setMsg(null) }}>
          {mode === 'login' ? 'Esqueci minha senha' : 'Voltar ao login'}
        </button>
      </form>
    </Shell>
  )
}

export function ResetPassword() {
  const { session, loading } = useAuth()
  const nav = useNavigate()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (loading) return <Loading />
  if (!session) return <Shell title="Link inválido"><p className="text-sm text-slate-600">O link expirou ou já foi usado. Solicite um novo na tela de login.</p></Shell>
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (pw.length < 10) return setErr('Use pelo menos 10 caracteres.')
    if (pw !== pw2) return setErr('As senhas não conferem.')
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) return setErr(errorMessage(error))
    nav('/', { replace: true })
  }
  return (
    <Shell title="Definir nova senha">
      <form onSubmit={submit} className="space-y-3">
        <Input label="Nova senha" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint="Mínimo de 10 caracteres." />
        <Input label="Confirmar senha" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <Button type="submit" loading={busy} className="w-full">Salvar senha</Button>
      </form>
    </Shell>
  )
}

/** Aceite de convite: token no fragmento (#t=...), nunca enviado ao servidor web. */
export function AcceptInvite() {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? ''
  const { session, refresh, selectWorkshop } = useAuth()
  const nav = useNavigate()
  const info = useQuery({ queryKey: ['invite', token], enabled: !!token, queryFn: () => rpc<any[]>('invite_info', { p_token: token }) })
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inv = info.data?.[0]

  if (!token) return <Shell title="Convite"><p className="text-sm">Link de convite incompleto.</p></Shell>
  if (info.isLoading) return <Loading />
  if (info.error) return <Shell title="Convite"><ErrorBox error={info.error} /></Shell>
  if (!inv || !inv.valid) return <Shell title="Convite inválido"><p className="text-sm text-slate-600">Este convite expirou, foi revogado ou já foi utilizado. Peça um novo ao responsável.</p></Shell>

  async function accept(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      // o link do e-mail de convite já autentica a pessoa; aqui ela define a senha
      if (!session) throw new Error('Abra o link recebido por e-mail para entrar e depois volte a esta página.')
      if (session.user.email?.toLowerCase() !== inv.email) throw new Error(`Você está conectado como ${session.user.email}. Este convite é para ${inv.email}.`)
      if (pw) {
        if (pw.length < 10) throw new Error('Senha com pelo menos 10 caracteres.')
        const { error } = await supabase.auth.updateUser({ password: pw, data: { full_name: inv.full_name } })
        if (error) throw error
      }
      const wsId = await rpc<string>('accept_invite', { p_token: token })
      history.replaceState(null, '', '/convite')
      selectWorkshop(wsId); refresh(); nav('/', { replace: true })
    } catch (e2) { setErr(errorMessage(e2)) } finally { setBusy(false) }
  }

  return (
    <Shell title={`Convite: ${inv.workshop_name}`}>
      <p className="mb-3 text-sm text-slate-600">Olá, {inv.full_name}. Você foi convidado(a) como <strong>{roleLabel[inv.role]}</strong> ({inv.email}).</p>
      <form onSubmit={accept} className="space-y-3">
        <Input label="Defina sua senha" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint="Mínimo de 10 caracteres. Cada pessoa tem sua própria conta." />
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <Button type="submit" loading={busy} className="w-full">Aceitar convite</Button>
      </form>
    </Shell>
  )
}

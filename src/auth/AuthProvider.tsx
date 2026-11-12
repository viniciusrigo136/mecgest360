import type { Session } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { publicLogin, rpc, supabase } from '@/lib/supabase'

export type Workshop = {
  workshop_id: string; name: string; role: string; primary_color: string; logo_path: string | null
  timezone: string; is_demo: boolean; membership_id: string; order_scope: 'assigned' | 'all'
}

type Ctx = {
  session: Session | null
  loading: boolean
  loginError: string | null
  workshops: Workshop[]
  ws: Workshop | null
  wsId: string
  tz: string
  perms: Set<string>
  can: (p: string) => boolean
  selectWorkshop: (id: string) => void
  refresh: () => void
}

const AuthCtx = createContext<Ctx | null>(null)
const WS_KEY = 'mecgest.workshop'

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [wsId, setWsId] = useState<string>(() => { try { return localStorage.getItem(WS_KEY) ?? '' } catch { return '' } })

  useEffect(() => {
    // Modo público: entra sozinho com a conta compartilhada quando não há sessão.
    const autoLogin = async () => {
      if (!publicLogin) return
      const { error } = await supabase.auth.signInWithPassword(publicLogin)
      setLoginError(!error ? null
        : /invalid login/i.test(error.message) ? 'Entrada automática recusada: o e-mail ou a senha configurados na Vercel não batem com nenhuma conta do sistema.'
        : /not confirmed/i.test(error.message) ? 'Entrada automática recusada: o e-mail da conta compartilhada ainda não foi confirmado.'
        : `Não foi possível abrir o sistema automaticamente (${error.message}).`)
    }
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) await autoLogin()
      else setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((e, s) => {
      setSession(s)
      if (!s) qc.clear()   // não manter dados de outra sessão em cache
      if (!s && e === 'SIGNED_OUT') void autoLogin()
    })
    return () => data.subscription.unsubscribe()
  }, [qc])

  const uid = session?.user.id
  const workshopsQ = useQuery({
    queryKey: ['my_workshops', uid],
    enabled: !!uid,
    queryFn: () => rpc<Workshop[]>('my_workshops'),
  })
  const workshops = useMemo(() => workshopsQ.data ?? [], [workshopsQ.data])
  const ws = workshops.find((w) => w.workshop_id === wsId) ?? workshops[0] ?? null

  const permsQ = useQuery({
    queryKey: ['my_permissions', uid, ws?.workshop_id],
    enabled: !!ws,
    queryFn: () => rpc<string[]>('my_permissions', { p_workshop: ws!.workshop_id }),
    // permissões revalidadas com frequência: bloqueio/alteração tem efeito rápido na interface
    refetchInterval: 60_000,
  })

  useEffect(() => {
    if (ws) document.documentElement.style.setProperty('--brand', ws.primary_color)
  }, [ws])

  const perms = useMemo(() => new Set(permsQ.data ?? []), [permsQ.data])
  const value: Ctx = {
    session,
    loginError,
    loading: !ready || (!!uid && (workshopsQ.isLoading || (!!ws && permsQ.isLoading))),
    workshops,
    ws,
    wsId: ws?.workshop_id ?? '',
    tz: ws?.timezone ?? 'America/Sao_Paulo',
    perms,
    can: (p) => perms.has(p),
    selectWorkshop: (id) => { try { localStorage.setItem(WS_KEY, id) } catch { /* armazenamento indisponível */ } setWsId(id); qc.invalidateQueries() },
    refresh: () => { workshopsQ.refetch(); permsQ.refetch() },
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const c = useContext(AuthCtx)
  if (!c) throw new Error('useAuth fora do AuthProvider')
  return c
}

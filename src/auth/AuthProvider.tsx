import type { Session } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { rpc, supabase } from '@/lib/supabase'

export type Workshop = {
  workshop_id: string; name: string; role: string; primary_color: string; logo_path: string | null
  timezone: string; is_demo: boolean; membership_id: string; order_scope: 'assigned' | 'all'
}

type Ctx = {
  session: Session | null
  loading: boolean
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
  const [wsId, setWsId] = useState<string>(() => { try { return localStorage.getItem(WS_KEY) ?? '' } catch { return '' } })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) qc.clear()   // não manter dados de outra sessão em cache
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

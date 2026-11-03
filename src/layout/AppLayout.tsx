import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  BarChart3, Boxes, Calendar, Car, ClipboardList, FileText, Gauge, LogOut, Menu, MessageCircle, Search, Settings,
  ShoppingCart, Users, UsersRound, Wallet, Wrench, X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { roleLabel } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'

const NAV = [
  { to: '/', label: 'Visão geral', icon: Gauge, perm: 'dashboard.view' },
  { to: '/agenda', label: 'Agenda', icon: Calendar, perm: 'schedule.view' },
  { to: '/os', label: 'Ordens de serviço', icon: Wrench, perm: 'orders.view' },
  { to: '/clientes', label: 'Clientes', icon: Users, perm: 'clients.view' },
  { to: '/veiculos', label: 'Veículos', icon: Car, perm: 'vehicles.view' },
  { to: '/orcamentos', label: 'Orçamentos', icon: FileText, perm: 'quotes.view' },
  { to: '/preventiva', label: 'Manutenção preventiva', icon: ClipboardList, perm: 'maintenance.view' },
  { to: '/contatos', label: 'Contatos e retornos', icon: MessageCircle, perm: 'contacts.view' },
  { to: '/estoque', label: 'Estoque', icon: Boxes, perm: 'inventory.view' },
  { to: '/compras', label: 'Compras e fornecedores', icon: ShoppingCart, perm: 'purchasing.view' },
  { to: '/financeiro', label: 'Financeiro', icon: Wallet, perm: 'finance.view' },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, perm: 'reports.view' },
  { to: '/equipe', label: 'Equipe', icon: UsersRound, perm: 'team.view' },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, perm: 'settings.manage' },
]

export function AppLayout() {
  const { ws, workshops, selectWorkshop, can, session } = useAuth()
  const [open, setOpen] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const loc = useLocation()
  useEffect(() => setOpen(false), [loc.pathname])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  const items = NAV.filter((n) => can(n.perm) || (n.to === '/financeiro' && can('cash.operate')))

  return (
    <div className="flex min-h-dvh">
      <aside className={clsx('no-print fixed inset-y-0 left-0 z-40 w-64 transform bg-navy-900 text-slate-200 transition-transform lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-14 items-center justify-between border-b border-navy-800 px-4">
          <span className="truncate font-semibold text-white">{ws?.name ?? 'MecGest 360'}</span>
          <button className="lg:hidden" aria-label="Fechar menu" onClick={() => setOpen(false)}><X className="size-5" /></button>
        </div>
        {workshops.length > 1 && (
          <div className="border-b border-navy-800 p-3">
            <label className="sr-only" htmlFor="ws-select">Oficina</label>
            <select id="ws-select" className="w-full rounded bg-navy-800 px-2 py-1.5 text-sm" value={ws?.workshop_id}
              onChange={(e) => selectWorkshop(e.target.value)}>
              {workshops.map((w) => <option key={w.workshop_id} value={w.workshop_id}>{w.name}</option>)}
            </select>
          </div>
        )}
        <nav className="flex flex-col gap-0.5 overflow-y-auto p-2" aria-label="Principal">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}
              className={({ isActive }) => clsx('flex items-center gap-3 rounded-md px-3 py-2 text-sm',
                isActive ? 'bg-brand text-white' : 'text-slate-300 hover:bg-navy-800 hover:text-white')}>
              <n.icon className="size-4 shrink-0" aria-hidden />{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-navy-800 p-3 text-xs text-slate-400">
          <p className="truncate">{session?.user.email}</p>
          <p>{roleLabel[ws?.role ?? ''] ?? ''}{ws?.is_demo && ' · ambiente de demonstração'}</p>
          <button onClick={() => supabase.auth.signOut()} className="mt-2 inline-flex items-center gap-1.5 text-slate-300 hover:text-white">
            <LogOut className="size-3.5" />Sair
          </button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-3 sm:px-4">
          <button className="lg:hidden" aria-label="Abrir menu" onClick={() => setOpen(true)}><Menu className="size-5" /></button>
          <GlobalSearch />
        </header>
        {!online && (
          <div role="alert" className="bg-amber-100 px-4 py-2 text-sm text-amber-900">
            Sem conexão. Nada é salvo enquanto estiver offline — as alterações dependem da reconexão.
          </div>
        )}
        {ws?.is_demo && <div className="bg-violet-50 px-4 py-1 text-center text-xs text-violet-800">Ambiente de demonstração — dados fictícios</div>}
        <main className="mx-auto w-full max-w-7xl flex-1 p-3 sm:p-5"><Outlet /></main>
      </div>
    </div>
  )
}

type Hit = { kind: string; id: string; title: string; subtitle: string; client_id: string | null; vehicle_id: string | null }

function GlobalSearch() {
  const { wsId, can } = useAuth()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [focus, setFocus] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t) }, [q])
  const { data } = useQuery({
    queryKey: ['search', wsId, debounced],
    enabled: debounced.length >= 2,
    queryFn: async () => {
      const [cv, orders] = await Promise.all([
        can('clients.view') || can('vehicles.view') ? rpc<Hit[]>('search_clients_vehicles', { p_workshop: wsId, p_q: debounced, p_limit: 8 }) : [],
        can('orders.view') ? rpc<any[]>('orders_board', { p_workshop: wsId, p_q: debounced, p_limit: 5 }) : [],
      ])
      return { cv, orders }
    },
  })
  const go = (path: string) => { setQ(''); setFocus(false); nav(path) }
  const show = focus && debounced.length >= 2 && data
  return (
    <div className="relative max-w-xl flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
        placeholder="Buscar placa, cliente, telefone ou nº da OS" aria-label="Busca rápida"
        className="input pl-9" />
      {show && (
        <div className="absolute inset-x-0 top-11 z-30 max-h-96 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {data.orders.map((o) => (
            <button key={o.id} onMouseDown={() => go(`/os/${o.id}`)} className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
              <span className="font-medium">{o.number}</span> · {o.plate} · {o.client_name}
            </button>
          ))}
          {data.cv.map((h) => (
            <button key={h.kind + h.id} onMouseDown={() => go(h.kind === 'vehicle' ? `/veiculos/${h.id}` : `/clientes/${h.id}`)}
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50">
              <span className="font-medium">{h.title}</span> <span className="text-slate-500">· {h.subtitle}</span>
            </button>
          ))}
          {!data.orders.length && !data.cv.length && <p className="px-3 py-2 text-sm text-slate-500">Nada encontrado.</p>}
        </div>
      )}
    </div>
  )
}

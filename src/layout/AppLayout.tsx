import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  BarChart3, Car, CarFront, FileText, Home, LogOut, Moon, Plus, Search, Settings, Sun, UserPlus, Users, Wrench, X, type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Modal } from '@/components/ui'
import { fmtPlate } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'
import { applyTheme, getTheme, type Theme } from '@/lib/theme'

type Item = { to: string; label: string; icon: LucideIcon; perm: string }

// Menu enxuto (padrão ChapGest). Ferramentas avançadas ficam em Configurações.
const NAV: Item[] = [
  { to: '/', label: 'Início', icon: Home, perm: 'dashboard.view' },
  { to: '/orcamentos', label: 'Orçamentos', icon: FileText, perm: 'quotes.view' },
  { to: '/os', label: 'Serviços', icon: Wrench, perm: 'orders.view' },
  { to: '/indicadores', label: 'Indicadores', icon: BarChart3, perm: 'reports.view' },
  { to: '/clientes', label: 'Clientes', icon: Users, perm: 'clients.view' },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, perm: 'settings.manage' },
]

export function AppLayout() {
  const { ws, workshops, selectWorkshop, can, session } = useAuth()
  const [newOpen, setNewOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [theme, setTheme] = useState<Theme>(getTheme)
  const loc = useLocation()
  useEffect(() => { setNewOpen(false); setSearching(false) }, [loc.pathname])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  const items = NAV.filter((i) => can(i.perm))
  const tabs = items.filter((i) => ['/', '/orcamentos', '/os', '/clientes'].includes(i.to))
  const canNew = can('orders.create') || can('quotes.create') || can('clients.create')
  const toggleTheme = () => { const t = theme === 'dark' ? 'light' : 'dark'; applyTheme(t); setTheme(t) }

  return (
    <div className="min-h-dvh lg:pl-72">
      {/* Menu lateral (computador) */}
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-72 flex-col border-r border-slate-200 bg-card lg:flex">
        <div className="flex items-center gap-3 px-5 pb-4 pt-6">
          <Logo />
          <p className="min-w-0 truncate font-heading text-xl font-extrabold uppercase">{ws?.name ?? 'MecGest 360'}</p>
        </div>
        {canNew && (
          <div className="px-4 pb-3">
            <button onClick={() => setNewOpen(true)} className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-lg font-semibold text-white shadow-md shadow-brand/30 active:scale-[0.98]">
              <Plus className="size-5" />Novo
            </button>
          </div>
        )}
        {workshops.length > 1 && (
          <div className="px-4 pb-2">
            <select className="input" aria-label="Oficina" value={ws?.workshop_id} onChange={(e) => selectWorkshop(e.target.value)}>
              {workshops.map((w) => <option key={w.workshop_id} value={w.workshop_id}>{w.name}</option>)}
            </select>
          </div>
        )}
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-4 py-1" aria-label="Principal">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => clsx('flex items-center gap-3.5 rounded-xl px-4 py-3 text-[17px] font-medium',
              isActive ? 'bg-brand-soft text-brand-strong' : 'text-slate-700 hover:bg-slate-100')}>
              <n.icon className="size-[22px] shrink-0" aria-hidden />{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-slate-500">Aparência</span>
            <button onClick={toggleTheme} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-medium">
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}{theme === 'dark' ? 'Modo claro' : 'Modo escuro'}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500">
            <span className="truncate">{session?.user.email}</span>
            <button onClick={() => supabase.auth.signOut()} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-slate-100"><LogOut className="size-3.5" />Sair</button>
          </div>
        </div>
      </aside>

      {/* Topo (celular) e busca */}
      <header className="no-print sticky top-0 z-20 border-b border-slate-200 bg-card/95 backdrop-blur lg:border-0 lg:bg-transparent lg:backdrop-blur-none" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 lg:h-16 lg:px-8">
          <Link to="/" className="flex min-w-0 items-center gap-2 lg:hidden"><Logo /><span className="truncate font-heading text-base font-extrabold uppercase">{ws?.name ?? 'MecGest 360'}</span></Link>
          <div className="hidden flex-1 lg:block"><GlobalSearch /></div>
          <div className="ml-auto flex items-center lg:hidden">
            <IconBtn label="Buscar" onClick={() => setSearching((v) => !v)}>{searching ? <X className="size-5" /> : <Search className="size-5" />}</IconBtn>
            {can('reports.view') && <IconBtn label="Indicadores" to="/indicadores"><BarChart3 className="size-5" /></IconBtn>}
            {can('settings.manage')
              ? <IconBtn label="Configurações" to="/configuracoes"><Settings className="size-5" /></IconBtn>
              : <IconBtn label="Sair" onClick={() => supabase.auth.signOut()}><LogOut className="size-5" /></IconBtn>}
          </div>
        </div>
        {searching && <div className="px-4 pb-3 lg:hidden"><GlobalSearch autoFocus /></div>}
      </header>

      {!online && <div role="alert" className="bg-amber-50 px-4 py-2 text-sm text-amber-800">Sem internet. O que você fizer agora não será salvo até a conexão voltar.</div>}

      <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-4 lg:px-8 lg:pb-10 lg:pt-2">
        <Outlet />
      </main>

      {/* Barra inferior (celular) com o "+" no meio */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-card/95 backdrop-blur lg:hidden" aria-label="Principal"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto flex max-w-xl items-stretch">
          {tabs.slice(0, 2).map((t) => <Tab key={t.to} item={t} />)}
          {canNew && (
            <div className="flex flex-1 items-center justify-center">
              <button onClick={() => setNewOpen(true)} aria-label="Novo" className="-mt-5 flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-lg shadow-brand/30 active:scale-95">
                <Plus className="size-7" />
              </button>
            </div>
          )}
          {tabs.slice(2).map((t) => <Tab key={t.to} item={t} />)}
        </div>
      </nav>

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="O que você quer fazer?">
        <div className="grid gap-2">
          {can('orders.create') && <NewOption to="/receber" icon={CarFront} title="Receber carro" sub="O carro chegou na oficina" />}
          {can('quotes.create') && <NewOption to="/orcamentos/novo" icon={FileText} title="Fazer orçamento" sub="Serviços e valor para mandar ao cliente" />}
          {can('clients.create') && <NewOption to="/clientes?novo=1" icon={UserPlus} title="Novo cliente" sub="Cadastrar cliente e carro" />}
        </div>
      </Modal>
    </div>
  )
}

function Tab({ item }: { item: Item }) {
  return (
    <NavLink to={item.to} end={item.to === '/'} className={({ isActive }) => clsx('flex min-h-16 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
      isActive ? 'text-brand' : 'text-slate-500')}>
      {({ isActive }) => <><span className={clsx('rounded-full px-4 py-1', isActive && 'bg-brand-soft')}><item.icon className="size-5" aria-hidden /></span>{item.label}</>}
    </NavLink>
  )
}

function NewOption({ to, icon: I, title, sub }: { to: string; icon: LucideIcon; title: string; sub: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-4 active:bg-slate-50">
      <span className="flex size-12 items-center justify-center rounded-xl bg-brand-soft text-brand"><I className="size-6" /></span>
      <span><span className="block font-heading text-lg font-bold">{title}</span><span className="text-sm text-slate-500">{sub}</span></span>
    </Link>
  )
}

function Logo() {
  return <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand text-white lg:size-12" aria-hidden><CarFront className="size-6" /></span>
}

function IconBtn({ label, onClick, to, children }: { label: string; onClick?: () => void; to?: string; children: React.ReactNode }) {
  const cls = 'flex size-10 items-center justify-center rounded-full text-slate-600 active:bg-slate-100'
  return to ? <Link to={to} aria-label={label} className={cls}>{children}</Link> : <button aria-label={label} onClick={onClick} className={cls}>{children}</button>
}

type Hit = { kind: string; id: string; title: string; subtitle: string; client_id: string | null; vehicle_id: string | null }

function GlobalSearch({ autoFocus }: { autoFocus?: boolean }) {
  const { wsId, can } = useAuth()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [focus, setFocus] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
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
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
        placeholder="Buscar placa, cliente ou nº do serviço" aria-label="Busca rápida" className="input rounded-full bg-card pl-10" />
      {show && (
        <div className="absolute inset-x-0 top-12 z-30 max-h-96 overflow-y-auto rounded-2xl border border-slate-200 bg-card shadow-lg">
          {data.orders.map((o) => (
            <button key={o.id} onMouseDown={() => go(`/os/${o.id}`)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50">
              <Wrench className="size-4 text-slate-400" /><span className="plate">{fmtPlate(o.plate)}</span><span className="truncate text-slate-500">{o.vehicle_label} · {o.client_name}</span>
            </button>
          ))}
          {data.cv.map((h) => (
            <button key={h.kind + h.id} onMouseDown={() => go(h.kind === 'vehicle' ? `/veiculos/${h.id}` : `/clientes/${h.id}`)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50">
              {h.kind === 'vehicle' ? <Car className="size-4 text-slate-400" /> : <Users className="size-4 text-slate-400" />}
              <span className="font-medium">{h.title}</span><span className="truncate text-slate-500">{h.subtitle}</span>
            </button>
          ))}
          {!data.orders.length && !data.cv.length && <p className="px-4 py-3 text-sm text-slate-500">Nada encontrado.</p>}
        </div>
      )}
    </div>
  )
}

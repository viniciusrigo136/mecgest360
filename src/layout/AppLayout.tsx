import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  BarChart3, Boxes, Calendar, Car, CarFront, ClipboardList, FileText, Home, LogOut, Menu, MessageCircle, Moon, Search,
  Settings, ShoppingCart, Sun, Users, UsersRound, Wallet, Wrench, X, type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { fmtPlate } from '@/lib/format'
import { roleLabel } from '@/lib/labels'
import { rpc, supabase } from '@/lib/supabase'
import { applyTheme, getTheme, type Theme } from '@/lib/theme'

type Item = { to: string; label: string; icon: LucideIcon; perm: string | string[] }

const NAV: Item[] = [
  { to: '/', label: 'Início', icon: Home, perm: 'dashboard.view' },
  { to: '/orcamentos', label: 'Orçamentos', icon: FileText, perm: 'quotes.view' },
  { to: '/os', label: 'Serviços', icon: Wrench, perm: 'orders.view' },
  { to: '/clientes', label: 'Clientes', icon: Users, perm: 'clients.view' },
  { to: '/agenda', label: 'Agenda', icon: Calendar, perm: 'schedule.view' },
  { to: '/veiculos', label: 'Veículos', icon: Car, perm: 'vehicles.view' },
  { to: '/preventiva', label: 'Retornos preventivos', icon: ClipboardList, perm: 'maintenance.view' },
  { to: '/contatos', label: 'Contatos', icon: MessageCircle, perm: 'contacts.view' },
  { to: '/estoque', label: 'Estoque', icon: Boxes, perm: 'inventory.view' },
  { to: '/compras', label: 'Compras', icon: ShoppingCart, perm: 'purchasing.view' },
  { to: '/financeiro', label: 'Financeiro', icon: Wallet, perm: ['finance.view', 'cash.operate'] },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, perm: 'reports.view' },
  { to: '/equipe', label: 'Equipe', icon: UsersRound, perm: 'team.view' },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, perm: 'settings.manage' },
]

export function AppLayout() {
  const { ws, workshops, selectWorkshop, can, session } = useAuth()
  const [more, setMore] = useState(false)
  const [searching, setSearching] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [theme, setTheme] = useState<Theme>(getTheme)
  const loc = useLocation()
  useEffect(() => { setMore(false); setSearching(false) }, [loc.pathname])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  const allowed = (i: Item) => (Array.isArray(i.perm) ? i.perm.some(can) : can(i.perm))
  const items = NAV.filter(allowed)
  const tabs = items.slice(0, 4)
  const rest = items.slice(4)
  const toggleTheme = () => { const t = theme === 'dark' ? 'light' : 'dark'; applyTheme(t); setTheme(t) }

  return (
    <div className="min-h-dvh lg:pl-64">
      {/* Menu lateral (computador) */}
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-slate-200 bg-card lg:flex">
        <Brand name={ws?.name} />
        {workshops.length > 1 && <WorkshopSelect value={ws?.workshop_id} options={workshops} onChange={selectWorkshop} />}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2" aria-label="Principal">
          {items.map((n) => <SideLink key={n.to} item={n} />)}
        </nav>
        <UserBox email={session?.user.email} role={roleLabel[ws?.role ?? '']} theme={theme} onTheme={toggleTheme} />
      </aside>

      {/* Topo */}
      <header className="no-print sticky top-0 z-20 border-b border-slate-200 bg-card/95 backdrop-blur" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 lg:px-8">
          <Link to="/" className="flex items-center gap-2 lg:hidden"><Logo /><span className="max-w-[45vw] truncate font-heading text-base font-bold">{ws?.name ?? 'MecGest 360'}</span></Link>
          <div className="hidden flex-1 lg:block"><GlobalSearch /></div>
          <div className="ml-auto flex items-center gap-1 lg:hidden">
            <IconBtn label="Buscar" onClick={() => setSearching((v) => !v)}>{searching ? <X className="size-5" /> : <Search className="size-5" />}</IconBtn>
            {can('settings.manage') && <IconBtn label="Configurações" to="/configuracoes"><Settings className="size-5" /></IconBtn>}
          </div>
        </div>
        {searching && <div className="px-4 pb-3 lg:hidden"><GlobalSearch autoFocus /></div>}
      </header>

      {!online && <div role="alert" className="bg-amber-50 px-4 py-2 text-sm text-amber-800">Sem conexão. Nada é salvo enquanto estiver offline — as alterações dependem da reconexão.</div>}
      {ws?.is_demo && <div className="bg-violet-50 px-4 py-1 text-center text-xs text-violet-700">Ambiente de demonstração — dados fictícios</div>}

      <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-4 lg:px-8 lg:pb-10 lg:pt-6">
        <Outlet />
      </main>

      {/* Barra inferior (celular) */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-card/95 backdrop-blur lg:hidden" aria-label="Principal"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto grid max-w-xl" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.to === '/'} className={({ isActive }) => clsx('flex min-h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
              isActive ? 'text-brand' : 'text-slate-500')}>
              {({ isActive }) => <><span className={clsx('rounded-full px-4 py-1', isActive && 'bg-brand-soft')}><t.icon className="size-5" aria-hidden /></span>{t.label}</>}
            </NavLink>
          ))}
          <button onClick={() => setMore(true)} className="flex min-h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-slate-500">
            <span className="px-4 py-1"><Menu className="size-5" aria-hidden /></span>Mais
          </button>
        </div>
      </nav>

      {/* Folha "Mais" (celular) */}
      {more && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Mais opções">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setMore(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-card p-4" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-slate-200" />
            {workshops.length > 1 && <WorkshopSelect value={ws?.workshop_id} options={workshops} onChange={selectWorkshop} />}
            <div className="grid grid-cols-3 gap-2">
              {rest.map((n) => (
                <Link key={n.to} to={n.to} className="flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-md border border-slate-200 p-2 text-center text-xs font-medium active:bg-slate-50">
                  <n.icon className="size-5 text-brand" aria-hidden />{n.label}
                </Link>
              ))}
            </div>
            <UserBox email={session?.user.email} role={roleLabel[ws?.role ?? '']} theme={theme} onTheme={toggleTheme} />
          </div>
        </div>
      )}
    </div>
  )
}

function Logo() {
  return <span className="flex size-8 items-center justify-center rounded-[9px] bg-brand text-white" aria-hidden><CarFront className="size-[18px]" /></span>
}

function Brand({ name }: { name?: string }) {
  return (
    <div className="flex h-16 items-center gap-2.5 border-b border-slate-200 px-5">
      <Logo />
      <div className="min-w-0">
        <p className="font-heading text-[15px] font-extrabold leading-tight">MecGest <span className="text-brand">360</span></p>
        <p className="truncate text-xs text-slate-500">{name}</p>
      </div>
    </div>
  )
}

function SideLink({ item }: { item: Item }) {
  return (
    <NavLink to={item.to} end={item.to === '/'} className={({ isActive }) => clsx('flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium',
      isActive ? 'bg-brand-soft text-brand-strong' : 'text-slate-600 hover:bg-slate-100 hover:text-ink')}>
      <item.icon className="size-[18px] shrink-0" aria-hidden />{item.label}
    </NavLink>
  )
}

function WorkshopSelect({ value, options, onChange }: { value?: string; options: { workshop_id: string; name: string }[]; onChange: (id: string) => void }) {
  return (
    <div className="px-3 py-3">
      <label className="label" htmlFor="ws-select">Oficina</label>
      <select id="ws-select" className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((w) => <option key={w.workshop_id} value={w.workshop_id}>{w.name}</option>)}
      </select>
    </div>
  )
}

function UserBox({ email, role, theme, onTheme }: { email?: string; role?: string; theme: Theme; onTheme: () => void }) {
  return (
    <div className="mt-4 border-t border-slate-200 p-3 text-xs text-slate-500 lg:mt-0">
      <p className="truncate font-medium text-slate-700">{email}</p>
      <p>{role}</p>
      <div className="mt-2 flex gap-2">
        <button onClick={onTheme} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 hover:bg-slate-100">
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}{theme === 'dark' ? 'Modo claro' : 'Modo escuro'}
        </button>
        <button onClick={() => supabase.auth.signOut()} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 hover:bg-slate-100"><LogOut className="size-4" />Sair</button>
      </div>
    </div>
  )
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
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
        placeholder="Placa, nome, telefone ou nº da OS" aria-label="Busca rápida" className="input rounded-full bg-slate-50 pl-9" />
      {show && (
        <div className="absolute inset-x-0 top-12 z-30 max-h-96 overflow-y-auto rounded-md border border-slate-200 bg-card shadow-lg">
          {data.orders.map((o) => (
            <button key={o.id} onMouseDown={() => go(`/os/${o.id}`)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50">
              <Wrench className="size-4 text-slate-400" /><span className="font-medium">{o.number}</span><span className="plate">{fmtPlate(o.plate)}</span><span className="truncate text-slate-500">{o.client_name}</span>
            </button>
          ))}
          {data.cv.map((h) => (
            <button key={h.kind + h.id} onMouseDown={() => go(h.kind === 'vehicle' ? `/veiculos/${h.id}` : `/clientes/${h.id}`)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50">
              {h.kind === 'vehicle' ? <Car className="size-4 text-slate-400" /> : <Users className="size-4 text-slate-400" />}
              <span className="font-medium">{h.title}</span><span className="truncate text-slate-500">{h.subtitle}</span>
            </button>
          ))}
          {!data.orders.length && !data.cv.length && <p className="px-3 py-2 text-sm text-slate-500">Nada encontrado.</p>}
        </div>
      )}
    </div>
  )
}

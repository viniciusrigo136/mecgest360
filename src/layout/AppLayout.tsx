import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  BarChart3, BellRing, Boxes, Calendar, Car, CarFront, ClipboardList, FileText, Home, LogOut, Menu, MessageCircle, Moon, Plus, Search,
  Settings, ShoppingCart, Sun, UserPlus, Users, UsersRound, Wallet, Wrench, X, type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/auth/AuthProvider'
import { Modal } from '@/components/ui'
import { fmtPlate } from '@/lib/format'
import { rpc, supabase } from '@/lib/supabase'
import { applyTheme, getTheme, type Theme } from '@/lib/theme'

type Item = { to: string; label: string; icon: LucideIcon; perm: string | string[]; badge?: boolean }

// Tudo na barra lateral, em grupos. "Chamar de volta" fica em destaque.
const GROUPS: { title?: string; items: Item[] }[] = [
  { items: [
    { to: '/', label: 'Início', icon: Home, perm: 'dashboard.view' },
    { to: '/os', label: 'Serviços', icon: Wrench, perm: 'orders.view' },
    { to: '/orcamentos', label: 'Orçamentos', icon: FileText, perm: 'quotes.view' },
    { to: '/agenda', label: 'Agenda', icon: Calendar, perm: 'schedule.view' },
    { to: '/clientes', label: 'Clientes', icon: Users, perm: 'clients.view' },
    { to: '/veiculos', label: 'Veículos', icon: Car, perm: 'vehicles.view' },
  ] },
  { title: 'Retorno de clientes', items: [
    { to: '/preventiva', label: 'Chamar de volta', icon: BellRing, perm: 'maintenance.view', badge: true },
    { to: '/contatos', label: 'Contatos', icon: MessageCircle, perm: 'contacts.view' },
  ] },
  { title: 'Gestão', items: [
    { to: '/financeiro', label: 'Financeiro', icon: Wallet, perm: ['finance.view', 'cash.operate'] },
    { to: '/estoque', label: 'Estoque', icon: Boxes, perm: 'inventory.view' },
    { to: '/compras', label: 'Compras', icon: ShoppingCart, perm: 'purchasing.view' },
    { to: '/indicadores', label: 'Indicadores', icon: BarChart3, perm: 'reports.view' },
    { to: '/relatorios', label: 'Relatórios', icon: ClipboardList, perm: 'reports.view' },
  ] },
  { title: 'Oficina', items: [
    { to: '/funcionarios', label: 'Funcionários', icon: UsersRound, perm: 'team.view' },
    { to: '/configuracoes', label: 'Configurações', icon: Settings, perm: 'settings.manage' },
  ] },
]

export function AppLayout() {
  const { ws, workshops, selectWorkshop, can, session } = useAuth()
  const [newOpen, setNewOpen] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [searching, setSearching] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [theme, setTheme] = useState<Theme>(getTheme)
  const loc = useLocation()
  useEffect(() => { setNewOpen(false); setSearching(false); setDrawer(false) }, [loc.pathname])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  const allowed = (i: Item) => (Array.isArray(i.perm) ? i.perm.some(can) : can(i.perm))
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length)
  const tabs = groups.flatMap((g) => g.items).filter((i) => ['/', '/orcamentos', '/os', '/clientes'].includes(i.to))
  const returns = useQuery({
    queryKey: ['returns-count', ws?.workshop_id], enabled: !!ws && can('maintenance.view'), refetchInterval: 300_000,
    queryFn: async () => {
      const d = await rpc<any>('dashboard_summary', { p_workshop: ws!.workshop_id })
      const m = d.maintenance ?? {}
      return ['due_soon', 'overdue_date', 'overdue_km', 'estimated'].reduce((s: number, k) => s + Number(m[k] ?? 0), 0)
    },
  })
  const navList = <SideNav groups={groups} badge={returns.data ?? 0} />
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
        <div className="flex-1 overflow-y-auto px-4 pb-2">{navList}</div>
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
          <button className="-ml-2 flex size-10 items-center justify-center rounded-full text-slate-700 active:bg-slate-100 lg:hidden" aria-label="Abrir menu" onClick={() => setDrawer(true)}><Menu className="size-6" /></button>
          <Link to="/" className="flex min-w-0 items-center gap-2 lg:hidden"><Logo /><span className="truncate font-heading text-base font-extrabold uppercase">{ws?.name ?? 'MecGest 360'}</span></Link>
          <div className="hidden flex-1 lg:block"><GlobalSearch /></div>
          <div className="ml-auto flex items-center lg:hidden">
            <IconBtn label="Buscar" onClick={() => setSearching((v) => !v)}>{searching ? <X className="size-5" /> : <Search className="size-5" />}</IconBtn>
            {can('maintenance.view') && <IconBtn label="Chamar de volta" to="/preventiva"><span className="relative"><BellRing className="size-5" />
              {(returns.data ?? 0) > 0 && <span className="absolute -right-2 -top-1.5 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-4 text-white">{returns.data}</span>}</span></IconBtn>}
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

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[85%] max-w-xs flex-col bg-card" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
            <div className="flex items-center gap-3 px-4 py-4"><Logo /><p className="min-w-0 flex-1 truncate font-heading text-lg font-extrabold uppercase">{ws?.name}</p>
              <button aria-label="Fechar menu" onClick={() => setDrawer(false)} className="flex size-10 items-center justify-center rounded-full bg-slate-100"><X className="size-5" /></button></div>
            <div className="flex-1 overflow-y-auto px-3 pb-3">{navList}</div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 p-3 text-sm">
              <button onClick={toggleTheme} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 px-3">{theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}{theme === 'dark' ? 'Modo claro' : 'Modo escuro'}</button>
              <button onClick={() => supabase.auth.signOut()} className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-slate-600"><LogOut className="size-4" />Sair</button>
            </div>
          </div>
        </div>
      )}

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

function SideNav({ groups, badge }: { groups: { title?: string; items: Item[] }[]; badge: number }) {
  return (
    <nav aria-label="Principal" className="space-y-4">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.title && <p className="px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{g.title}</p>}
          <div className={clsx('flex flex-col gap-0.5', g.title === 'Retorno de clientes' && 'rounded-2xl bg-emerald-50 p-1')}>
            {g.items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => clsx('flex items-center gap-3 rounded-xl px-4 py-2.5 text-[16px] font-medium',
                isActive ? 'bg-brand-soft text-brand-strong' : 'text-slate-700 hover:bg-slate-100')}>
                <n.icon className="size-5 shrink-0" aria-hidden /><span className="flex-1">{n.label}</span>
                {n.badge && badge > 0 && <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">{badge}</span>}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}

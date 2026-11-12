import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { ErrorBox, Loading, NoAccess, ToastProvider } from '@/components/ui'
import { AppLayout } from '@/layout/AppLayout'
import { isConfigured, isPublicMode } from '@/lib/supabase'
// Cada tela vira um arquivo separado: o celular baixa só o que vai abrir.
// Se um arquivo antigo sumir depois de uma atualização, recarrega a página uma vez.
function page<T extends string>(load: () => Promise<Record<T, ComponentType>>, name: T) {
  return lazy(() => load().then((m) => ({ default: m[name] })).catch((e) => {
    const key = 'mecgest.reload-once'
    try { if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, '1'); location.reload() } } catch { /* sem armazenamento */ }
    throw e
  }))
}
const AcceptInvite = page(() => import('@/pages/Auth'), 'AcceptInvite')
const Login = page(() => import('@/pages/Auth'), 'Login')
const ResetPassword = page(() => import('@/pages/Auth'), 'ResetPassword')
const ClientDetail = page(() => import('@/pages/Clients'), 'ClientDetail')
const ClientsPage = page(() => import('@/pages/Clients'), 'ClientsPage')
const ContactsPage = page(() => import('@/pages/Contacts'), 'ContactsPage')
const Dashboard = page(() => import('@/pages/Dashboard'), 'Dashboard')
const FinancePage = page(() => import('@/pages/Finance'), 'FinancePage')
const IndicatorsPage = page(() => import('@/pages/Indicators'), 'IndicatorsPage')
const InventoryPage = page(() => import('@/pages/Inventory'), 'InventoryPage')
const MaintenancePage = page(() => import('@/pages/Maintenance'), 'MaintenancePage')
const NewOrder = page(() => import('@/pages/Orders'), 'NewOrder')
const OrderDetail = page(() => import('@/pages/Orders'), 'OrderDetail')
const OrdersPage = page(() => import('@/pages/Orders'), 'OrdersPage')
const PortalPage = page(() => import('@/pages/Portal'), 'PortalPage')
const QuoteEditor = page(() => import('@/pages/Quotes'), 'QuoteEditor')
const QuotesPage = page(() => import('@/pages/Quotes'), 'QuotesPage')
const ReceivePage = page(() => import('@/pages/Receive'), 'ReceivePage')
const SchedulePage = page(() => import('@/pages/Schedule'), 'SchedulePage')
const SettingsPage = page(() => import('@/pages/Settings'), 'SettingsPage')
const StaffPage = page(() => import('@/pages/Staff'), 'StaffPage')
const VehicleDetail = page(() => import('@/pages/Vehicles'), 'VehicleDetail')
const VehiclesPage = page(() => import('@/pages/Vehicles'), 'VehiclesPage')

function Protected() {
  const { session, loading, ws, loginError } = useAuth()
  if (loading) return <Loading />
  // Se a entrada automática falhar, mostra o login normal (com "Esqueci minha senha") para destravar.
  if (!session && isPublicMode) return loginError
    ? <><div className="mx-auto max-w-sm px-4 pt-6"><ErrorBox error={{ message: loginError }} /></div><S><Login /></S></>
    : <Loading />
  if (!session) return <Navigate to="/entrar" replace />
  if (!ws) return (
    <div className="mx-auto max-w-lg p-8">
      <ErrorBox error={{ message: 'Sua conta não está vinculada a nenhuma oficina ativa (ou seu acesso foi bloqueado). Fale com o responsável pela oficina.' }} />
    </div>
  )
  return <AppLayout />
}

function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Loading />}>{children}</Suspense>
}

function Guard({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth()
  const ok = Array.isArray(perm) ? perm.some(can) : can(perm)
  return ok ? <>{children}</> : <NoAccess />
}

const router = createBrowserRouter([
  { path: '/entrar', element: <S><Login /></S> },
  { path: '/redefinir-senha', element: <S><ResetPassword /></S> },
  { path: '/convite', element: <S><AcceptInvite /></S> },
  { path: '/portal', element: <S><PortalPage /></S> },
  {
    path: '/',
    element: <Protected />,
    children: [
      { index: true, element: <S><Dashboard /></S> },
      { path: 'agenda', element: <Guard perm="schedule.view"><S><SchedulePage /></S></Guard> },
      { path: 'os', element: <Guard perm="orders.view"><S><OrdersPage /></S></Guard> },
      { path: 'os/nova', element: <Guard perm="orders.create"><S><NewOrder /></S></Guard> },
      { path: 'receber', element: <Guard perm="orders.create"><S><ReceivePage /></S></Guard> },
      { path: 'os/:id', element: <Guard perm="orders.view"><S><OrderDetail /></S></Guard> },
      { path: 'clientes', element: <Guard perm="clients.view"><S><ClientsPage /></S></Guard> },
      { path: 'clientes/:id', element: <Guard perm="clients.view"><S><ClientDetail /></S></Guard> },
      { path: 'veiculos', element: <Guard perm="vehicles.view"><S><VehiclesPage /></S></Guard> },
      { path: 'veiculos/:id', element: <Guard perm="vehicles.view"><S><VehicleDetail /></S></Guard> },
      { path: 'orcamentos', element: <Guard perm="quotes.view"><S><QuotesPage /></S></Guard> },
      { path: 'orcamentos/novo', element: <Guard perm="quotes.create"><S><QuoteEditor /></S></Guard> },
      { path: 'orcamentos/:id', element: <Guard perm="quotes.view"><S><QuoteEditor /></S></Guard> },
      { path: 'preventiva', element: <Guard perm="maintenance.view"><S><MaintenancePage /></S></Guard> },
      { path: 'contatos', element: <Guard perm="contacts.view"><S><ContactsPage /></S></Guard> },
      { path: 'estoque', element: <Guard perm="inventory.view"><S><InventoryPage /></S></Guard> },
      { path: 'financeiro', element: <Guard perm={['finance.view', 'cash.operate']}><S><FinancePage /></S></Guard> },
      { path: 'indicadores', element: <Guard perm="reports.view"><S><IndicatorsPage /></S></Guard> },
      { path: 'funcionarios', element: <Guard perm="team.view"><S><StaffPage /></S></Guard> },
      { path: 'configuracoes', element: <Guard perm="settings.manage"><S><SettingsPage /></S></Guard> },
      { path: '*', element: <div className="p-8 text-slate-500">Página não encontrada.</div> },
    ],
  },
])

export default function App() {
  if (!isConfigured) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <ErrorBox error={{ message: 'Configuração ausente: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no arquivo .env.local (veja .env.example).' }} />
      </div>
    )
  }
  return (
    <ToastProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ToastProvider>
  )
}

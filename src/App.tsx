import type { ReactNode } from 'react'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { ErrorBox, Loading, NoAccess, ToastProvider } from '@/components/ui'
import { AppLayout } from '@/layout/AppLayout'
import { isConfigured } from '@/lib/supabase'
import { AcceptInvite, Login, ResetPassword } from '@/pages/Auth'
import { ClientDetail, ClientsPage } from '@/pages/Clients'
import { ContactsPage } from '@/pages/Contacts'
import { Dashboard } from '@/pages/Dashboard'
import { FinancePage } from '@/pages/Finance'
import { IndicatorsPage } from '@/pages/Indicators'
import { InventoryPage } from '@/pages/Inventory'
import { MaintenancePage } from '@/pages/Maintenance'
import { NewOrder, OrderDetail, OrdersPage } from '@/pages/Orders'
import { PortalPage } from '@/pages/Portal'
import { PurchasingPage } from '@/pages/Purchasing'
import { QuoteEditor, QuotesPage } from '@/pages/Quotes'
import { ReceivePage } from '@/pages/Receive'
import { ReportsPage } from '@/pages/Reports'
import { SchedulePage } from '@/pages/Schedule'
import { SettingsPage } from '@/pages/Settings'
import { TeamPage } from '@/pages/Team'
import { VehicleDetail, VehiclesPage } from '@/pages/Vehicles'

function Protected() {
  const { session, loading, ws } = useAuth()
  if (loading) return <Loading />
  if (!session) return <Navigate to="/entrar" replace />
  if (!ws) return (
    <div className="mx-auto max-w-lg p-8">
      <ErrorBox error={{ message: 'Sua conta não está vinculada a nenhuma oficina ativa (ou seu acesso foi bloqueado). Fale com o responsável pela oficina.' }} />
    </div>
  )
  return <AppLayout />
}

function Guard({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth()
  const ok = Array.isArray(perm) ? perm.some(can) : can(perm)
  return ok ? <>{children}</> : <NoAccess />
}

const router = createBrowserRouter([
  { path: '/entrar', element: <Login /> },
  { path: '/redefinir-senha', element: <ResetPassword /> },
  { path: '/convite', element: <AcceptInvite /> },
  { path: '/portal', element: <PortalPage /> },
  {
    path: '/',
    element: <Protected />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'agenda', element: <Guard perm="schedule.view"><SchedulePage /></Guard> },
      { path: 'os', element: <Guard perm="orders.view"><OrdersPage /></Guard> },
      { path: 'os/nova', element: <Guard perm="orders.create"><NewOrder /></Guard> },
      { path: 'receber', element: <Guard perm="orders.create"><ReceivePage /></Guard> },
      { path: 'os/:id', element: <Guard perm="orders.view"><OrderDetail /></Guard> },
      { path: 'clientes', element: <Guard perm="clients.view"><ClientsPage /></Guard> },
      { path: 'clientes/:id', element: <Guard perm="clients.view"><ClientDetail /></Guard> },
      { path: 'veiculos', element: <Guard perm="vehicles.view"><VehiclesPage /></Guard> },
      { path: 'veiculos/:id', element: <Guard perm="vehicles.view"><VehicleDetail /></Guard> },
      { path: 'orcamentos', element: <Guard perm="quotes.view"><QuotesPage /></Guard> },
      { path: 'orcamentos/novo', element: <Guard perm="quotes.create"><QuoteEditor /></Guard> },
      { path: 'orcamentos/:id', element: <Guard perm="quotes.view"><QuoteEditor /></Guard> },
      { path: 'preventiva', element: <Guard perm="maintenance.view"><MaintenancePage /></Guard> },
      { path: 'contatos', element: <Guard perm="contacts.view"><ContactsPage /></Guard> },
      { path: 'estoque', element: <Guard perm="inventory.view"><InventoryPage /></Guard> },
      { path: 'compras', element: <Guard perm="purchasing.view"><PurchasingPage /></Guard> },
      { path: 'financeiro', element: <Guard perm={['finance.view', 'cash.operate']}><FinancePage /></Guard> },
      { path: 'indicadores', element: <Guard perm="reports.view"><IndicatorsPage /></Guard> },
      { path: 'relatorios', element: <Guard perm="reports.view"><ReportsPage /></Guard> },
      { path: 'equipe', element: <Guard perm="team.view"><TeamPage /></Guard> },
      { path: 'configuracoes', element: <Guard perm="settings.manage"><SettingsPage /></Guard> },
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

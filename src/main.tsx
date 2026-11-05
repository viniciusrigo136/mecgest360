import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTheme, getTheme } from './lib/theme'

applyTheme(getTheme())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: (n, e) => n < 2 && (e as { code?: string })?.code !== '42501', refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)

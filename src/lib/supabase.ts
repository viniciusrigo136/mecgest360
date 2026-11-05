import { createClient } from '@supabase/supabase-js'

// Aceita os nomes do Vite e os nomes NEXT_PUBLIC_ usados no painel da Vercel/Supabase.
const env = (import.meta.env ?? {}) as Record<string, string | undefined>
const url = (env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL) as string | undefined
const key = (env.VITE_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string | undefined

export const isConfigured = Boolean(url && key)

// Somente a chave pública (anon/publishable) vai para o navegador.
// A service role fica exclusivamente nas funções de servidor.
export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

/** Chama uma RPC e lança erro amigável. */
export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw error
  return data as T
}

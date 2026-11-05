import { supabase } from './supabase'

export type DocWorkshop = { name: string; legal_name?: string | null; document?: string | null; phone?: string | null; whatsapp?: string | null;
  email?: string | null; address?: Record<string, string> | null; logo_path?: string | null; pix_key?: string | null; pix_name?: string | null; pix_city?: string | null }

/** Dados da oficina usados em documentos e no Pix. */
export async function loadWorkshopDoc(wsId: string): Promise<DocWorkshop> {
  const { data, error } = await supabase.from('workshops').select('name, legal_name, document, phone, whatsapp, email, address, logo_path, pix_key, pix_name, pix_city').eq('id', wsId).single()
  if (error) throw error
  return data as DocWorkshop
}

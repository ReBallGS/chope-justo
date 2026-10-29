import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''

export const isConfigured =
  url.startsWith('https://') &&
  anonKey.length > 20 &&
  !url.includes('SEU_PROJETO') &&
  !anonKey.includes('sua_chave')

export const supabase: SupabaseClient | null = isConfigured
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null

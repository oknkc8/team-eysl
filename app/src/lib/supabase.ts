import { createClient } from '@supabase/supabase-js'
import { env } from './env'
import type { Database } from '../types/database'

// The publishable key is public by Supabase's design; access control is RLS and
// the SECURITY DEFINER RPCs, never the secrecy of this string.
export const supabase = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
)

import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase credentials. Copy .env.example → .env and fill in your values.'
  )
}

/**
 * Browser Supabase client, typed against the live schema via `Database`.
 * The `anon` key is safe to ship: Row Level Security restricts reads to
 * `published` rows (see README → Supabase notes).
 */
export const supabase = createClient<Database>(supabaseUrl, supabaseKey)

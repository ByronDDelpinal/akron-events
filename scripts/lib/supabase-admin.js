import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env'
  )
}

// Service role client — bypasses RLS, server-side only, never expose to browser
export const supabaseAdmin = createClient(url, key, {
  auth: { persistSession: false },
})

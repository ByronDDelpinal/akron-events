/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Typed `import.meta.env`. Only the `VITE_`-prefixed vars are exposed to the
 * browser bundle by Vite; server-only secrets (e.g. SUPABASE_SERVICE_ROLE_KEY)
 * are intentionally absent here so they can't be referenced from client code.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_MAPBOX_TOKEN?: string
  readonly VITE_GA_MEASUREMENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

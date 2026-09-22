/// <reference types="vite/client" />

// Only VITE_-prefixed variables are exposed to browser code, and everything here ships to the
// client. NEVER put secrets (e.g. the Supabase service-role key) in a VITE_ variable.
interface ImportMetaEnv {
  /** Base URL of the API. Leave unset in dev (same-origin via the Vite proxy). */
  readonly VITE_API_BASE_URL?: string;
  /** Supabase project URL. Public. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key. Public by design; access is enforced by RLS and the API. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

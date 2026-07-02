import { createClient } from "jsr:@supabase/supabase-js@2";

// Service-role client for internal bookkeeping tables (oauth tokens, sync state,
// backfill chunks) that have no RLS policies granted to anon/authenticated.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically by the
// Supabase platform into every Edge Function's environment.
export function supabaseAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { CLOBE_AUTH_BASE, CLOBE_CLIENT_ID } from "../_shared/clobeConfig.ts";

// Diagnostic-only, temporary function: forces a refresh_token grant right now
// (ignoring expires_at) and reports success/failure + the new scope/expiry --
// never the token values themselves. Used once to verify that offline_access
// actually works despite the token response's scope field coming back as
// just "mcp", then deleted.
Deno.serve(async () => {
  const db = supabaseAdmin();
  const { data: row, error } = await db
    .from("clobe_oauth_tokens")
    .select("refresh_token")
    .eq("id", 1)
    .maybeSingle();

  if (error || !row) {
    return new Response(JSON.stringify({ ok: false, step: "load", error: error?.message ?? "no row" }), { status: 500 });
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    client_id: CLOBE_CLIENT_ID,
  });

  const res = await fetch(`${CLOBE_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();

  if (!res.ok) {
    return new Response(JSON.stringify({ ok: false, step: "refresh", status: res.status, error: json }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const newExpiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString();
  await db.from("clobe_oauth_tokens").update({
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? row.refresh_token,
    expires_at: newExpiresAt,
    scope: json.scope ?? null,
    last_refresh_error: null,
    last_refresh_error_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);

  return new Response(
    JSON.stringify({
      ok: true,
      new_scope: json.scope ?? null,
      new_expires_at: newExpiresAt,
      refresh_token_rotated: Boolean(json.refresh_token),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});

import { supabaseAdmin } from "./supabaseAdmin.ts";
import { CLOBE_AUTH_BASE, CLOBE_CLIENT_ID } from "./clobeConfig.ts";

// Returns a valid clobe access token, refreshing it via the stored refresh_token
// if it's within 2 minutes of expiry (or already expired). Throws if clobe has
// never been connected, or if the refresh itself fails (revoked/expired
// refresh_token) -- callers should let this abort the sync run; the failure is
// recorded on clobe_oauth_tokens so the frontend can surface a "reconnect
// needed" banner.
export async function getValidAccessToken(): Promise<string> {
  const db = supabaseAdmin();
  const { data: row, error } = await db
    .from("clobe_oauth_tokens")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw new Error(`clobe_oauth_tokens 조회 실패: ${error.message}`);
  if (!row) {
    throw new Error(
      "clobe가 아직 연동되지 않았습니다. clobe-oauth-start를 먼저 방문해 인증하세요.",
    );
  }

  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt - Date.now() > 2 * 60 * 1000) {
    return row.access_token as string;
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
    await db.from("clobe_oauth_tokens").update({
      last_refresh_error: JSON.stringify(json),
      last_refresh_error_at: new Date().toISOString(),
    }).eq("id", 1);
    throw new Error(`clobe 토큰 갱신 실패: ${JSON.stringify(json)}`);
  }

  const newExpiresAt = new Date(
    Date.now() + (json.expires_in ?? 3600) * 1000,
  ).toISOString();

  await db.from("clobe_oauth_tokens").update({
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? row.refresh_token,
    expires_at: newExpiresAt,
    last_refresh_error: null,
    last_refresh_error_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);

  return json.access_token as string;
}

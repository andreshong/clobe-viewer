import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { CLOBE_AUTH_BASE, CLOBE_CLIENT_ID, REDIRECT_URI } from "../_shared/clobeConfig.ts";

function html(msg: string, status: number) {
  return new Response(
    `<html><body style="font-family:sans-serif;padding:40px;max-width:520px;margin:0 auto"><h2>${msg}</h2></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// clobe redirects here after the owner approves access. verify_jwt is
// disabled since clobe's redirect can't attach a Supabase Authorization
// header; security instead comes from the state param (checked against a
// short-lived server-persisted PKCE row) and PKCE code_verifier.
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err) return html(`clobe에서 오류를 반환했습니다: ${err}`, 400);
  if (!code || !state) return html("code 또는 state 파라미터가 없습니다.", 400);

  const db = supabaseAdmin();
  const { data: pkce, error: pkceErr } = await db
    .from("oauth_pkce_state")
    .select("*")
    .eq("state", state)
    .maybeSingle();

  if (pkceErr || !pkce) {
    return html(
      "state가 유효하지 않거나 만료되었습니다. clobe-oauth-start부터 다시 시작하세요.",
      400,
    );
  }

  const ageMs = Date.now() - new Date(pkce.created_at).getTime();
  await db.from("oauth_pkce_state").delete().eq("state", state);
  if (ageMs > 10 * 60 * 1000) {
    return html("인증 요청이 만료되었습니다(10분). clobe-oauth-start부터 다시 시작하세요.", 400);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLOBE_CLIENT_ID,
    code_verifier: pkce.code_verifier,
  });

  const tokenRes = await fetch(`${CLOBE_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    return html(`토큰 교환 실패: ${JSON.stringify(tokenJson)}`, 502);
  }

  const expiresAt = new Date(
    Date.now() + (tokenJson.expires_in ?? 3600) * 1000,
  ).toISOString();

  const { error: upsertErr } = await db.from("clobe_oauth_tokens").upsert({
    id: 1,
    client_id: CLOBE_CLIENT_ID,
    access_token: tokenJson.access_token,
    refresh_token: tokenJson.refresh_token,
    token_type: tokenJson.token_type ?? "Bearer",
    scope: tokenJson.scope ?? null,
    expires_at: expiresAt,
    last_refresh_error: null,
    last_refresh_error_at: null,
    updated_at: new Date().toISOString(),
  });

  if (upsertErr) return html(`토큰 저장 실패: ${upsertErr.message}`, 500);

  return html("clobe 연동이 완료되었습니다. 이 탭은 닫으셔도 됩니다.", 200);
});

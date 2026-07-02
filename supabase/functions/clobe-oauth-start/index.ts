import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { codeChallengeFromVerifier, randomString } from "../_shared/pkce.ts";
import { CLOBE_AUTH_BASE, CLOBE_CLIENT_ID, REDIRECT_URI } from "../_shared/clobeConfig.ts";

// Manual, one-time entry point: the company owner visits this URL directly in
// a browser to grant clobe-viewer's backend access to their clobe data. Not
// invoked by anything else. verify_jwt is disabled for this function since a
// plain browser navigation can't attach a Supabase Authorization header.
Deno.serve(async (_req) => {
  const verifier = randomString(64);
  const challenge = await codeChallengeFromVerifier(verifier);
  const state = randomString(24);

  const db = supabaseAdmin();
  // best-effort cleanup of stale pending states (>10 min old)
  await db.from("oauth_pkce_state").delete().lt(
    "created_at",
    new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  );

  const { error } = await db.from("oauth_pkce_state").insert({
    state,
    code_verifier: verifier,
  });
  if (error) {
    return new Response(`PKCE state 저장 실패: ${error.message}`, { status: 500 });
  }

  const url = new URL(`${CLOBE_AUTH_BASE}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLOBE_CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "mcp offline_access");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return Response.redirect(url.toString(), 302);
});

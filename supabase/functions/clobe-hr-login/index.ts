import { createClient } from "jsr:@supabase/supabase-js@2";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

// Login bridge: authenticates a clobe user against the SHARED HR Supabase
// project's hr_login(name, pin) RPC (read-only, black-box -- HR data is
// never modified), and on success mints a session for the corresponding
// clobe account. This lets the 5 allowlisted people log into clobe with the
// exact same name + password they use for the HR apps, without clobe storing
// its own passwords and without moving any data between projects.
//
// verify_jwt is disabled: this IS the login entry point, so no clobe session
// exists yet. It is gated by requiring valid HR credentials + a name on the
// allowlist below.

const HR_URL = "https://twcpfxswxfbntwfqpeoq.supabase.co";
// HR project's publishable anon key -- safe to embed (public key; hr_verify is
// a SECURITY DEFINER RPC the HR apps already call with this same anon key).
const HR_ANON = "sb_publishable_dvH9xzS-cG_ZhFx0mb0Ywg_6Cz-K1Lf";

// Only these 5 people may log into clobe. name -> clobe account email.
const NAME_TO_EMAIL: Record<string, string> = {
  "조윤성": "user1@clobe.local",
  "조경철": "user2@clobe.local",
  "김종순": "user3@clobe.local",
  "홍찬수": "user4@clobe.local",
  "서민규": "user5@clobe.local",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let name = "", password = "";
  try {
    const b = await req.json();
    name = (b.name ?? "").trim();
    password = b.password ?? "";
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const email = NAME_TO_EMAIL[name];
  if (!email) return json({ error: "invalid_login" }, 401);

  // 1) Verify credentials against the shared HR project (read-only), using the
  //    SAME function the other 3 apps log in with: hr_login. It returns the
  //    user's info (HTTP 200) on success and raises "unauthorized" (HTTP 400)
  //    on failure. (hr_verify only checks the original phone PIN, so it wrongly
  //    rejects anyone who has since changed their password -- that was the bug.)
  let verified = false;
  try {
    const res = await fetch(`${HR_URL}/rest/v1/rpc/hr_login`, {
      method: "POST",
      headers: {
        "apikey": HR_ANON,
        "Authorization": `Bearer ${HR_ANON}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_name: name, p_pin: password }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const val = await res.json().catch(() => null);
      // Success = 200 without an error verdict in the returned jsonb.
      verified = !(val && typeof val === "object" && (val.ok === false || val.error));
    }
  } catch (_e) {
    return json({ error: "hr_unreachable" }, 502);
  }

  if (!verified) return json({ error: "invalid_login" }, 401);

  // 2) Mint a clobe session for the mapped account (generateLink -> verifyOtp).
  const admin = supabaseAdmin();
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) return json({ error: "session_mint_failed" }, 500);

  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: sess, error: otpErr } = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  if (otpErr || !sess?.session) return json({ error: "session_mint_failed" }, 500);

  return json({
    ok: true,
    name,
    access_token: sess.session.access_token,
    refresh_token: sess.session.refresh_token,
  });
});

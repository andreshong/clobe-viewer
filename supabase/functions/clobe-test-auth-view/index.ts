import { createClient } from "jsr:@supabase/supabase-js@2";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

// Diagnostic-only, temporary: mints a real session for the company user
// server-side (never exposing tokens) and checks that an `authenticated`
// role can still read card_usage_view after the security_invoker fix --
// i.e. confirms the RLS fix blocks anon without also blocking legitimate
// authenticated access. Delete after verification.
const EMAIL = "hongchansu@kakao.com";

Deno.serve(async () => {
  const admin = supabaseAdmin();
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (linkErr || !linkData) {
    return new Response(JSON.stringify({ ok: false, step: "generateLink", error: linkErr?.message }), { status: 500 });
  }

  const tokenHash = linkData.properties?.hashed_token;
  if (!tokenHash) {
    return new Response(JSON.stringify({ ok: false, step: "no hashed_token", raw: Object.keys(linkData.properties || {}) }), { status: 500 });
  }

  const anonClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  if (verifyErr || !verifyData?.session) {
    return new Response(JSON.stringify({ ok: false, step: "verifyOtp", error: verifyErr?.message }), { status: 500 });
  }

  const authedClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${verifyData.session.access_token}` } },
  });

  const [cardUsage, txCount, bankAccounts] = await Promise.all([
    authedClient.from("card_usage_view").select("*").limit(3),
    authedClient.from("transactions").select("*", { count: "exact", head: true }),
    authedClient.from("bank_accounts").select("*").limit(2),
  ]);

  return new Response(JSON.stringify({
    ok: true,
    card_usage_view_rows: cardUsage.data?.length ?? 0,
    card_usage_error: cardUsage.error?.message ?? null,
    transactions_count: txCount.count ?? 0,
    bank_accounts_rows: bankAccounts.data?.length ?? 0,
    bank_accounts_sample: bankAccounts.data,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});

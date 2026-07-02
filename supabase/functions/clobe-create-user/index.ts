import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

// One-time admin bootstrap: creates the single company login account.
// No password -- login is passwordless (magic link / OTP email), so there is
// no credential to hardcode or leak here. Email is fixed in source (not read
// from the request) so this endpoint can never be used to create arbitrary
// accounts even though it's left deployed afterward -- repeated calls just
// no-op/error on an existing user.
const EMAIL = "hongchansu@kakao.com";

Deno.serve(async () => {
  const db = supabaseAdmin();
  const { data, error } = await db.auth.admin.createUser({
    email: EMAIL,
    email_confirm: true,
  });
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, user_id: data.user?.id, email: data.user?.email }), {
    headers: { "Content-Type": "application/json" },
  });
});

import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

// Diagnostic-only, temporary: generates a real, one-time magic-link URL for
// the company account so it can be opened directly in a real browser for
// debugging, without needing email access. Delete after use.
const EMAIL = "hongchansu@kakao.com";

Deno.serve(async () => {
  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
    options: { redirectTo: "https://clobe-viewer.vercel.app/" },
  });
  if (error || !data) {
    return new Response(JSON.stringify({ ok: false, error: error?.message }), { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true, action_link: data.properties?.action_link }), {
    headers: { "Content-Type": "application/json" },
  });
});

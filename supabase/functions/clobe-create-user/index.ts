import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

// One-time admin bootstrap: creates the company login accounts. Each is a
// synthetic @clobe.local email (Supabase Auth requires an email field, but
// login is done by name -- the frontend maps name -> this fixed address,
// see NAME_LOGIN_MAP in data.js). Initial passwords are random and
// discarded immediately after creation -- never logged, never returned --
// the actual password each person will use is set afterward via the
// Supabase Dashboard (Authentication > Users > reset password), so no real
// credential value is ever hardcoded here or exposed in this response.
const EMAILS = [
  "user1@clobe.local", // 조윤성
  "user2@clobe.local", // 조경철
  "user3@clobe.local", // 김종순
  "user4@clobe.local", // 홍찬수
  "user5@clobe.local", // 서민규
];

function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async () => {
  const db = supabaseAdmin();
  const results: Record<string, string> = {};

  for (const email of EMAILS) {
    const { error } = await db.auth.admin.createUser({
      email,
      password: randomPassword(),
      email_confirm: true,
    });
    results[email] = error ? `error: ${error.message}` : "created";
  }

  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});

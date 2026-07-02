// Password-change bridge: forwards a change request to the SHARED HR project's
// hr_set_password(name, current, new) RPC. Since every app's password lives
// only in that project's hr_contacts, changing it here propagates to all 4
// apps (제안활동·인사평가·의견수렴·clobe) automatically -- single source of
// truth, no syncing. hr_set_password itself requires the correct current
// password, so this endpoint can't change a password without it.
//
// verify_jwt disabled: the security gate is the current-password check inside
// hr_set_password, plus the name allowlist below.

const HR_URL = "https://twcpfxswxfbntwfqpeoq.supabase.co";
const HR_ANON = "sb_publishable_dvH9xzS-cG_ZhFx0mb0Ywg_6Cz-K1Lf";

const ALLOWED = new Set(["조윤성", "조경철", "김종순", "홍찬수", "서민규"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let name = "", current = "", next = "";
  try {
    const b = await req.json();
    name = (b.name ?? "").trim();
    current = b.current ?? "";
    next = b.next ?? "";
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  if (!ALLOWED.has(name)) return json({ error: "invalid_login" }, 401);
  if (!next || next.length < 4) return json({ error: "weak_password" }, 400);

  try {
    const res = await fetch(`${HR_URL}/rest/v1/rpc/hr_set_password`, {
      method: "POST",
      headers: {
        "apikey": HR_ANON,
        "Authorization": `Bearer ${HR_ANON}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_name: name, p_current: current, p_new: next }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await res.json().catch(() => null);
    if (!res.ok) return json({ error: "hr_error", detail: result }, 502);
    // hr_set_password returns jsonb -- pass its ok/err verdict straight through.
    if (result && typeof result === "object" && result.ok === false) {
      return json({ ok: false, error: result.error || "change_failed" }, 400);
    }
    return json({ ok: true });
  } catch (_e) {
    return json({ error: "hr_unreachable" }, 502);
  }
});

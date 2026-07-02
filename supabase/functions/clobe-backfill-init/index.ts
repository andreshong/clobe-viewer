import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

// Seeds backfill_chunks with month-aligned date ranges for every ranged data
// type, going back YEARS_BACK years. The actual historical start of clobe's
// own data is unknown, so this seeds generously; chunks older than the real
// history will simply come back empty and finish instantly -- harmless.
const RANGED_TYPES = ["tax_invoices", "card_billing", "transactions", "cash_receipts"];
const SINGLETON_TYPES = ["bank_accounts", "monthly_revenue", "account_balance_trend"];
const YEARS_BACK = 5;

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
}

function monthChunks(yearsBack: number): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  const now = new Date();
  const totalMonths = yearsBack * 12;
  for (let i = 0; i < totalMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    chunks.push({ start: fmt(start), end: fmt(end) });
  }
  return chunks;
}

Deno.serve(async (_req) => {
  const db = supabaseAdmin();
  const chunks = monthChunks(YEARS_BACK);

  for (const dataType of RANGED_TYPES) {
    const rows = chunks.map((c) => ({
      data_type: dataType,
      range_start: c.start,
      range_end: c.end,
    }));
    const { error } = await db.from("backfill_chunks").upsert(rows, {
      onConflict: "data_type,range_start,range_end",
      ignoreDuplicates: true,
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message, at: dataType }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    await db.from("clobe_sync_state").upsert(
      { data_type: dataType, phase: "backfill" },
      { onConflict: "data_type", ignoreDuplicates: true },
    );
  }

  for (const dataType of SINGLETON_TYPES) {
    await db.from("clobe_sync_state").upsert(
      { data_type: dataType, phase: "backfill" },
      { onConflict: "data_type", ignoreDuplicates: true },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      ranged_types: RANGED_TYPES,
      months_seeded_per_type: chunks.length,
      singleton_types: SINGLETON_TYPES,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});

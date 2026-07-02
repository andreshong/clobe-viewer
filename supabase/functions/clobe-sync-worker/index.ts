import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { getValidAccessToken } from "../_shared/clobeAuth.ts";
import { mcpRawInitializeResult } from "../_shared/mcpClient.ts";
import { CLOBE_COMPANY_ID } from "../_shared/clobeConfig.ts";
import {
  loadAccountIdMap,
  syncAccountBalanceTrend,
  syncBankAccounts,
  syncCardBillingRange,
  syncCashReceiptsRange,
  syncMonthlyRevenueRange,
  syncTaxInvoicesRange,
  syncTransactionsRange,
} from "../_shared/syncHandlers.ts";

const MAX_CHUNKS_PER_RUN = 3;
const YEARS_BACK = 5;

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
}

async function markSyncStateSuccess(db: any, dataType: string, syncedThrough: string | null) {
  const { data: row } = await db.from("clobe_sync_state").select("synced_through").eq("data_type", dataType)
    .maybeSingle();
  const advanced = !syncedThrough
    ? row?.synced_through ?? null
    : (!row?.synced_through || syncedThrough > row.synced_through ? syncedThrough : row.synced_through);
  await db.from("clobe_sync_state").update({
    synced_through: advanced,
    last_synced_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
    updated_at: new Date().toISOString(),
  }).eq("data_type", dataType);
}

async function markSyncStateError(db: any, dataType: string, message: string) {
  await db.from("clobe_sync_state").update({
    last_error: message,
    last_error_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("data_type", dataType);
}

Deno.serve(async () => {
  const db = supabaseAdmin();
  const summary: Record<string, unknown> = { singleton: {}, chunks: [] };

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, step: "getValidAccessToken", error: String(e) }), { status: 500 });
  }

  let sessionId: string | undefined;
  try {
    sessionId = (await mcpRawInitializeResult(accessToken)).sessionId;
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, step: "initialize", error: String(e) }), { status: 500 });
  }

  const today = new Date();
  const todayStr = fmt(today);
  const fiveYearsAgo = fmt(new Date(today.getFullYear() - YEARS_BACK, today.getMonth(), today.getDate()));
  const twoMonthsAgo = fmt(new Date(today.getFullYear(), today.getMonth() - 2, 1));

  // ---- singleton-ish syncs: run every invocation, cheap ----
  try {
    const n = await syncBankAccounts(db, accessToken, sessionId, CLOBE_COMPANY_ID);
    (summary.singleton as any).bank_accounts = n;
    await db.from("clobe_sync_state").update({ phase: "incremental" }).eq("data_type", "bank_accounts");
    await markSyncStateSuccess(db, "bank_accounts", null);
  } catch (e) {
    (summary.singleton as any).bank_accounts = { error: String(e) };
    await markSyncStateError(db, "bank_accounts", String(e));
  }

  // account_balance_trend: full 5y history once (backfill), then a short
  // recent window each run afterward -- the tool itself has no date-range
  // param, only "how many weeks back from today".
  try {
    const { data: abtState } = await db.from("clobe_sync_state").select("phase").eq("data_type", "account_balance_trend")
      .maybeSingle();
    const inquiryWeeks = abtState?.phase === "backfill" ? YEARS_BACK * 52 : 12;
    const n = await syncAccountBalanceTrend(db, accessToken, sessionId, CLOBE_COMPANY_ID, inquiryWeeks);
    (summary.singleton as any).account_balance_trend = n;
    await db.from("clobe_sync_state").update({ phase: "incremental" }).eq("data_type", "account_balance_trend");
    await markSyncStateSuccess(db, "account_balance_trend", null);
  } catch (e) {
    (summary.singleton as any).account_balance_trend = { error: String(e) };
    await markSyncStateError(db, "account_balance_trend", String(e));
  }

  // monthly_revenue: full 5y range once (backfill), then just the last 2
  // months each run afterward (current month's figures change daily until
  // the month closes; older months are stable).
  try {
    const { data: mrState } = await db.from("clobe_sync_state").select("phase").eq("data_type", "monthly_revenue")
      .maybeSingle();
    const isBackfill = mrState?.phase === "backfill";
    const start = isBackfill ? fiveYearsAgo : twoMonthsAgo;
    const n = await syncMonthlyRevenueRange(db, accessToken, sessionId, CLOBE_COMPANY_ID, start, todayStr);
    (summary.singleton as any).monthly_revenue = n;
    if (isBackfill) {
      await db.from("clobe_sync_state").update({ phase: "incremental" }).eq("data_type", "monthly_revenue");
    }
    await markSyncStateSuccess(db, "monthly_revenue", todayStr);
  } catch (e) {
    (summary.singleton as any).monthly_revenue = { error: String(e) };
    await markSyncStateError(db, "monthly_revenue", String(e));
  }

  // ---- accountIdMap for resolving transactions.account_id ----
  let accountIdMap = new Map<number, string>();
  try {
    accountIdMap = await loadAccountIdMap(db);
  } catch (e) {
    (summary.singleton as any).accountIdMap = { error: String(e) };
  }

  // ---- ranged backfill/incremental chunks (transactions, card_billing, tax_invoices, cash_receipts) ----
  const { data: claimed, error: claimErr } = await db.rpc("claim_next_backfill_chunks", { p_limit: MAX_CHUNKS_PER_RUN });
  if (claimErr) {
    return new Response(JSON.stringify({ ok: false, step: "claim_chunks", error: claimErr.message, summary }), { status: 500 });
  }

  const touchedDataTypes = new Set<string>();

  for (const chunk of claimed ?? []) {
    touchedDataTypes.add(chunk.data_type);
    try {
      let rows = 0;
      switch (chunk.data_type) {
        case "transactions":
          rows = await syncTransactionsRange(
            db, accessToken, sessionId, CLOBE_COMPANY_ID, chunk.range_start, chunk.range_end, accountIdMap,
          );
          break;
        case "card_billing":
          rows = await syncCardBillingRange(
            db, accessToken, sessionId, CLOBE_COMPANY_ID, chunk.range_start, chunk.range_end,
          );
          break;
        case "tax_invoices":
          rows = await syncTaxInvoicesRange(
            db, accessToken, sessionId, CLOBE_COMPANY_ID, chunk.range_start, chunk.range_end,
          );
          break;
        case "cash_receipts":
          rows = await syncCashReceiptsRange(
            db, accessToken, sessionId, CLOBE_COMPANY_ID, chunk.range_start, chunk.range_end,
          );
          break;
        default:
          throw new Error(`알 수 없는 data_type: ${chunk.data_type}`);
      }

      await db.from("backfill_chunks").update({
        status: "done",
        rows_upserted: rows,
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", chunk.id);

      await markSyncStateSuccess(db, chunk.data_type, chunk.range_end);
      (summary.chunks as any[]).push({ data_type: chunk.data_type, range_start: chunk.range_start, range_end: chunk.range_end, rows });
    } catch (e) {
      await db.from("backfill_chunks").update({
        status: "error",
        attempts: (chunk.attempts ?? 0) + 1,
        last_error: String(e),
        updated_at: new Date().toISOString(),
      }).eq("id", chunk.id);
      await markSyncStateError(db, chunk.data_type, String(e));
      (summary.chunks as any[]).push({ data_type: chunk.data_type, range_start: chunk.range_start, range_end: chunk.range_end, error: String(e) });
    }
  }

  // Flip a data_type to 'incremental' once it has no pending/error chunks left.
  for (const dataType of touchedDataTypes) {
    const { count } = await db.from("backfill_chunks").select("id", { count: "exact", head: true })
      .eq("data_type", dataType).in("status", ["pending", "error"]);
    if ((count ?? 0) === 0) {
      await db.from("clobe_sync_state").update({ phase: "incremental" }).eq("data_type", dataType);
    }
  }

  // Public-facing "last synced" indicator the frontend topbar reads.
  await db.from("sync_state").update({ last_synced_at: new Date().toISOString() }).eq("id", "default");

  return new Response(JSON.stringify({ ok: true, summary }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});

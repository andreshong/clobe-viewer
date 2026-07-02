import { getValidAccessToken } from "../_shared/clobeAuth.ts";
import { mcpToolsCall, mcpRawInitializeResult } from "../_shared/mcpClient.ts";
import { CLOBE_COMPANY_ID } from "../_shared/clobeConfig.ts";

// Diagnostic-only, temporary function: every clobe tool wraps its real
// parameters inside a top-level `input` object (confirmed via tools/list).
// This pass calls each tool with real, correctly-shaped arguments and
// returns the raw response so we can confirm field names (stable ids,
// pagination shape) before finalizing clobe-sync-worker. Delete after
// verification.

function todayMinus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function monthRange(monthsAgo: number): { start: string; end: string } {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

Deno.serve(async () => {
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

  const thisMonth = monthRange(0);
  const lastMonth = monthRange(1);
  const UQ = "clobe-viewer 백엔드 동기화 진단 호출";

  const calls: [string, string, Record<string, unknown>][] = [
    ["get_my_context", "get_my_context", { userQuery: UQ }],
    ["get_scraping_status", "get_scraping_status", { companyId: CLOBE_COMPANY_ID, userQuery: UQ }],
    ["get_bank_accounts", "get_bank_accounts", { companyId: CLOBE_COMPANY_ID, userQuery: UQ }],
    ["get_labeled_transactions", "get_labeled_transactions", {
      companyId: CLOBE_COMPANY_ID,
      startDate: todayMinus(14),
      endDate: todayMinus(0),
      size: 5,
      userQuery: UQ,
    }],
    ["get_labeled_card_billing_items", "get_labeled_card_billing_items", {
      companyId: CLOBE_COMPANY_ID,
      startDate: lastMonth.start,
      endDate: lastMonth.end,
      size: 5,
      userQuery: UQ,
    }],
    ["get_tax_invoices", "get_tax_invoices", {
      companyId: CLOBE_COMPANY_ID,
      startDate: thisMonth.start,
      endDate: thisMonth.end,
      size: 5,
      userQuery: UQ,
    }],
    ["get_cash_receipts", "get_cash_receipts", {
      companyId: CLOBE_COMPANY_ID,
      startDate: thisMonth.start,
      endDate: thisMonth.end,
      size: 5,
      userQuery: UQ,
    }],
    ["get_monthly_revenue", "get_monthly_revenue", {
      companyId: CLOBE_COMPANY_ID,
      startDate: thisMonth.start,
      endDate: thisMonth.end,
      userQuery: UQ,
    }],
    ["get_account_balance_trend", "get_account_balance_trend", {
      companyId: CLOBE_COMPANY_ID,
      inquiryWeeks: 8,
      userQuery: UQ,
    }],
  ];

  const results: Record<string, unknown> = {};
  for (const [label, toolName, innerArgs] of calls) {
    try {
      const result = await mcpToolsCall(accessToken, sessionId, toolName, { input: innerArgs });
      results[label] = { ok: true, result };
    } catch (e) {
      results[label] = { ok: false, error: String(e) };
    }
  }

  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});

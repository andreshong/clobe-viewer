import { mcpToolsCall } from "./mcpClient.ts";
import { dateArrToISODate, dateTimeArrToISO } from "./clobeDates.ts";
import { sha256Hex } from "./hash.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety cap: 50 * 100 = 5000 rows per chunk call, far above any real month's volume

async function upsertBatch(db: any, table: string, rows: any[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await db.from(table).upsert(rows, { onConflict: "dedup_key" });
  if (error) throw new Error(`upsert ${table} 실패: ${error.message}`);
  return rows.length;
}

async function call(accessToken: string, sessionId: string | undefined, tool: string, input: Record<string, unknown>) {
  return await mcpToolsCall(accessToken, sessionId, tool, { input });
}

// ============================================================
// bank_accounts (singleton snapshot, called every invocation)
// ============================================================

export async function syncBankAccounts(
  db: any,
  accessToken: string,
  sessionId: string | undefined,
  companyId: string,
): Promise<number> {
  const result = await call(accessToken, sessionId, "get_bank_accounts", { companyId });
  const accounts = result?.accounts ?? [];
  const rows = accounts.map((a: any) => ({
    dedup_key: String(a.bankAccountId),
    clobe_account_id: a.bankAccountId,
    bank_code: a.bankCode,
    account_number: a.accountNumber,
    display_account_number: a.displayAccountNumber,
    account_name: a.accountName || null,
    alias_name: a.aliasName || null,
    account_type: a.accountType,
    currency: a.currencyCode,
    is_main: Boolean(a.isMain),
    is_overdraft: Boolean(a.isOverdraft),
    is_hidden: Boolean(a.isHidden),
    balance: a.balance,
    krw_balance: Math.round(a.krwBalance),
    raw: a,
    updated_at: new Date().toISOString(),
  }));
  return await upsertBatch(db, "bank_accounts", rows);
}

// Builds clobe_account_id -> bank_accounts.id map for resolving transactions.account_id.
export async function loadAccountIdMap(db: any): Promise<Map<number, string>> {
  const { data, error } = await db.from("bank_accounts").select("id, clobe_account_id");
  if (error) throw new Error(`bank_accounts 조회 실패: ${error.message}`);
  const map = new Map<number, string>();
  for (const row of data ?? []) map.set(row.clobe_account_id, row.id);
  return map;
}

// ============================================================
// transactions (ranged, cursor pagination)
// ============================================================

export async function syncTransactionsRange(
  db: any,
  accessToken: string,
  sessionId: string | undefined,
  companyId: string,
  startDate: string,
  endDate: string,
  accountIdMap: Map<number, string>,
): Promise<number> {
  let cursor: string | undefined;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call(accessToken, sessionId, "get_labeled_transactions", {
      companyId,
      startDate,
      endDate,
      size: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const content = result?.content ?? [];
    const rows = content.map((t: any) => ({
      dedup_key: String(t.transactionId),
      clobe_transaction_id: t.transactionId,
      clobe_account_id: t.accountId,
      account_id: accountIdMap.get(t.accountId) ?? null,
      txn_at: dateTimeArrToISO(t.transactionAt),
      counterparty: t.transactionName || null,
      description: t.transactionDescription || null,
      in_amount: Math.round(t.inAmount ?? 0),
      out_amount: Math.round(t.outAmount ?? 0),
      after_balance: t.afterBalance != null ? Math.round(t.afterBalance) : null,
      account_name: t.accountName || null,
      bank_name: t.bankName || null,
      account_number: t.accountNumber || null,
      category: t.category || null,
      business_entity_name: t.businessEntityName || null,
      custom_label: t.customLabel || null,
      is_unclassified: Boolean(t.isUnclassified),
      memo: t.memo || null,
      raw: t,
    }));
    total += await upsertBatch(db, "transactions", rows);
    if (!result?.hasNext || !result?.nextCursor) break;
    cursor = result.nextCursor;
  }
  return total;
}

// ============================================================
// card_billing_items (ranged, page pagination, filtered by payment date)
// ============================================================

export async function syncCardBillingRange(
  db: any,
  accessToken: string,
  sessionId: string | undefined,
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<number> {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call(accessToken, sessionId, "get_labeled_card_billing_items", {
      companyId,
      startDate,
      endDate,
      size: PAGE_SIZE,
      page,
    });
    const content = result?.content ?? [];
    const rows = content.map((c: any) => ({
      dedup_key: String(c.billingItemId),
      clobe_billing_item_id: c.billingItemId,
      billing_type: c.billingType || null,
      card_no: c.cardNo,
      user_names: c.userNames || null,
      merchant: c.memberStoreName || null,
      merchant_type: c.memberStoreType || null,
      payment_amount: Math.round(c.paymentAmount ?? 0),
      used_amount: c.usedAmount != null ? Math.round(c.usedAmount) : null,
      used_date: dateArrToISODate(c.usedDate),
      payment_date: dateArrToISODate(c.paymentDate),
      category: c.category || null,
      business_entity_name: c.businessEntityName || null,
      group_label: c.groupLabel || null,
      label_id: c.labelId ?? null,
      is_unclassified: Boolean(c.isUnclassified),
      memo: c.memo || null,
      raw: c,
    }));
    total += await upsertBatch(db, "card_billing_items", rows);
    if (!result?.hasNext) break;
  }
  return total;
}

// ============================================================
// tax_invoices (ranged, page pagination)
// ============================================================

export async function syncTaxInvoicesRange(
  db: any,
  accessToken: string,
  sessionId: string | undefined,
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<number> {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call(accessToken, sessionId, "get_tax_invoices", {
      companyId,
      startDate,
      endDate,
      size: PAGE_SIZE,
      page,
    });
    const content = result?.content ?? [];
    const rows = content.map((inv: any) => {
      const isPurchase = inv.type === "PURCHASE";
      return {
        dedup_key: String(inv.id),
        clobe_invoice_id: String(inv.id),
        type: inv.type,
        reporting_date: dateArrToISODate(inv.reportingDate),
        issue_date: dateArrToISODate(inv.issueDate),
        supplier_company_name: inv.supplierCompanyName || null,
        supplier_reg_number: inv.supplierRegNumber || null,
        contractor_company_name: inv.contractorCompanyName || null,
        contractor_reg_number: inv.contractorRegNumber || null,
        // PURCHASE: we're the contractor(buyer) -> the "partner" is the supplier.
        // SALES: we're the supplier(seller) -> the "partner" is the contractor(buyer).
        partner_name: isPurchase ? inv.supplierCompanyName : inv.contractorCompanyName,
        partner_reg_no: isPurchase ? inv.supplierRegNumber : inv.contractorRegNumber,
        supply_value: Math.round(inv.supplyValue ?? 0),
        tax_amount: Math.round(inv.taxAmount ?? 0),
        total_amount: Math.round(inv.totalAmount ?? 0),
        taxation_type: inv.taxationType || null,
        memo: inv.memo || null,
        raw: inv,
      };
    });
    total += await upsertBatch(db, "tax_invoices", rows);
    if (!result?.hasNext) break;
  }
  return total;
}

// ============================================================
// cash_receipts (ranged, page pagination -- item shape unverified,
// mapped defensively; raw jsonb always preserves the full payload)
// ============================================================

export async function syncCashReceiptsRange(
  db: any,
  accessToken: string,
  sessionId: string | undefined,
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<number> {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call(accessToken, sessionId, "get_cash_receipts", {
      companyId,
      startDate,
      endDate,
      size: PAGE_SIZE,
      page,
    });
    const content = result?.content ?? [];
    const rows = [];
    for (const r of content) {
      const dedupKey = r.id != null
        ? String(r.id)
        : await sha256Hex(JSON.stringify(r));
      rows.push({
        dedup_key: dedupKey,
        receipt_date: dateArrToISODate(r.receiptDate ?? r.issueDate ?? r.date),
        type: r.type ?? null,
        partner_name: r.partnerName ?? r.companyName ?? null,
        partner_reg_no: r.partnerRegNumber ?? r.regNumber ?? null,
        amount_krw: r.totalAmount != null ? Math.round(r.totalAmount) : (r.amount != null ? Math.round(r.amount) : null),
        category: r.category ?? null,
        raw: r,
      });
    }
    total += await upsertBatch(db, "cash_receipts", rows);
    if (!result?.hasNext) break;
  }
  return total;
}

// ============================================================
// monthly_revenue (ranged, page pagination -- item shape unverified)
// ============================================================

export async function syncMonthlyRevenueRange(
  db: any,
  accessToken: string,
  sessionId: string | undefined,
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<number> {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await call(accessToken, sessionId, "get_monthly_revenue", {
      companyId,
      startDate,
      endDate,
      size: 200,
      page,
    });
    const items = result?.items ?? [];
    const rows = [];
    for (const it of items) {
      const bucketDate = dateArrToISODate(it.date ?? it.bucketDate) ?? null;
      const channel = it.channel ?? it.platform ?? "TOTAL";
      const dedupKey = bucketDate
        ? `${bucketDate}:${channel}`
        : await sha256Hex(JSON.stringify(it));
      rows.push({
        dedup_key: dedupKey,
        bucket_date: bucketDate,
        channel,
        sales_amount_krw: it.salesAmountKrw != null ? Math.round(it.salesAmountKrw) : null,
        settlement_amount_krw: it.settlementAmountKrw != null ? Math.round(it.settlementAmountKrw) : null,
        fee_amount_krw: it.feeAmountKrw != null ? Math.round(it.feeAmountKrw) : null,
        raw: it,
      });
    }
    total += await upsertBatch(db, "monthly_revenue", rows);
    if (!result?.hasNext) break;
  }
  return total;
}

// ============================================================
// account_balance_trend (singleton-ish, no date range param -- only
// "how many weeks back from today", called every invocation)
// ============================================================

export async function syncAccountBalanceTrend(
  db: any,
  accessToken: string,
  sessionId: string | undefined,
  companyId: string,
  inquiryWeeks: number,
): Promise<number> {
  const result = await call(accessToken, sessionId, "get_account_balance_trend", {
    companyId,
    inquiryWeeks,
  });
  const byDate = new Map<string, { checking?: number; collect?: number; raw: any }>();
  for (const entry of result?.checkingTrends ?? []) {
    const d = dateArrToISODate(entry.date);
    if (!d) continue;
    const existing = byDate.get(d) ?? { raw: {} };
    existing.checking = entry.balance;
    existing.raw = { ...existing.raw, checking: entry };
    byDate.set(d, existing);
  }
  for (const entry of result?.collectTrends ?? []) {
    const d = dateArrToISODate(entry.date);
    if (!d) continue;
    const existing = byDate.get(d) ?? { raw: {} };
    existing.collect = entry.balance;
    existing.raw = { ...existing.raw, collect: entry };
    byDate.set(d, existing);
  }

  const rows = Array.from(byDate.entries()).map(([trend_date, v]) => ({
    trend_date,
    checking_balance_krw: v.checking != null ? Math.round(v.checking) : null,
    collect_balance_krw: v.collect != null ? Math.round(v.collect) : null,
    raw: v.raw,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return 0;
  const { error } = await db.from("account_balance_trend").upsert(rows, { onConflict: "trend_date" });
  if (error) throw new Error(`upsert account_balance_trend 실패: ${error.message}`);
  return rows.length;
}

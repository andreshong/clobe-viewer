-- Realign financial tables to clobe's actual MCP response shapes, discovered
-- via live tools/list + tools/call verification (see clobe-test-tools).
-- Key findings vs. the original guessed schema:
--   * bank_accounts / transactions / card_billing_items / tax_invoices all
--     have real stable numeric/string ids from clobe -- no hash-based dedup
--     needed for those. Standardized every syncable table on a single
--     `dedup_key text unique` column (the stringified real id, or a computed
--     hash only where no id exists) instead of the earlier external_id +
--     dedup_hash split.
--   * account_balance_trend is a company-wide DAILY series (checkingTrends/
--     collectTrends), not a per-account weekly series -- redesigned.
--   * cash_receipts / monthly_revenue item shapes are still unverified (this
--     company had zero rows in both during the test window) -- kept loosely
--     typed with a raw jsonb fallback so nothing is lost once real rows show up.
-- All tables currently have 0 rows (backfill hasn't run yet), so this is a
-- clean drop + recreate, not an in-place data migration.

drop view if exists monthly_revenue_totals;
drop view if exists card_usage_view;
drop view if exists card_statement_view;

drop table if exists monthly_revenue;
drop table if exists cash_receipts;
drop table if exists tax_invoices;
drop table if exists card_billing_items;
drop table if exists transactions;
drop table if exists account_balance_trend;
drop table if exists bank_accounts;

-- ============================================================
-- bank_accounts (accounts + loans unified, matches clobe's own model)
-- ============================================================

create table bank_accounts (
  id                     uuid primary key default gen_random_uuid(),
  dedup_key              text not null unique,
  clobe_account_id       bigint not null,
  bank_code              text not null,
  account_number         text not null,
  display_account_number text not null,
  account_name           text,
  alias_name             text,
  account_type           text not null check (account_type in ('CHECKING','LOAN','FX','FUND')),
  currency               text not null default 'KRW',
  is_main                boolean not null default false,
  is_overdraft           boolean not null default false,
  is_hidden              boolean not null default false,
  balance                numeric not null,
  krw_balance            bigint not null,
  raw                    jsonb not null default '{}'::jsonb,
  updated_at             timestamptz not null default now()
);

-- ============================================================
-- account_balance_trend: company-wide daily series, not per-account
-- ============================================================

create table account_balance_trend (
  trend_date            date primary key,
  checking_balance_krw  bigint,
  collect_balance_krw   bigint,
  raw                   jsonb not null default '{}'::jsonb,
  updated_at            timestamptz not null default now()
);

-- ============================================================
-- transactions (bank deposits/withdrawals)
-- ============================================================

create table transactions (
  id                    uuid primary key default gen_random_uuid(),
  dedup_key             text not null unique,
  clobe_transaction_id  bigint not null,
  clobe_account_id      bigint not null,
  account_id            uuid references bank_accounts(id),
  txn_at                timestamptz not null,
  counterparty          text,
  description           text,
  in_amount             bigint not null default 0,
  out_amount            bigint not null default 0,
  after_balance         bigint,
  account_name          text,
  bank_name             text,
  account_number        text,
  category              text,
  business_entity_name  text,
  custom_label          text,
  is_unclassified       boolean not null default false,
  memo                  text,
  raw                   jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);
create index on transactions (account_id, txn_at desc);
create index on transactions (txn_at desc);

-- ============================================================
-- card_billing_items (unified usage + billing, matches source granularity)
-- ============================================================

create table card_billing_items (
  id                    uuid primary key default gen_random_uuid(),
  dedup_key             text not null unique,
  clobe_billing_item_id bigint not null,
  billing_type          text,
  card_no               text not null,
  user_names            text,
  merchant              text,
  merchant_type         text,
  payment_amount        bigint not null,
  used_amount           bigint,
  used_date             date not null,
  payment_date          date not null,
  category              text,
  business_entity_name  text,
  group_label           text,
  label_id              bigint,
  is_unclassified       boolean not null default false,
  memo                  text,
  raw                   jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);
create index on card_billing_items (payment_date, card_no);
create index on card_billing_items (used_date);
create index on card_billing_items (card_no, used_date);

create view card_statement_view as
select card_no, payment_date, category,
       sum(payment_amount) as total_amount_krw,
       count(*) as item_count
from card_billing_items
group by card_no, payment_date, category;

create view card_usage_view as
select id, card_no, user_names, merchant, used_date, payment_date, category, payment_amount
from card_billing_items
order by used_date desc;

-- ============================================================
-- tax_invoices
-- ============================================================

create table tax_invoices (
  id                       uuid primary key default gen_random_uuid(),
  dedup_key                text not null unique,
  clobe_invoice_id         text not null,
  type                     text not null check (type in ('SALES','PURCHASE')),
  reporting_date           date,
  issue_date               date not null,
  supplier_company_name    text,
  supplier_reg_number      text,
  contractor_company_name  text,
  contractor_reg_number    text,
  partner_name             text not null,
  partner_reg_no           text not null,
  supply_value             bigint not null,
  tax_amount               bigint not null,
  total_amount             bigint not null,
  taxation_type            text,
  memo                     text,
  raw                      jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now()
);
create index on tax_invoices (issue_date, type);
create index on tax_invoices (partner_reg_no);

-- ============================================================
-- cash_receipts (item shape unverified -- zero rows during API exploration;
-- kept loosely typed, raw jsonb preserves everything regardless)
-- ============================================================

create table cash_receipts (
  id             uuid primary key default gen_random_uuid(),
  dedup_key      text not null unique,
  receipt_date   date,
  type           text,
  partner_name   text,
  partner_reg_no text,
  amount_krw     bigint,
  category       text,
  raw            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index on cash_receipts (receipt_date);

-- ============================================================
-- monthly_revenue (item shape unverified -- zero rows during API exploration)
-- ============================================================

create table monthly_revenue (
  id                      uuid primary key default gen_random_uuid(),
  dedup_key               text not null unique,
  bucket_date             date,
  channel                 text,
  sales_amount_krw        bigint,
  settlement_amount_krw   bigint,
  fee_amount_krw          bigint,
  raw                     jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now()
);

create view monthly_revenue_totals as
select bucket_date, sum(settlement_amount_krw) as total_settlement_krw
from monthly_revenue
group by bucket_date;

-- ============================================================
-- RLS (same pattern as before: authenticated can read, only service_role
-- -- used by Edge Functions -- can write)
-- ============================================================

alter table bank_accounts enable row level security;
alter table account_balance_trend enable row level security;
alter table transactions enable row level security;
alter table card_billing_items enable row level security;
alter table tax_invoices enable row level security;
alter table cash_receipts enable row level security;
alter table monthly_revenue enable row level security;

create policy "auth read" on bank_accounts for select to authenticated using (true);
create policy "auth read" on account_balance_trend for select to authenticated using (true);
create policy "auth read" on transactions for select to authenticated using (true);
create policy "auth read" on card_billing_items for select to authenticated using (true);
create policy "auth read" on tax_invoices for select to authenticated using (true);
create policy "auth read" on cash_receipts for select to authenticated using (true);
create policy "auth read" on monthly_revenue for select to authenticated using (true);

grant select on card_statement_view, card_usage_view, monthly_revenue_totals to authenticated;

-- ============================================================
-- Reset sync state / backfill chunks since the schema they were seeded
-- against has changed shape (payment-date chunking assumptions still hold,
-- so we keep the chunk queue -- just clear any stale progress markers).
-- ============================================================

update clobe_sync_state set phase = 'backfill', synced_through = null, last_error = null, last_error_at = null;
update backfill_chunks set status = 'pending', attempts = 0, last_error = null, rows_upserted = null;

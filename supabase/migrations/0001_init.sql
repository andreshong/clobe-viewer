-- clobe-viewer: initial schema
-- Financial data tables (synced by backend Edge Functions), config tables (migrated
-- from localStorage), and internal-only sync/oauth bookkeeping tables.

create extension if not exists pgcrypto;

-- ============================================================
-- Financial data tables
-- ============================================================

create table bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  bank_name      text not null,
  account_num    text not null,
  account_name   text,
  alias          text,
  account_type   text not null check (account_type in ('CHECKING','FUND','FX','LOAN')),
  currency       text not null default 'KRW',
  fx_amount      numeric,
  balance_krw    bigint not null,
  is_loan        boolean not null default false,
  snapshot_at    timestamptz not null default now(),
  raw            jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  unique (bank_name, account_num, currency)
);

create table account_balance_trend (
  id           bigint generated always as identity primary key,
  account_id   uuid references bank_accounts(id),
  bank_name    text not null,
  account_num  text not null,
  week_start   date not null,
  balance_krw  bigint not null,
  raw          jsonb not null default '{}'::jsonb,
  unique (account_num, week_start)
);

create table transactions (
  id            uuid primary key default gen_random_uuid(),
  external_id   text,
  account_id    uuid references bank_accounts(id),
  bank_name     text not null,
  account_num   text not null,
  txn_datetime  timestamptz not null,
  direction     text not null check (direction in ('IN','OUT')),
  amount_krw    bigint not null,
  counterparty  text,
  description   text,
  category      text,
  dedup_hash    text not null unique,
  raw           jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index on transactions (account_id, txn_datetime desc);
create index on transactions (txn_datetime desc);

create table card_billing_items (
  id              uuid primary key default gen_random_uuid(),
  external_id     text,
  card_masked     text not null,
  card_holder     text,
  merchant        text not null,
  use_date        date not null,
  pay_date        date not null,
  category        text,
  amount_krw      bigint not null,
  dedup_hash      text not null unique,
  raw             jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index on card_billing_items (pay_date, card_masked);
create index on card_billing_items (use_date);
create index on card_billing_items (card_masked, use_date);

create view card_statement_view as
select card_masked, pay_date, category,
       sum(amount_krw) as total_amount_krw,
       count(*) as item_count
from card_billing_items
group by card_masked, pay_date, category;

create view card_usage_view as
select id, card_masked, card_holder, merchant, use_date, pay_date, category, amount_krw
from card_billing_items
order by use_date desc;

create table tax_invoices (
  id             uuid primary key default gen_random_uuid(),
  external_id    text,
  invoice_date   date not null,
  invoice_type   text not null check (invoice_type in ('SALES','PURCHASE')),
  partner_name   text not null,
  partner_reg_no text not null,
  supply_amount  bigint not null,
  vat_amount     bigint not null,
  total_amount   bigint generated always as (supply_amount + vat_amount) stored,
  dedup_hash     text not null unique,
  raw            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index on tax_invoices (invoice_date, invoice_type);
create index on tax_invoices (partner_reg_no);

create table cash_receipts (
  id             uuid primary key default gen_random_uuid(),
  external_id    text,
  receipt_date   date not null,
  partner_name   text,
  partner_reg_no text,
  receipt_type   text,
  amount_krw     bigint not null,
  category       text,
  dedup_hash     text not null unique,
  raw            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index on cash_receipts (receipt_date);

create table monthly_revenue (
  id               bigint generated always as identity primary key,
  month            date not null,
  channel          text not null default 'TOTAL',
  net_amount_krw   bigint not null,
  raw              jsonb not null default '{}'::jsonb,
  unique (month, channel)
);

create view monthly_revenue_totals as
select month, sum(net_amount_krw) as total_net_krw
from monthly_revenue where channel <> 'TOTAL'
group by month;

-- ============================================================
-- Config tables (migrated from localStorage: card holders / account
-- aliases / party attributes). Shared company-wide config, no per-user
-- scoping needed.
-- ============================================================

create table card_holders (
  card       text primary key,
  holder     text not null default '',
  updated_at timestamptz not null default now()
);

create table account_aliases (
  account_num text primary key,
  alias       text not null default '',
  updated_at  timestamptz not null default now()
);

create table party_attrs (
  party_name text primary key,
  type       text,
  process    text,
  cost       text,
  regno      text,
  ceo        text,
  addr       text,
  updated_at timestamptz not null default now()
);

-- Single-row status the frontend reads to show "last synced" in the topbar.
create table sync_state (
  id             text primary key default 'default',
  last_synced_at timestamptz
);
insert into sync_state (id, last_synced_at) values ('default', null);

-- ============================================================
-- Internal-only tables: never exposed to anon/authenticated via RLS.
-- Only the service_role (used inside Edge Functions) can read/write these.
-- ============================================================

create table clobe_oauth_tokens (
  id                    int primary key default 1 check (id = 1),
  client_id             text not null,
  access_token          text not null,
  refresh_token         text not null,
  token_type            text not null default 'Bearer',
  scope                 text,
  expires_at            timestamptz not null,
  last_refresh_error    text,
  last_refresh_error_at timestamptz,
  last_upstream_scrape_at timestamptz,
  updated_at            timestamptz not null default now()
);

create table oauth_pkce_state (
  state         text primary key,
  code_verifier text not null,
  created_at    timestamptz not null default now()
);

create table clobe_sync_state (
  data_type       text primary key,
  phase           text not null default 'backfill' check (phase in ('backfill','incremental')),
  cursor          text,
  last_synced_at  timestamptz,
  synced_through  date,
  last_error      text,
  last_error_at   timestamptz,
  updated_at      timestamptz not null default now()
);

create table backfill_chunks (
  id            bigint generated always as identity primary key,
  data_type     text not null,
  range_start   date not null,
  range_end     date not null,
  status        text not null default 'pending' check (status in ('pending','in_progress','done','error')),
  attempts      int not null default 0,
  last_error    text,
  rows_upserted int,
  updated_at    timestamptz not null default now(),
  unique (data_type, range_start, range_end)
);
create index on backfill_chunks (status, data_type, range_start);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table bank_accounts enable row level security;
alter table account_balance_trend enable row level security;
alter table transactions enable row level security;
alter table card_billing_items enable row level security;
alter table tax_invoices enable row level security;
alter table cash_receipts enable row level security;
alter table monthly_revenue enable row level security;
alter table card_holders enable row level security;
alter table account_aliases enable row level security;
alter table party_attrs enable row level security;
alter table sync_state enable row level security;

alter table clobe_oauth_tokens enable row level security;
alter table oauth_pkce_state enable row level security;
alter table clobe_sync_state enable row level security;
alter table backfill_chunks enable row level security;
-- No policies granted on the four internal tables above for anon/authenticated:
-- RLS enabled + zero policies = zero access for those roles. Only service_role
-- (which bypasses RLS) can read/write them.

create policy "auth read" on bank_accounts for select to authenticated using (true);
create policy "auth read" on account_balance_trend for select to authenticated using (true);
create policy "auth read" on transactions for select to authenticated using (true);
create policy "auth read" on card_billing_items for select to authenticated using (true);
create policy "auth read" on tax_invoices for select to authenticated using (true);
create policy "auth read" on cash_receipts for select to authenticated using (true);
create policy "auth read" on monthly_revenue for select to authenticated using (true);
create policy "auth read" on sync_state for select to authenticated using (true);

-- Config tables: shared read+write for any logged-in company user.
create policy "auth read" on card_holders for select to authenticated using (true);
create policy "auth write insert" on card_holders for insert to authenticated with check (true);
create policy "auth write update" on card_holders for update to authenticated using (true) with check (true);

create policy "auth read" on account_aliases for select to authenticated using (true);
create policy "auth write insert" on account_aliases for insert to authenticated with check (true);
create policy "auth write update" on account_aliases for update to authenticated using (true) with check (true);

create policy "auth read" on party_attrs for select to authenticated using (true);
create policy "auth write insert" on party_attrs for insert to authenticated with check (true);
create policy "auth write update" on party_attrs for update to authenticated using (true) with check (true);

grant select on card_statement_view, card_usage_view, monthly_revenue_totals to authenticated;

-- ============================================================
-- Seed: default card holder names (mirrors index.html DEFAULT_HOLDERS)
-- ============================================================

insert into card_holders (card, holder) values
  ('5589-0329-0995', '조*성'),
  ('5589-0318-4921', '조*현'),
  ('5589-0315-7957', '조*철'),
  ('5589-0316-6968', '조*민'),
  ('5531-****-1547', '법인 공용')
on conflict (card) do nothing;

-- Small lookup views so the frontend can get distinct card numbers / party
-- names without pulling the full (potentially multi-year, thousands-of-rows)
-- underlying tables just to build a filter chip list.

create view distinct_cards as
select distinct card_no from card_billing_items;

create view distinct_parties as
select counterparty as party_name from transactions where counterparty is not null
union
select partner_name from tax_invoices where partner_name is not null;

grant select on distinct_cards, distinct_parties to authenticated;

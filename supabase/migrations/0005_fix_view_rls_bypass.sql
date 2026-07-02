-- SECURITY FIX: Postgres views execute with the view owner's row-visibility
-- by default (RLS on the underlying table is evaluated as the view creator,
-- not the querying role) unless the view is marked security_invoker. This
-- meant anon (the public embeddable key) could read full card/party/revenue
-- data through card_usage_view, card_statement_view, monthly_revenue_totals,
-- distinct_cards, and distinct_parties despite RLS being correctly enforced
-- on the underlying tables themselves. Verified via anon-key curl before and
-- after this fix.
alter view card_statement_view set (security_invoker = true);
alter view card_usage_view set (security_invoker = true);
alter view monthly_revenue_totals set (security_invoker = true);
alter view distinct_cards set (security_invoker = true);
alter view distinct_parties set (security_invoker = true);

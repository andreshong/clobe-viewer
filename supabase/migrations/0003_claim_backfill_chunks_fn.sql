-- Atomically claims up to p_limit pending/retryable backfill chunks so
-- concurrent clobe-sync-worker invocations (e.g. overlapping cron ticks)
-- never double-process the same chunk. FOR UPDATE SKIP LOCKED can't be
-- expressed through the supabase-js query builder, hence this RPC.
create or replace function claim_next_backfill_chunks(p_limit int)
returns setof backfill_chunks
language plpgsql
as $$
begin
  return query
  update backfill_chunks
  set status = 'in_progress', updated_at = now()
  where id in (
    select id from backfill_chunks
    where status = 'pending' or (status = 'error' and attempts < 5)
    order by data_type, range_start
    for update skip locked
    limit p_limit
  )
  returning *;
end;
$$;

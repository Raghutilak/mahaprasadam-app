-- ═══════════════════════════════════════════════════════════════════════
-- CASCADING INVENTORY RECOMPUTE
--
-- THE PROBLEM: inventory_openings/inventory_closings are point-in-time
-- SNAPSHOTS, written once when a day is closed. If a staff member later
-- corrects (or deletes) a transaction on an ALREADY-CLOSED day — say,
-- fixing a Cash Sale from 3 days ago via the Reports correction screen —
-- that day's persisted closing snapshot does NOT recompute itself, and
-- neither does every following day's opening/closing, which were each
-- chained forward from it. The correction is real in `sales`/`sale_items`,
-- but every stock figure downstream of that date is now quietly wrong
-- until the next time someone happens to overwrite it. Today is the only
-- date that "self-heals", because today's stock is computed live by the
-- app rather than read from a snapshot.
--
-- THE FIX: re-run close_business_day() — the same authoritative,
-- production function used by the nightly 11:55 PM auto-close — for
-- every date from the corrected day through yesterday, IN ORDER. Each
-- call:
--   • uses that day's UNCHANGED opening (a historical fact — correcting
--     a sale doesn't change what stock the day started with),
--   • recomputes received/sold/adjustments fresh from current data,
--   • overwrites that day's closing AND daily_reports,
--   • overwrites the NEXT day's opening = this day's new closing.
-- So by the time the loop reaches the next date, that date's own
-- inventory_openings row has already been corrected by the previous
-- iteration — the cascade falls out naturally, with zero duplicated
-- formula logic (close_business_day remains the single source of truth
-- for "how a day's numbers are computed").
--
-- Never touches today or later — today isn't closed yet (no persisted
-- snapshot to cascade INTO), so there's nothing to recompute there; the
-- loop condition `d < today` makes calling this with today's date a
-- harmless no-op.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.recompute_inventory_cascade(p_from_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := p_from_date;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if p_from_date is null then
    return;
  end if;

  while d < today loop
    perform public.close_business_day(d);
    d := d + 1;
  end loop;
end;
$$;

-- Callable by the app's staff sessions/anon key, same as the sale/receipt
-- RPCs it's meant to run alongside after a correction.
grant execute on function public.recompute_inventory_cascade(date) to anon, authenticated;

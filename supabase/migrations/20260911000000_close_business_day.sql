-- ═══════════════════════════════════════════════════════════════════════
-- BASELINE CAPTURE — close_business_day (already live in production)
--
-- This migration exists purely so the repo's migration history matches
-- what's actually running in Supabase (nightly pg_cron job at 11:55 PM
-- IST / 18:25 UTC). It is a verbatim capture of the function you
-- provided — nothing in it has been changed. Do NOT confuse this with
-- the old client-side `closeDay()` button in App.jsx, which is separate,
-- known to be broken, and on its way out.
--
-- recompute_inventory_cascade (next migration) calls THIS function
-- repeatedly rather than re-implementing its formula, so there is a
-- single source of truth for "how a day's closing stock is computed".
-- ═══════════════════════════════════════════════════════════════════════

alter table public.sweets
add column if not exists price numeric;

update public.sweets set price = 15  where name = 'Peda';
update public.sweets set price = 15  where name = 'Sandesh';
update public.sweets set price = 25  where name = 'Rasagulla';
update public.sweets set price = 25  where name = 'Rasamalai';
update public.sweets set price = 150 where name = 'Sweet Samosa';
update public.sweets set price = 60  where name = 'Cake';
update public.sweets set price = 60  where name = 'Ladoo';

create or replace function public.close_business_day(p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $function$

declare

  v_next_date              date := p_date + 1;

  v_opening_value          numeric := 0;
  v_received_value         numeric := 0;

  v_cash_sales             numeric := 0;
  v_paytm_sales            numeric := 0;
  v_dept_credit_sales      numeric := 0;
  v_indiv_credit_sales     numeric := 0;

  v_credit_payments_recvd  numeric := 0;

  v_total_sales            numeric := 0;

  v_adjustment_value       numeric := 0;
  v_closing_value          numeric := 0;

  v_has_opening            boolean := false;

begin

  raise notice '============================================================';
  raise notice 'close_business_day(%) starting', p_date;

  -- 1. OPENING STOCK — priority: A. today's inventory_openings, B. yesterday's
  -- inventory_closings. If neither exists, stop (never silently close with 0).
  create temp table tmp_opening (
    sweet_id uuid,
    quantity numeric
  ) on commit drop;

  if exists (select 1 from public.inventory_openings where stock_date = p_date) then
    insert into tmp_opening (sweet_id, quantity)
    select sweet_id, quantity from public.inventory_openings where stock_date = p_date;
    v_has_opening := true;
    raise notice 'Opening source: inventory_openings for %', p_date;

  elsif exists (select 1 from public.inventory_closings where stock_date = p_date - 1) then
    insert into tmp_opening (sweet_id, quantity)
    select sweet_id, quantity from public.inventory_closings where stock_date = p_date - 1;
    v_has_opening := true;
    raise notice 'Opening source: inventory_closings for %', p_date - 1;
  end if;

  if not v_has_opening then
    raise exception
      'Cannot close business day %. No inventory opening exists for % and no inventory closing exists for %.',
      p_date, p_date, p_date - 1;
  end if;

  -- 2. OPENING STOCK VALUE
  select coalesce(sum(t.quantity * coalesce(s.price, 0)), 0)
  into v_opening_value
  from tmp_opening t
  join public.sweets s on s.id = t.sweet_id;

  -- 3. RECEIVED STOCK — dedupe receipts sharing the same notes value.
  create temp table tmp_receipts (receipt_id uuid primary key) on commit drop;

  insert into tmp_receipts (receipt_id)
  select distinct on (coalesce(sr.notes, '__NO_NOTE_' || sr.id::text)) sr.id
  from public.stock_receipts sr
  where sr.receipt_date = p_date
  order by coalesce(sr.notes, '__NO_NOTE_' || sr.id::text), sr.id;

  create temp table tmp_received (sweet_id uuid, quantity numeric) on commit drop;

  insert into tmp_received (sweet_id, quantity)
  select sri.sweet_id, sum(sri.quantity)
  from public.stock_receipt_items sri
  join tmp_receipts tr on tr.receipt_id = sri.receipt_id
  group by sri.sweet_id;

  select coalesce(sum(sri.quantity * sri.rate), 0)
  into v_received_value
  from public.stock_receipt_items sri
  join tmp_receipts tr on tr.receipt_id = sri.receipt_id;

  -- 4. SALES
  select coalesce(sum(total_amount), 0) into v_cash_sales
  from public.sales where sale_date = p_date and sale_type = 'cash';

  select coalesce(sum(total_amount), 0) into v_paytm_sales
  from public.sales where sale_date = p_date and sale_type = 'upi';

  select coalesce(sum(total_amount), 0) into v_dept_credit_sales
  from public.sales where sale_date = p_date and sale_type = 'department_credit';

  select coalesce(sum(total_amount), 0) into v_indiv_credit_sales
  from public.sales where sale_date = p_date and sale_type = 'individual_credit';

  v_total_sales := v_cash_sales + v_paytm_sales + v_dept_credit_sales + v_indiv_credit_sales;

  -- 5. SOLD QUANTITIES — all sale types included
  create temp table tmp_sold (sweet_id uuid, quantity numeric) on commit drop;

  insert into tmp_sold (sweet_id, quantity)
  select si.sweet_id, sum(si.quantity)
  from public.sale_items si
  join public.sales sa on sa.id = si.sale_id
  where sa.sale_date = p_date
  group by si.sweet_id;

  -- 6. CREDIT PAYMENTS RECEIVED
  select coalesce(sum(amount), 0) into v_credit_payments_recvd
  from public.credit_payments where payment_date = p_date;

  -- 7. STOCK ADJUSTMENTS — addition = positive, anything else = negative
  create temp table tmp_adjustments (sweet_id uuid, net_qty numeric) on commit drop;

  insert into tmp_adjustments (sweet_id, net_qty)
  select sweet_id, sum(case when adjustment_type = 'addition' then quantity else -quantity end)
  from public.stock_adjustments
  where adjustment_date = p_date
  group by sweet_id;

  select coalesce(sum(a.net_qty * coalesce(s.price, 0)), 0)
  into v_adjustment_value
  from tmp_adjustments a
  join public.sweets s on s.id = a.sweet_id;

  -- 8. CLOSING STOCK VALUE = opening + received - sales + adjustments
  v_closing_value := v_opening_value + v_received_value - v_total_sales + v_adjustment_value;

  raise notice 'Opening value      = %', v_opening_value;
  raise notice 'Received value     = %', v_received_value;
  raise notice 'Cash sales         = %', v_cash_sales;
  raise notice 'Paytm/UPI sales    = %', v_paytm_sales;
  raise notice 'Department credit  = %', v_dept_credit_sales;
  raise notice 'Individual credit  = %', v_indiv_credit_sales;
  raise notice 'Credit payments    = %', v_credit_payments_recvd;
  raise notice 'Total sales        = %', v_total_sales;
  raise notice 'Adjustments        = %', v_adjustment_value;
  raise notice 'Closing value      = %', v_closing_value;

  -- 9. DAILY REPORT
  insert into public.daily_reports (
    report_date, opening_stock_value, received_stock_value, cash_sales, paytm_sales, upi_sales,
    department_credit_sales, individual_credit_sales, credit_payments_received, closing_stock_value, total_sales
  )
  values (
    p_date, v_opening_value, v_received_value, v_cash_sales, v_paytm_sales, 0,
    v_dept_credit_sales, v_indiv_credit_sales, v_credit_payments_recvd, v_closing_value, v_total_sales
  )
  on conflict (report_date) do update set
    opening_stock_value      = excluded.opening_stock_value,
    received_stock_value     = excluded.received_stock_value,
    cash_sales               = excluded.cash_sales,
    paytm_sales              = excluded.paytm_sales,
    upi_sales                = excluded.upi_sales,
    department_credit_sales  = excluded.department_credit_sales,
    individual_credit_sales  = excluded.individual_credit_sales,
    credit_payments_received = excluded.credit_payments_received,
    closing_stock_value      = excluded.closing_stock_value,
    total_sales               = excluded.total_sales;

  -- 10. CLOSING QUANTITY PER SWEET = opening + received - sold + adjustments
  create temp table tmp_closing (sweet_id uuid, quantity numeric) on commit drop;

  insert into tmp_closing (sweet_id, quantity)
  select
    s.id,
    coalesce(o.quantity, 0) + coalesce(r.quantity, 0) - coalesce(sd.quantity, 0) + coalesce(a.net_qty, 0)
  from public.sweets s
  left join tmp_opening o on o.sweet_id = s.id
  left join tmp_received r on r.sweet_id = s.id
  left join tmp_sold sd on sd.sweet_id = s.id
  left join tmp_adjustments a on a.sweet_id = s.id;

  -- 11. SAVE TODAY'S CLOSING
  insert into public.inventory_closings (stock_date, sweet_id, quantity)
  select p_date, sweet_id, quantity from tmp_closing
  on conflict (stock_date, sweet_id) do update set quantity = excluded.quantity;

  -- 12. CREATE TOMORROW'S OPENING = today's closing
  insert into public.inventory_openings (stock_date, sweet_id, quantity)
  select v_next_date, sweet_id, quantity from tmp_closing
  on conflict (stock_date, sweet_id) do update set quantity = excluded.quantity;

  raise notice 'close_business_day(%) completed successfully.', p_date;
  raise notice 'Tomorrow opening date: %', v_next_date;
  raise notice '============================================================';

end;

$function$;

-- Nightly job (idempotent — safe to re-run this migration).
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'nightly-close-business-day';

select cron.schedule(
  'nightly-close-business-day',
  '25 18 * * *', -- 18:25 UTC = 23:55 IST
  $$ select public.close_business_day((now() at time zone 'Asia/Kolkata')::date); $$
);

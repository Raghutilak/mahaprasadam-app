-- ══════════════════════════════════════════════════════════════════
-- Fixes a real bug in 2026_09_18_all_orders_permission_and_auto_
-- department_credit.sql: the auto-credit trigger it added fires for
-- ANY order whose status is set to confirmed/fulfilled — including
-- every order that already existed (and may have already been entered
-- as a department credit sale manually, the old way, long before this
-- feature existed) — because credited_at started out NULL for every
-- row, old and new alike, with no cutoff between them.
--
-- The practical effect: the next time anything touched an old order's
-- status column (re-saving it, or the nightly due-date sweep picking up
-- an old overdue-but-still-confirmed order), it got auto-credited a
-- SECOND time — once from whatever manual entry already existed for it,
-- once from this new automation — double-deducting today's stock for
-- goods that only actually left the shop once.
--
-- THIS MIGRATION: marks every order that already existed before RIGHT
-- NOW as already-credited, so the trigger leaves all of them alone from
-- this point forward — going forward, auto-credit only ever applies to
-- an order placed after this line was run. It does NOT reverse any
-- duplicate sales already created — see
-- supabase/manual_scripts/diagnose_duplicate_auto_credits.sql for that;
-- that part needs a human to confirm which entries are real duplicates
-- before anything gets deleted.
-- ══════════════════════════════════════════════════════════════════

-- RUN THIS MIGRATION LAST, after you've reviewed
-- supabase/manual_scripts/diagnose_duplicate_auto_credits.sql's query #3
-- and noted down the id of any order in there you know is genuinely new
-- (placed since this feature went live) and genuinely never credited any
-- other way — the backfill below will stop THOSE from ever auto-crediting
-- too, so credit them yourself right after running this, by name:
--   select auto_credit_order('<that order's id>');
-- Ordinary future orders are unaffected either way — this only ever
-- touches orders that are ALREADY confirmed/fulfilled at the moment this
-- runs, once.

-- 1) The corrected auto_credit_order — now calls recompute_inventory_
--    cascade() like every other sale-writing RPC does (see the comment
--    inside it for why this matters).
create or replace function public.auto_credit_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order record;
  v_department_id uuid;
  v_sale_id uuid;
  v_subtotal numeric := 0;
  v_notes text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    return;
  end if;

  if v_order.status not in ('confirmed', 'fulfilled') then
    return;
  end if;
  if v_order.credited_at is not null then
    return;
  end if;
  if v_order.requested_date is null or v_order.requested_date > ist_today() then
    return; -- not due yet — the nightly sweep below will pick it up once it is
  end if;
  if v_order.department is null or btrim(v_order.department) = '' then
    return; -- a customer order, not a staff/department one — nothing to credit
  end if;

  select id into v_department_id from departments where upper(name) = upper(v_order.department);
  if v_department_id is null then
    return; -- unknown department name — leave it uncredited rather than guess
  end if;

  select coalesce(sum(oi.quantity * s.price), 0) into v_subtotal
  from public.order_items oi join public.sweets s on s.id = oi.sweet_id
  where oi.order_id = v_order.id;

  if v_subtotal <= 0 then
    return; -- no priced items on this order — nothing to credit
  end if;

  v_notes := 'Auto-generated — Order #' || left(v_order.id::text, 8)
             || ' accepted for ' || v_order.requested_date::text;

  insert into public.sales (
    sale_date, sale_type, department_id, carrier_id,
    subtotal, discount, total_amount, amount_paid, balance_amount, notes
  ) values (
    ist_today(), 'department_credit', v_department_id, v_order.carrier_id,
    v_subtotal, 0, v_subtotal, 0, v_subtotal, v_notes
  ) returning id into v_sale_id;

  insert into public.sale_items (sale_id, sweet_id, quantity, rate, total_amount)
  select v_sale_id, oi.sweet_id, oi.quantity, s.price, oi.quantity * s.price
  from public.order_items oi join public.sweets s on s.id = oi.sweet_id
  where oi.order_id = v_order.id;

  insert into public.department_ledger_entries (department_id, entry_type, amount, sale_id, description)
  values (v_department_id, 'credit_sale', v_subtotal, v_sale_id, v_notes);

  update public.orders set credited_at = now() where id = v_order.id;

  -- Same call every other sale-writing RPC makes (create_sale_with_items,
  -- correct_credit_sale, delete_sale_entry, create_stock_receipt_with_
  -- items) — a no-op for today (today's stock is computed live, not from
  -- a snapshot) but necessary for the rare case this fires for a date
  -- that's already been closed (e.g. an overdue order finally actioned
  -- after 23:55 but dated for a day already closed by close_business_day).
  perform recompute_inventory_cascade(ist_today());
end;
$function$;

-- 2) The actual fix for the double-credit bug — scoped to confirmed/
--    fulfilled only. A still-pending order is never at risk (it's never
--    been auto-credited, because it's never been confirmed), so leaving
--    its credited_at null is correct: the FIRST time it's genuinely
--    confirmed, from now on, should still auto-credit it.
update public.orders
set credited_at = now()
where credited_at is null
  and status in ('confirmed', 'fulfilled');

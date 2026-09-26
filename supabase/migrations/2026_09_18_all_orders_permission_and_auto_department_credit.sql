-- ══════════════════════════════════════════════════════════════════
-- 1) "All Orders" is no longer a blanket-access tab (see staffAccess.js —
--    canAccess() used to hardcode true for TABS.ORDERS; it now checks
--    allowed_tabs like every other tab). This migration catches the
--    server side up to match: only a staff member who actually HOLDS the
--    'orders' tab (checked via staff_has_tab, so admin always qualifies)
--    may read every order or change an order's status. Everyone else can
--    still read (never update) the orders THEY placed — that's what
--    "My Orders" needs, and it's enforced here, not just left to the
--    frontend's WHERE clause, since every sb.from(...) call already
--    carries the caller's own access token (see supabaseClient.js).
--
-- 2) The moment an order is accepted (confirmed) — or fulfilled outright
--    — for a day that has arrived (today or earlier), it's booked as a
--    Department Credit automatically, through the exact same tables/
--    shape a manual Department Credit entry uses (sales + sale_items +
--    department_ledger_entries), so it shows up in Department Credit
--    reports, dues, and stock-sold figures without anyone re-typing it.
--    A future-dated order that gets accepted today does NOT get credited
--    yet — only once its own day actually arrives — so a small nightly
--    job also sweeps for exactly that case (an already-accepted order
--    whose date has since rolled around). credited_at makes the whole
--    thing idempotent: once set, an order is never credited twice no
--    matter how many times its status changes afterwards or how many
--    times the nightly sweep runs.
-- ══════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists credited_at timestamptz;

-- ── 1) RLS: All Orders (manage) vs My Orders (own, read-only) ─────────

drop policy if exists "staff read all orders" on public.orders;
create policy "staff read all orders"
on public.orders
for select
to authenticated
using (staff_has_tab('orders') or placed_by_staff_id = auth.uid());

drop policy if exists "staff update orders" on public.orders;
create policy "staff update orders"
on public.orders
for update
to authenticated
using (staff_has_tab('orders'))
with check (staff_has_tab('orders'));

drop policy if exists "staff read all order items" on public.order_items;
create policy "staff read all order items"
on public.order_items
for select
to authenticated
using (
  staff_has_tab('orders')
  or exists (
    select 1 from public.orders o
    where o.id = order_items.order_id and o.placed_by_staff_id = auth.uid()
  )
);

-- ── 2) Auto department-credit on acceptance ───────────────────────────

-- Does the actual crediting for ONE order — safe to call repeatedly
-- (credited_at is the idempotency guard). Silently does nothing for an
-- order that isn't eligible yet (not accepted, already credited, dated
-- in the future, or not a department order — e.g. a customer's own
-- retail order from the public Book Order portal, which was already
-- paid for and isn't anyone's credit to begin with).
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

-- Definer-only — never meant to be called directly by a client, only by
-- the trigger and the nightly sweep below (both run as this function's
-- owner regardless of grants, same pattern as close_business_day).
revoke all on function public.auto_credit_order(uuid) from public, anon, authenticated;

-- Fires the instant an order is accepted (or goes straight to fulfilled)
-- for a day that's already here — "immediately" per the requirement,
-- rather than waiting for the nightly sweep.
create or replace function public.trg_auto_credit_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.status in ('confirmed', 'fulfilled') and new.credited_at is null then
    perform public.auto_credit_order(new.id);
  end if;
  return new;
end;
$function$;

drop trigger if exists auto_credit_order_on_status_change on public.orders;
create trigger auto_credit_order_on_status_change
after insert or update of status on public.orders
for each row execute function public.trg_auto_credit_order();

-- Catches the other half of the requirement: an order accepted WHILE
-- still future-dated doesn't get credited by the trigger above (its date
-- hasn't arrived yet — auto_credit_order() checks that and no-ops). Once
-- that date becomes "today", this sweep credits it the same way. Reuses
-- the nightly close-business-day job's pg_cron extension/pattern.
create or replace function public.auto_credit_orders_due_today()
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  r record;
begin
  for r in
    select id from public.orders
    where status in ('confirmed', 'fulfilled')
      and credited_at is null
      and requested_date is not null
      and requested_date <= ist_today()
  loop
    perform public.auto_credit_order(r.id);
  end loop;
end;
$function$;

create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'daily-auto-credit-due-orders';

select cron.schedule(
  'daily-auto-credit-due-orders',
  '35 18 * * *', -- 18:35 UTC = 00:05 IST — just after midnight, so "today" has already rolled over
  $$ select public.auto_credit_orders_due_today(); $$
);

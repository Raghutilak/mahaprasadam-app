-- ============================================================
-- Dashboard: zero-value fix + summary RPC security
-- ============================================================


-- ------------------------------------------------------------
-- 1. Dashboard users may READ stock receipts.
-- Existing receive-tab access remains unchanged.
-- ------------------------------------------------------------

drop policy if exists
  "dashboard-or-receive staff can view stock_receipts"
on public.stock_receipts;

create policy
  "dashboard-or-receive staff can view stock_receipts"
on public.stock_receipts
for select
to authenticated
using (
  staff_has_tab('dashboard')
  or staff_has_tab('receive')
);


-- ------------------------------------------------------------
-- 2. Dashboard users may READ stock receipt items.
-- Existing receive-tab access remains unchanged.
-- ------------------------------------------------------------

drop policy if exists
  "dashboard-or-receive staff can view stock_receipt_items"
on public.stock_receipt_items;

create policy
  "dashboard-or-receive staff can view stock_receipt_items"
on public.stock_receipt_items
for select
to authenticated
using (
  staff_has_tab('dashboard')
  or staff_has_tab('receive')
);


-- ------------------------------------------------------------
-- 3. Dashboard users may READ sales regardless of the
-- operational sale-type tab (cash/paytm/credit).
-- This does NOT grant INSERT/UPDATE/DELETE.
-- ------------------------------------------------------------

drop policy if exists
  "dashboard staff can view all sales"
on public.sales;

create policy
  "dashboard staff can view all sales"
on public.sales
for select
to authenticated
using (
  staff_has_tab('dashboard')
);


-- ------------------------------------------------------------
-- 4. Dashboard users may READ sale items belonging to
-- those sales.
-- This does NOT grant any write access.
-- ------------------------------------------------------------

drop policy if exists
  "dashboard staff can view all sale_items"
on public.sale_items;

create policy
  "dashboard staff can view all sale_items"
on public.sale_items
for select
to authenticated
using (
  staff_has_tab('dashboard')
);


-- ------------------------------------------------------------
-- 5. Dashboard summary RPC: sold stock
-- ------------------------------------------------------------

create or replace function public.get_daily_sold_stock(p_date date)
returns table(
  sale_type text,
  sweet_name text,
  total_qty numeric
)
language sql
stable
security definer
set search_path = public
as $function$
  select
    s.sale_type,
    sw.name,
    sum(si.quantity) as total_qty
  from public.sales s
  join public.sale_items si
    on si.sale_id = s.id
  join public.sweets sw
    on sw.id = si.sweet_id
  where s.sale_date = p_date
    and public.staff_has_tab('dashboard')
  group by s.sale_type, sw.name;
$function$;


-- ------------------------------------------------------------
-- 6. Dashboard summary RPC: stock adjustments
-- ------------------------------------------------------------

create or replace function public.get_daily_stock_adjustments(p_date date)
returns table(
  sweet_name text,
  net_qty numeric
)
language sql
stable
security definer
set search_path = public
as $function$
  select
    sw.name,
    sum(
      case
        when sa.adjustment_type = 'addition'
          then sa.quantity
        else -sa.quantity
      end
    ) as net_qty
  from public.stock_adjustments sa
  join public.sweets sw
    on sw.id = sa.sweet_id
  where sa.adjustment_date = p_date
    and public.staff_has_tab('dashboard')
  group by sw.name;
$function$;


-- ------------------------------------------------------------
-- 7. These are internal Dashboard summary functions.
-- They must never be callable anonymously.
-- ------------------------------------------------------------

revoke execute
on function public.get_daily_sold_stock(date)
from public, anon;

revoke execute
on function public.get_daily_stock_adjustments(date)
from public, anon;

grant execute
on function public.get_daily_sold_stock(date)
to authenticated;

grant execute
on function public.get_daily_stock_adjustments(date)
to authenticated;



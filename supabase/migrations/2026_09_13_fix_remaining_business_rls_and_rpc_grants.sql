-- ============================================================
-- 2026_09_13_fix_remaining_business_rls_and_rpc_grants.sql
-- Remove unintended public/anonymous access from business data
-- and internal RPC functions.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Donations: remove legacy unrestricted access
-- ------------------------------------------------------------

drop policy if exists "allow_all_donations"
on public.donations;


-- ------------------------------------------------------------
-- 2. Orders: remove anonymous unrestricted staff policies
-- ------------------------------------------------------------

drop policy if exists "staff read all orders"
on public.orders;

drop policy if exists "staff update orders"
on public.orders;


-- ------------------------------------------------------------
-- 3. Order items: remove anonymous unrestricted staff policy
-- ------------------------------------------------------------

drop policy if exists "staff read all order items"
on public.order_items;


-- ------------------------------------------------------------
-- 4. Replace order staff access with authenticated staff access
-- ------------------------------------------------------------

create policy "staff read all orders"
on public.orders
for select
to authenticated
using (is_staff());

create policy "staff update orders"
on public.orders
for update
to authenticated
using (is_staff())
with check (is_staff());


create policy "staff read all order items"
on public.order_items
for select
to authenticated
using (is_staff());


-- ------------------------------------------------------------
-- 5. Internal RPCs: remove anonymous execution
-- ------------------------------------------------------------

revoke execute
on function public.close_business_day(date)
from public, anon, authenticated;


revoke execute
on function public.recompute_inventory_cascade(date)
from public, anon;


revoke execute
on function public.create_sale_with_items(jsonb, jsonb)
from public, anon;


revoke execute
on function public.create_credit_sale_with_ledger(
  jsonb,
  jsonb,
  text,
  jsonb
)
from public, anon;


revoke execute
on function public.create_recovery_payment(
  jsonb,
  text,
  jsonb
)
from public, anon;


revoke execute
on function public.update_donation_with_bhogas(
  jsonb,
  jsonb,
  jsonb,
  jsonb
)
from public, anon;


-- ------------------------------------------------------------
-- 6. Internal RPCs are available to authenticated staff/admin
-- ------------------------------------------------------------

grant execute
on function public.recompute_inventory_cascade(date)
to authenticated;


grant execute
on function public.create_sale_with_items(jsonb, jsonb)
to authenticated;


grant execute
on function public.create_credit_sale_with_ledger(
  jsonb,
  jsonb,
  text,
  jsonb
)
to authenticated;


grant execute
on function public.create_recovery_payment(
  jsonb,
  text,
  jsonb
)
to authenticated;


grant execute
on function public.update_donation_with_bhogas(
  jsonb,
  jsonb,
  jsonb,
  jsonb
)
to authenticated;


-- ------------------------------------------------------------
-- 7. Public/customer RPCs remain intentionally available
-- ------------------------------------------------------------

grant execute
on function public.get_public_available_stock()
to anon, authenticated;


grant execute
on function public.create_customer_order(jsonb, jsonb)
to anon, authenticated;
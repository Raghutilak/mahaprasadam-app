-- ══════════════════════════════════════════════════════════════════
-- Fixes: scripts/import_legacy_sheet.py's RPC calls (create_sale_with_
-- items, create_credit_sale_with_ledger, create_recovery_payment) all
-- failing with "permission denied for function ..." when run with the
-- default public/anon key, and continuing to fail with "You do not have
-- access..." even after switching to a service-role key.
--
-- Two separate walls, same underlying cause:
--
-- 1) 2026_09_13_fix_remaining_business_rls_and_rpc_grants.sql revoked
--    EXECUTE on these three functions from `anon` (kept only for
--    `authenticated`) — the anon/publishable key was never going to work
--    for them again after that migration, regardless of anything done
--    since. A service-role key doesn't hit this wall at all: it already
--    has EXECUTE on everything via Supabase's project-wide default
--    privileges, unaffected by grants/revokes aimed at anon/authenticated.
--
-- 2) But is_admin() and is_staff() only ever check auth.uid() / a
--    logged-in user's app_metadata — a service-role request has neither
--    (there's no real "user" behind it), so every staff_has_tab(...)
--    check inside those RPCs still raised "You do not have access..."
--    even with a service-role key. That's what this migration fixes:
--    the service-role JWT always carries a top-level `role: service_role`
--    claim (that's literally how PostgREST knows to switch Postgres role
--    for the request) — trusting that claim is safe precisely because a
--    service-role key already bypasses RLS and table grants entirely, so
--    this doesn't grant it anything it doesn't already effectively have;
--    it just stops these two functions from being the one place that
--    still says no.
-- ══════════════════════════════════════════════════════════════════

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() ->> 'role') = 'service_role'
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_admin() or exists (select 1 from staff_users where id = auth.uid());
$$;

-- Belt-and-suspenders — service_role already has this via Supabase's
-- default privileges, but stating it explicitly means this file doesn't
-- depend on that assumption being true for every project.
grant execute on function public.is_admin() to service_role;
grant execute on function public.is_staff() to service_role;
grant execute on function public.staff_has_tab(text) to service_role;
grant execute on function public.staff_restrict_reports_to_today() to service_role;
grant execute on function public.staff_department_restriction_id() to service_role;
grant execute on function public.create_sale_with_items(jsonb, jsonb) to service_role;
grant execute on function public.create_credit_sale_with_ledger(jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.create_recovery_payment(jsonb, text, jsonb) to service_role;

-- create_stock_receipt_with_items (also called by the import script) isn't
-- defined in any file in this repo — it was created directly via the SQL
-- editor at some point and never checked in — so its exact parameter
-- signature can't be confirmed here. It should already work with a
-- service-role key without any change (service_role already has EXECUTE on
-- it via Supabase's default privileges) — but if it doesn't, run
-- `select pg_get_functiondef(oid) from pg_proc where proname =
-- 'create_stock_receipt_with_items';` in the SQL Editor and check whether
-- it also gates on is_staff()/staff_has_tab()/is_admin(); the fix above
-- already covers it either way, since those are the same functions.

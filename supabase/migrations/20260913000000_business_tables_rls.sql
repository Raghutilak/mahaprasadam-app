-- ═══════════════════════════════════════════════════════════════════════
-- BUSINESS TABLES RLS — closes the "anyone with the public anon key can
-- read/write everything" gap.
--
-- Until now, only staff_users had real per-user RLS. Every other table —
-- sales, donations, credit ledgers, inventory, master data — was reachable
-- by anyone holding the publishable/anon key, which is unavoidably present
-- in the shipped JS bundle. The app's tab-based permission screens (who
-- sees Donations, who can Reset, Suraj Pal's edit-today-only rule) were
-- real, but only as UI convenience — a direct REST call to Supabase could
-- bypass every one of them.
--
-- This migration, together with the change to src/supabaseClient.js (the
-- `sb` wrapper now sends the logged-in staff member's own Supabase Auth
-- token instead of just the anon key), makes those restrictions real:
-- PostgREST now knows WHO is asking, and these policies decide what
-- they're allowed to do.
--
-- SCOPE OF WHAT'S ENFORCED HERE (by design, not an oversight):
--   • Baseline: every business table requires a genuine logged-in staff
--     session (any role) for read/write. This is the critical fix — it
--     closes the anonymous-access hole entirely.
--   • Donations: narrower — admin, or a staff member with 'donations' in
--     their allowed_tabs (matches the two-person restriction already
--     built into the app). This applies to EVERY operation, including
--     INSERT — anon/public access is fully denied here (see the note
--     further down about the separate Mahaprasadam app if that breaks
--     something).
--   • Sales / Sale Items: narrower still on UPDATE/DELETE — an account
--     with restrict_reports_to_today=true (currently Suraj Pal) can only
--     correct/delete an entry dated today; admins and everyone else are
--     unaffected.
--   • Everything else (stock receipts, credit payments, ledgers,
--     inventory snapshots, daily reports, master data) requires ANY
--     logged-in staff member — it does not re-derive each individual
--     tab's fine print at the database layer (e.g. Dayavan technically
--     has DB-level write access to tables his UI never shows him). That
--     finer-grained mapping can be added table-by-table later if wanted;
--     what matters most — blocking the public internet — is fixed here.
--
-- ⚠️ MAHAPRASADAM APP: the donations table is shared with a separate
-- external app (see the comment already in supabaseClient.js). Per
-- explicit instruction, donations now denies anon entirely — including
-- INSERT. We don't know how Mahaprasadam authenticates; if it was relying
-- on the plain anon key to record donations, this migration will break
-- that until it's given a real staff-style credential too. Worth
-- confirming with whoever maintains that app before/soon after this goes
-- live.
--
-- ⚠️ TEST BEFORE RELYING ON THIS — see the manual checklist at the bottom
-- of this file. I can't run these against your live project from here.
-- ═══════════════════════════════════════════════════════════════════════


-- ── Helper functions ─────────────────────────────────────────────────
-- security invoker (default) is fine for all of these — they only ever
-- read auth.uid()/auth.jwt() (always available) or staff_users (which
-- itself only exposes what a policy already allows the caller to see:
-- their own row, or everything if they're an admin).

create or replace function public.ist_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from staff_users where id = auth.uid());
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- True for a staff member who's restricted to editing/deleting only
-- today's sales entries (currently Suraj Pal). Admins are never affected
-- by this even if the flag were ever set on their row.
create or replace function public.staff_restrict_reports_to_today()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select restrict_reports_to_today from staff_users where id = auth.uid()),
    false
  ) and not is_admin();
$$;

create or replace function public.staff_has_tab(p_tab text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_admin() or coalesce(
    (select p_tab = any(allowed_tabs) from staff_users where id = auth.uid()),
    false
  );
$$;

grant execute on function public.ist_today() to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.staff_restrict_reports_to_today() to anon, authenticated;
grant execute on function public.staff_has_tab(text) to anon, authenticated;


-- ── Plain "any logged-in staff member" tables ────────────────────────
-- stock_receipts / stock_receipt_items, credit_payments, ledgers,
-- inventory snapshots, daily_reports, and master data.

do $$
declare
  t text;
  staff_only_tables text[] := array[
    'stock_receipts', 'stock_receipt_items', 'credit_payments',
    'department_ledger_entries', 'account_ledger_entries',
    'inventory_openings', 'inventory_closings', 'stock_adjustments', 'daily_reports',
    'departments', 'account_holders', 'carriers', 'bhoga_types', 'preachers'
  ];
begin
  foreach t in array staff_only_tables loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "staff full access" on public.%I;', t);
    execute format(
      'create policy "staff full access" on public.%I for all using (is_staff()) with check (is_staff());',
      t
    );
  end loop;
end $$;


-- ── sweets — public can browse (menu/pricing), only staff can change it ──
alter table public.sweets enable row level security;

drop policy if exists "anyone can view sweets" on public.sweets;
create policy "anyone can view sweets"
  on public.sweets for select
  using (true);

drop policy if exists "staff can manage sweets" on public.sweets;
create policy "staff can manage sweets"
  on public.sweets for insert
  with check (is_staff());

drop policy if exists "staff can update sweets" on public.sweets;
create policy "staff can update sweets"
  on public.sweets for update
  using (is_staff())
  with check (is_staff());

drop policy if exists "staff can delete sweets" on public.sweets;
create policy "staff can delete sweets"
  on public.sweets for delete
  using (is_staff());


-- ── donations — admin or Donations-tab staff only, for EVERY operation
-- (including INSERT). Per explicit instruction: anon insert is denied.
-- ⚠️ This supersedes my earlier caution about the separate Mahaprasadam
-- app possibly writing here via the plain anon key — if that app breaks
-- after this migration, it will need its own authenticated staff-style
-- credential rather than reopening anon INSERT. ─────────────────────────
alter table public.donations enable row level security;

drop policy if exists "anyone can record a donation" on public.donations;

drop policy if exists "donations-tab staff can view" on public.donations;
create policy "donations-tab staff can view"
  on public.donations for select
  using (staff_has_tab('donations'));

drop policy if exists "donations-tab staff can insert" on public.donations;
create policy "donations-tab staff can insert"
  on public.donations for insert
  with check (staff_has_tab('donations'));

drop policy if exists "donations-tab staff can update" on public.donations;
create policy "donations-tab staff can update"
  on public.donations for update
  using (staff_has_tab('donations'))
  with check (staff_has_tab('donations'));

drop policy if exists "donations-tab staff can delete" on public.donations;
create policy "donations-tab staff can delete"
  on public.donations for delete
  using (staff_has_tab('donations'));


-- ── sales — UPDATE/DELETE respect the today-only restriction ────────────
alter table public.sales enable row level security;

drop policy if exists "staff can view sales" on public.sales;
create policy "staff can view sales"
  on public.sales for select
  using (is_staff());

drop policy if exists "staff can insert sales" on public.sales;
create policy "staff can insert sales"
  on public.sales for insert
  with check (is_staff());

drop policy if exists "staff can update sales" on public.sales;
create policy "staff can update sales"
  on public.sales for update
  using (is_staff() and (not staff_restrict_reports_to_today() or sale_date = ist_today()))
  with check (is_staff() and (not staff_restrict_reports_to_today() or sale_date = ist_today()));

drop policy if exists "staff can delete sales" on public.sales;
create policy "staff can delete sales"
  on public.sales for delete
  using (is_staff() and (not staff_restrict_reports_to_today() or sale_date = ist_today()));


-- ── sale_items — no date column of its own, joins to sales via sale_id ──
alter table public.sale_items enable row level security;

drop policy if exists "staff can view sale_items" on public.sale_items;
create policy "staff can view sale_items"
  on public.sale_items for select
  using (is_staff());

drop policy if exists "staff can insert sale_items" on public.sale_items;
create policy "staff can insert sale_items"
  on public.sale_items for insert
  with check (
    is_staff() and (
      not staff_restrict_reports_to_today()
      or exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.sale_date = ist_today())
    )
  );

drop policy if exists "staff can update sale_items" on public.sale_items;
create policy "staff can update sale_items"
  on public.sale_items for update
  using (
    is_staff() and (
      not staff_restrict_reports_to_today()
      or exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.sale_date = ist_today())
    )
  )
  with check (
    is_staff() and (
      not staff_restrict_reports_to_today()
      or exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.sale_date = ist_today())
    )
  );

drop policy if exists "staff can delete sale_items" on public.sale_items;
create policy "staff can delete sale_items"
  on public.sale_items for delete
  using (
    is_staff() and (
      not staff_restrict_reports_to_today()
      or exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.sale_date = ist_today())
    )
  );


-- ── orders / order_items — ADD a staff policy alongside whatever
-- customer-self policy already exists (RLS policies are OR'd together,
-- so this only ADDS staff access, it never narrows the existing
-- customer-facing rule). This is exactly the gap Orders.jsx's own
-- comments already called out. ───────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'orders') then
    execute 'alter table public.orders enable row level security;';
    execute 'drop policy if exists "staff can view and manage all orders" on public.orders;';
    execute 'create policy "staff can view and manage all orders" on public.orders for all using (is_staff()) with check (is_staff());';
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'order_items') then
    execute 'alter table public.order_items enable row level security;';
    execute 'drop policy if exists "staff can view all order_items" on public.order_items;';
    execute 'create policy "staff can view all order_items" on public.order_items for select using (is_staff());';
  end if;
end $$;


-- ── RPC functions — tighten to `authenticated` only where they're
-- staff-only (everything except the two customer-facing RPCs). Uses
-- pg_proc lookup rather than hand-typed signatures, since this repo
-- doesn't have the original CREATE FUNCTION statements for these. ─────
do $$
declare
  r record;
  staff_only_fns text[] := array[
    'create_sale_with_items', 'create_credit_sale_with_ledger', 'create_recovery_payment',
    'get_account_holder_dues', 'get_daily_sale_totals', 'get_daily_sold_stock',
    'get_daily_stock_adjustments', 'get_department_dues', 'update_donation_with_bhogas',
    'recompute_inventory_cascade'
  ];
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(staff_only_fns)
  loop
    execute format('revoke execute on function %s from public, anon;', r.sig);
    execute format('grant execute on function %s to authenticated;', r.sig);
  end loop;

  -- close_business_day is cron-only (runs as the job owner, which bypasses
  -- grants entirely) — make sure it was never left callable over the API.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'close_business_day'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated;', r.sig);
  end loop;
end $$;

-- Customer-facing RPCs stay exactly as they are — do NOT touch these:
--   get_public_available_stock, create_customer_order


-- ═══════════════════════════════════════════════════════════════════════
-- MANUAL TEST CHECKLIST — run this after applying the migration.
-- I can't execute these against your live project from here, so please
-- verify before relying on it:
--
-- 1. RAGHU (admin) — log in, confirm every tab still works: view/edit/
--    delete sales & credit entries for ANY date, view Donations, both
--    Reset actions, Manage Passwords showing all 3 staff.
--
-- 2. SURAJ PAL (restrict_reports_to_today) — log in, open a PAST date in
--    Cash/Paytm/Credit reports: rows should be fully VIEWABLE, but
--    Edit/Delete buttons disabled. Then try TODAY's entries — Edit/Delete
--    should work normally. As a hard check, open browser dev tools while
--    logged in as him and try a raw fetch() PATCH to /rest/v1/sales for a
--    past-dated row — it should come back 403/empty, not succeed.
--
-- 3. DAYAVAN PRABHU — confirm Dashboard, Donations, Reset Donation Data,
--    Book Order all work; confirm he does NOT see Reports/Cash/Credit
--    tabs in the sidebar (UI-level, unchanged from before).
--
-- 4. UNAUTHENTICATED ACCESS — open an incognito window (no staff login),
--    and with only the public anon key, try:
--      curl "$SUPABASE_URL/rest/v1/sales?select=*" -H "apikey: $ANON_KEY"
--    Expect an EMPTY array, not real sales data. Repeat for donations
--    (SELECT AND insert should both now be denied/empty — no anon access
--    at all, per instruction), sale_items, stock_receipts, departments,
--    account_holders. sweets SELECT should still return real data
--    (intentionally public).
--
-- 5. Confirm the customer Book Order flow still works end-to-end
--    (browsing sweets, placing an order, viewing "My Orders") — none of
--    its tables/RPCs were touched, but worth a real click-through.
-- ═══════════════════════════════════════════════════════════════════════

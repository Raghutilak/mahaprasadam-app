-- 20260910000000_staff_users.sql
-- ══════════════════════════════════════════════════════════════════
-- staff_users
-- Backs the multi-staff login system (replaces the old single
-- hardcoded admin login). Each row is one staff member's login +
-- the list of sidebar tabs they're allowed to see.
--
-- NOTE ON PASSWORDS: per requirements, the admin needs to be able to
-- SEE every staff member's current password (not just reset it), so
-- passwords are stored in plain text here — same trust model as the
-- old hardcoded admin login (this table is gated by the app's own
-- staff-login screen, not a "real" auth system). Do not reuse this
-- pattern for anything customer-facing — customers use real Supabase
-- Auth (see supabaseAuthClient.js), which hashes passwords properly.
-- ══════════════════════════════════════════════════════════════════

create table if not exists staff_users (
  id bigint generated always as identity primary key,
  name text not null,
  email text,                          -- may be null (e.g. mobile-only staff)
  mobile text,                         -- may be null, but at least one of email/mobile is required
  password text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  allowed_tabs text[] not null default '{}',   -- e.g. '{dashboard,donations,reset_donation}'
  restrict_reports_to_today boolean not null default false,
  created_at timestamptz not null default now(),
  constraint staff_users_identifier_required check (email is not null or mobile is not null)
);

-- One-time seed of the three staff accounts set up so far. Safe to run
-- more than once — on_conflict just leaves existing rows untouched
-- since email/mobile aren't declared unique here; if you've already
-- created these rows by hand, skip this block.
--
-- NOTE: 'orders' (Book Order) is included for every staff member below,
-- per policy — Book Order is accessible to all staff regardless of role.
insert into staff_users (name, email, mobile, password, role, allowed_tabs, restrict_reports_to_today)
select * from (values
  ('Raghu Tilak Das', 'raghutilak.das@gmail.com', '8422886705', '123', 'admin',
    array['dashboard','receive','cash','paytm','credit','payment','donations','orders','reports','close',
          'reset_donation','reset_other','export']::text[], false),
  ('Dayavan Prabhu', null, '9819279878', '456', 'staff',
    array['dashboard','donations','reset_donation','orders']::text[], false),
  ('Palsura', 'palsura0@gmail.com', '9004504015', '789', 'staff',
    array['dashboard','receive','cash','paytm','credit','payment','export','reports','orders']::text[], true)
) as seed(name, email, mobile, password, role, allowed_tabs, restrict_reports_to_today)
where not exists (select 1 from staff_users);

-- RLS: the app talks to Supabase with the anon/publishable key (same as every
-- other table here), so keep this table reachable the same way the rest of
-- the app's tables are. If you have RLS enabled project-wide, add a policy
-- here matching your other tables' policy (e.g. allow anon select/insert/update).







-- 20260910010000_staff_auth_security_upgrade.sql
-- ══════════════════════════════════════════════════════════════════
-- Security upgrade: staff login moves from a plaintext-password table
-- to real Supabase Auth (auth.users), same trust model customers
-- already get. This migration REPLACES the old staff_users table from
-- 20260910000000_staff_users.sql.
--
-- After running this, staff_users holds PROFILE data only (name,
-- mobile, role, allowed tabs) — no passwords at all. Passwords live in
-- Supabase's own auth.users, hashed, and are only ever touched via:
--   • supabase.auth.signInWithPassword()   — staff logging in
--   • supabase.auth.updateUser()           — a staff member changing
--                                             their OWN password
--   • the admin-staff-management Edge Function, using the service-role
--     key (never shipped to the browser/Vercel) — admin creating a
--     staff account or resetting someone else's password
--
-- IMPORTANT — run scripts/bootstrap-staff.mjs once after this migration
-- to (re)create the 3 staff accounts as real Supabase Auth users. Until
-- you do, nobody can log in (the old rows are gone).
-- ══════════════════════════════════════════════════════════════════

drop table if exists staff_users;

create table staff_users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text,
  mobile text,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  allowed_tabs text[] not null default '{}',
  restrict_reports_to_today boolean not null default false,
  created_at timestamptz not null default now()
);

alter table staff_users enable row level security;

-- A staff member can always read their own profile (used to build the
-- sidebar/tab list after they log in).
create policy "staff can read own profile"
  on staff_users for select
  using (auth.uid() = id);

-- Admins can read/insert/update/delete every profile row. "Admin" here
-- means the JWT's app_metadata.role = 'admin' — app_metadata can ONLY be
-- set via the Supabase Admin API (service-role key), i.e. from inside the
-- admin-staff-management Edge Function or the bootstrap script, never by
-- a user themselves. This is what keeps a staff member from just editing
-- their own row to grant themselves more tabs.
create policy "admin can manage all profiles"
  on staff_users for all
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Note: password reset / staff creation are NOT plain table writes —
-- they go through the Edge Function (below) since only the Admin API can
-- create an auth.users row or change someone else's password.
















-- 20260911000000_close_business_day.sql
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
















-- 20260912000000_inventory_cascade_recompute.sql
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













-- 20260913000000_business_tables_rls.sql
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

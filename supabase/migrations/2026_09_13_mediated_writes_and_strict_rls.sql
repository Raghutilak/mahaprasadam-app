-- ═══════════════════════════════════════════════════════════════════════
-- STRICT PER-OPERATION AUTHORIZATION
--
-- Supersedes the blanket "any logged-in staff member" policies from
-- 20260913000000_business_tables_rls.sql. That migration correctly closed
-- the anonymous-access hole, but was still too broad: a legitimate
-- low-privilege staff member with a valid token could directly call the
-- REST API and write/delete rows their assigned tabs never show them.
--
-- New rules, matching the requested model exactly:
--   SELECT / INSERT / UPDATE → allowed per-tab (staff_has_tab(...)),
--     exactly matching what that person's sidebar actually shows them.
--   DELETE → staff: NEVER, at the raw table level. Every "delete a whole
--     entry" action (a sale, a credit entry, a donation) and every bulk
--     reset now goes through a SECURITY DEFINER function that itself
--     re-checks the caller's tab/role AND validates the operation, rather
--     than relying on a client-side button being hidden. Admin still
--     performs deletes only via these same functions (or, for a single
--     already-identified row like one donation, via an admin-only RLS
--     policy) — "only where absolutely necessary", not a standing grant.
--
-- Also folds in: server-side validation (quantity > 0, valid sale/payment
-- type, sweet exists, sale exists) — the app's own UI already checks most
-- of this, but these functions no longer trust the client's arithmetic —
-- totals are recomputed from `sweets.price` server-side, never taken as
-- given from the request body.
-- ═══════════════════════════════════════════════════════════════════════


-- ── Extra helper: which tab governs a given sale_type ────────────────
create or replace function public.sale_type_tab(p_sale_type text)
returns text
language sql
immutable
as $$
  select case p_sale_type
    when 'cash' then 'cash'
    when 'upi' then 'paytm'
    else 'credit' -- department_credit, individual_credit
  end;
$$;

grant execute on function public.sale_type_tab(text) to anon, authenticated;


-- ── sales / sale_items — tab-scoped SELECT, NO staff INSERT/UPDATE/DELETE
-- grants at all (every write already goes through security-definer RPCs:
-- create_sale_with_items / create_credit_sale_with_ledger for creation,
-- and the new correct_*/delete_sale_entry functions below for edits) ────
drop policy if exists "staff can view sales" on public.sales;
drop policy if exists "staff can insert sales" on public.sales;
drop policy if exists "staff can update sales" on public.sales;
drop policy if exists "staff can delete sales" on public.sales;

create policy "staff can view sales per tab"
  on public.sales for select
  using (staff_has_tab(sale_type_tab(sale_type)));

drop policy if exists "staff can view sale_items" on public.sale_items;
drop policy if exists "staff can insert sale_items" on public.sale_items;
drop policy if exists "staff can update sale_items" on public.sale_items;
drop policy if exists "staff can delete sale_items" on public.sale_items;

create policy "staff can view sale_items per tab"
  on public.sale_items for select
  using (exists (
    select 1 from public.sales s
    where s.id = sale_items.sale_id and staff_has_tab(sale_type_tab(s.sale_type))
  ));

-- No staff INSERT/UPDATE/DELETE policy on sales or sale_items at all —
-- absence of a policy for a command = denied once RLS is enabled. All
-- legitimate writes happen inside the SECURITY DEFINER functions below,
-- which run as the function owner and are therefore unaffected by RLS.


-- ── correct_cash_or_paytm_sale — replaces the old client-side delete+
-- reinsert of sale_items for Cash/Paytm corrections. ─────────────────
create or replace function public.correct_cash_or_paytm_sale(p_sale_id bigint, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_item jsonb;
  v_price numeric;
  v_new_total numeric := 0;
begin
  select * into v_sale from sales where id = p_sale_id;
  if not found then
    raise exception 'This entry no longer exists — it may have been deleted elsewhere.';
  end if;

  if v_sale.sale_type not in ('cash', 'upi') then
    raise exception 'Wrong function for this sale type — use correct_credit_sale instead.';
  end if;

  if not staff_has_tab(sale_type_tab(v_sale.sale_type)) then
    raise exception 'You do not have access to correct this entry.';
  end if;

  if staff_restrict_reports_to_today() and v_sale.sale_date <> ist_today() then
    raise exception 'Your account can only edit today''s entries.';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one item with a quantity greater than zero is required.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if (v_item->>'quantity') is null or (v_item->>'quantity')::numeric <= 0 then
      raise exception 'Quantity must be greater than zero for every item.';
    end if;
    select price into v_price from sweets where id = (v_item->>'sweet_id')::uuid;
    if v_price is null then
      raise exception 'Unknown sweet in correction.';
    end if;
    v_new_total := v_new_total + v_price * (v_item->>'quantity')::numeric;
  end loop;

  delete from sale_items where sale_id = p_sale_id;

  insert into sale_items (sale_id, sweet_id, quantity, rate, total_amount)
  select
    p_sale_id,
    (i->>'sweet_id')::uuid,
    (i->>'quantity')::numeric,
    s.price,
    (i->>'quantity')::numeric * s.price
  from jsonb_array_elements(p_items) i
  join sweets s on s.id = (i->>'sweet_id')::uuid;

  update sales set subtotal = v_new_total, total_amount = v_new_total, amount_paid = v_new_total, balance_amount = 0 where id = p_sale_id;

  perform recompute_inventory_cascade(v_sale.sale_date);
end;
$$;

-- ── correct_credit_sale — Department/Individual credit corrections:
-- same item replacement, plus the department/carrier/account-holder/notes
-- fields and the offsetting ledger "correction" entry. ────────────────
create or replace function public.correct_credit_sale(
  p_sale_id bigint,
  p_items jsonb,
  p_department_id uuid default null,
  p_carrier_id uuid default null,
  p_account_holder_id uuid default null,
  p_reference_type text default null,
  p_reference_name text default null,
  p_customer_name text default null,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_item jsonb;
  v_price numeric;
  v_new_total numeric := 0;
  v_delta numeric;
  v_is_department boolean;
begin
  select * into v_sale from sales where id = p_sale_id;
  if not found then
    raise exception 'This entry no longer exists — it may have been deleted elsewhere.';
  end if;

  if v_sale.sale_type not in ('department_credit', 'individual_credit') then
    raise exception 'Wrong function for this sale type — use correct_cash_or_paytm_sale instead.';
  end if;
  v_is_department := v_sale.sale_type = 'department_credit';

  if not staff_has_tab('credit') then
    raise exception 'You do not have access to correct this entry.';
  end if;

  if staff_restrict_reports_to_today() and v_sale.sale_date <> ist_today() then
    raise exception 'Your account can only edit today''s entries.';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one item with a quantity greater than zero is required.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if (v_item->>'quantity') is null or (v_item->>'quantity')::numeric <= 0 then
      raise exception 'Quantity must be greater than zero for every item.';
    end if;
    select price into v_price from sweets where id = (v_item->>'sweet_id')::uuid;
    if v_price is null then
      raise exception 'Unknown sweet in correction.';
    end if;
    v_new_total := v_new_total + v_price * (v_item->>'quantity')::numeric;
  end loop;

  if v_is_department and p_department_id is null then
    raise exception 'A department is required.';
  end if;
  if not v_is_department and p_account_holder_id is null then
    raise exception 'An account holder is required.';
  end if;

  delete from sale_items where sale_id = p_sale_id;

  insert into sale_items (sale_id, sweet_id, quantity, rate, total_amount)
  select
    p_sale_id, (i->>'sweet_id')::uuid, (i->>'quantity')::numeric, s.price, (i->>'quantity')::numeric * s.price
  from jsonb_array_elements(p_items) i
  join sweets s on s.id = (i->>'sweet_id')::uuid;

  update sales set
    subtotal = v_new_total,
    total_amount = v_new_total,
    customer_name = coalesce(p_customer_name, customer_name),
    notes = p_notes,
    department_id = case when v_is_department then p_department_id else department_id end,
    carrier_id = case when v_is_department then p_carrier_id else carrier_id end,
    account_holder_id = case when v_is_department then account_holder_id else p_account_holder_id end,
    reference_type = case when v_is_department then reference_type else p_reference_type end,
    reference_name = case when v_is_department then reference_name else p_reference_name end
  where id = p_sale_id;

  v_delta := v_new_total - coalesce(v_sale.total_amount, 0);
  if v_delta <> 0 then
    if v_is_department then
      insert into department_ledger_entries (department_id, entry_type, amount, description)
      values (coalesce(p_department_id, v_sale.department_id), 'correction', v_delta, format('Correction to entry #%s', p_sale_id));
    else
      insert into account_ledger_entries (account_holder_id, entry_type, amount, description)
      values (coalesce(p_account_holder_id, v_sale.account_holder_id), 'correction', v_delta, format('Correction to entry #%s', p_sale_id));
    end if;
  end if;

  perform recompute_inventory_cascade(v_sale.sale_date);
end;
$$;

-- ── delete_sale_entry — handles Cash/Paytm/Department/Individual credit
-- deletion uniformly, including the ledger reversal for credit types. ──
create or replace function public.delete_sale_entry(p_sale_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
begin
  select * into v_sale from sales where id = p_sale_id;
  if not found then
    return; -- already gone — treat as success, matches the app's existing "already deleted elsewhere" handling
  end if;

  if not staff_has_tab(sale_type_tab(v_sale.sale_type)) then
    raise exception 'You do not have access to delete this entry.';
  end if;

  if staff_restrict_reports_to_today() and v_sale.sale_date <> ist_today() then
    raise exception 'Your account can only delete today''s entries.';
  end if;

  delete from sale_items where sale_id = p_sale_id;
  delete from sales where id = p_sale_id;

  if v_sale.sale_type = 'department_credit' and v_sale.total_amount <> 0 then
    insert into department_ledger_entries (department_id, entry_type, amount, description)
    values (v_sale.department_id, 'correction', -v_sale.total_amount, format('Reversal — deleted entry #%s', p_sale_id));
  elsif v_sale.sale_type = 'individual_credit' and v_sale.total_amount <> 0 then
    insert into account_ledger_entries (account_holder_id, entry_type, amount, description)
    values (v_sale.account_holder_id, 'correction', -v_sale.total_amount, format('Reversal — deleted entry #%s', p_sale_id));
  end if;

  perform recompute_inventory_cascade(v_sale.sale_date);
end;
$$;

grant execute on function public.correct_cash_or_paytm_sale(bigint, jsonb) to authenticated;
grant execute on function public.correct_credit_sale(bigint, jsonb, uuid, uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.delete_sale_entry(bigint) to authenticated;
revoke execute on function public.correct_cash_or_paytm_sale(bigint, jsonb) from anon, public;
revoke execute on function public.correct_credit_sale(bigint, jsonb, uuid, uuid, uuid, text, text, text, text) from anon, public;
revoke execute on function public.delete_sale_entry(bigint) from anon, public;


-- ── stock_receipt_items correction (Receive tab) — same delete+reinsert
-- pattern, mediated. stock_receipts rows themselves are created only by
-- the pg_cron `process_scheduled_receipt` job — the app never inserts a
-- new receipt header, only corrects an existing one's line items. ─────
drop policy if exists "staff full access" on public.stock_receipt_items;
create policy "receive-tab staff can view stock_receipt_items"
  on public.stock_receipt_items for select
  using (staff_has_tab('receive'));
-- no staff insert/update/delete policy — mediated by the function below

drop policy if exists "staff full access" on public.stock_receipts;
create policy "receive-tab staff can view stock_receipts"
  on public.stock_receipts for select
  using (staff_has_tab('receive'));

create or replace function public.correct_stock_receipt(p_receipt_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt record;
  v_item jsonb;
begin
  select * into v_receipt from stock_receipts where id = p_receipt_id;
  if not found then
    raise exception 'This receipt no longer exists.';
  end if;

  if not staff_has_tab('receive') then
    raise exception 'You do not have access to correct receiving records.';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one item with a quantity greater than zero is required.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if (v_item->>'quantity') is null or (v_item->>'quantity')::numeric <= 0 then
      raise exception 'Quantity must be greater than zero for every item.';
    end if;
    if not exists (select 1 from sweets where id = (v_item->>'sweet_id')::uuid) then
      raise exception 'Unknown sweet in correction.';
    end if;
  end loop;

  delete from stock_receipt_items where receipt_id = p_receipt_id;

  insert into stock_receipt_items (receipt_id, sweet_id, quantity, rate)
  select p_receipt_id, (i->>'sweet_id')::uuid, (i->>'quantity')::numeric, coalesce((i->>'rate')::numeric, 0)
  from jsonb_array_elements(p_items) i;

  perform recompute_inventory_cascade(v_receipt.receipt_date);
end;
$$;

grant execute on function public.correct_stock_receipt(uuid, jsonb) to authenticated;
revoke execute on function public.correct_stock_receipt(uuid, jsonb) from anon, public;


-- ── credit_payments — view-only for staff at the table level (creation
-- already goes through create_recovery_payment; no correction/delete UI
-- exists for these today, so no mediated function needed yet). ────────
drop policy if exists "staff full access" on public.credit_payments;
create policy "payment-tab staff can view credit_payments"
  on public.credit_payments for select
  using (staff_has_tab('payment'));


-- ── ledger entries — view-only for staff directly; all writes happen
-- inside the RPCs above (create_credit_sale_with_ledger, correct_credit_
-- sale, delete_sale_entry, create_recovery_payment). ───────────────────
drop policy if exists "staff full access" on public.department_ledger_entries;
create policy "credit-or-payment staff can view department_ledger_entries"
  on public.department_ledger_entries for select
  using (staff_has_tab('credit') or staff_has_tab('payment'));

drop policy if exists "staff full access" on public.account_ledger_entries;
create policy "credit-or-payment staff can view account_ledger_entries"
  on public.account_ledger_entries for select
  using (staff_has_tab('credit') or staff_has_tab('payment'));


-- ── donations — per-operation, admin-only DELETE (single-row, no bulk
-- reset here — that's its own RPC further down). ───────────────────────
drop policy if exists "donations-tab staff can delete" on public.donations;
create policy "admin can delete a donation"
  on public.donations for delete
  using (is_admin());
-- select/insert/update policies from the previous migration (staff_has_tab
-- based) are unchanged and still apply.


-- ── stock_adjustments (Receive tab's "Adjust Stock") — staff can view/
-- insert, never delete/update an adjustment once made (it's meant to be
-- an immutable audit trail, same spirit as a journal entry). ──────────
drop policy if exists "staff full access" on public.stock_adjustments;
create policy "receive-tab staff can view stock_adjustments"
  on public.stock_adjustments for select
  using (staff_has_tab('receive'));
create policy "receive-tab staff can insert stock_adjustments"
  on public.stock_adjustments for insert
  with check (
    staff_has_tab('receive')
    and quantity > 0
    and adjustment_type in ('addition', 'reduction')
    and adjustment_date = ist_today()
  );


-- ── inventory_openings / inventory_closings / daily_reports — these
-- should ONLY ever be written by close_business_day/recompute_inventory_
-- cascade (both security definer, unaffected by RLS). No staff write
-- policy at all — if the old client-side closeDay() button is still
-- wired up anywhere, this is what finally makes it stop working; that's
-- intentional; it's being removed. ─────────────────────────────────────
drop policy if exists "staff full access" on public.inventory_openings;
create policy "dashboard-or-reports staff can view inventory_openings"
  on public.inventory_openings for select
  using (staff_has_tab('dashboard') or staff_has_tab('reports'));

drop policy if exists "staff full access" on public.inventory_closings;
create policy "dashboard-or-reports staff can view inventory_closings"
  on public.inventory_closings for select
  using (staff_has_tab('dashboard') or staff_has_tab('reports'));

drop policy if exists "staff full access" on public.daily_reports;
create policy "reports staff can view daily_reports"
  on public.daily_reports for select
  using (staff_has_tab('reports'));


-- ── Master data (departments, account_holders, carriers, bhoga_types,
-- preachers) — broad staff SELECT (shared reference lookups used across
-- several tabs), tab-scoped INSERT/UPDATE for the flow that actually
-- creates them, staff never deletes (admin-only, referential integrity
-- protects against orphaning history anyway). ─────────────────────────
do $$
declare
  t text;
  tabs text;
  spec record;
  master_specs jsonb := '[
    {"table":"departments","tabs":"credit"},
    {"table":"account_holders","tabs":"credit,payment"},
    {"table":"carriers","tabs":"credit"},
    {"table":"bhoga_types","tabs":"donations"},
    {"table":"preachers","tabs":"donations"}
  ]';
begin
  for spec in select * from jsonb_to_recordset(master_specs) as x(table_ text, tabs text) loop
    t := spec.table_;
    execute format('drop policy if exists "staff full access" on public.%I;', t);

    execute format('create policy "staff can view %s" on public.%I for select using (is_staff());', t, t);

    execute format(
      'create policy "tab staff can insert %s" on public.%I for insert with check (%s);',
      t, t,
      (select string_agg(format('staff_has_tab(%L)', trim(tab)), ' or ')
       from unnest(string_to_array(spec.tabs, ',')) as tab)
    );

    execute format(
      'create policy "tab staff can update %s" on public.%I for update using (%s) with check (%s);',
      t, t,
      (select string_agg(format('staff_has_tab(%L)', trim(tab)), ' or ') from unnest(string_to_array(spec.tabs, ',')) as tab),
      (select string_agg(format('staff_has_tab(%L)', trim(tab)), ' or ') from unnest(string_to_array(spec.tabs, ',')) as tab)
    );

    execute format('create policy "admin can delete %s" on public.%I for delete using (is_admin());', t, t);
  end loop;
end $$;


-- ── sweets — public SELECT unchanged; staff can seed if empty, admin
-- only for price changes/deletes (no staff price-edit UI exists today). ─
drop policy if exists "staff can manage sweets" on public.sweets;
create policy "staff can insert sweets"
  on public.sweets for insert
  with check (is_staff());

drop policy if exists "staff can update sweets" on public.sweets;
create policy "admin can update sweets"
  on public.sweets for update
  using (is_admin())
  with check (is_admin());

drop policy if exists "staff can delete sweets" on public.sweets;
create policy "admin can delete sweets"
  on public.sweets for delete
  using (is_admin());


-- ═══════════════════════════════════════════════════════════════════════
-- ADMIN-ONLY RESET RPCs — replace the client's raw deleteAll() calls for
-- both Reset Donation Data and Reset Other Data.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function public.admin_reset_donation_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can do this.';
  end if;
  delete from donations;
end;
$$;

create or replace function public.admin_reset_other_data(p_include_master boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can do this.';
  end if;

  delete from sale_items;
  delete from stock_receipt_items;
  delete from department_ledger_entries;
  delete from account_ledger_entries;
  delete from credit_payments;
  delete from sales;
  delete from stock_receipts;
  delete from inventory_openings;
  delete from inventory_closings;
  delete from stock_adjustments;
  delete from daily_reports;

  if p_include_master then
    delete from departments;
    delete from account_holders;
    delete from carriers;
    delete from sweets;
    delete from bhoga_types;
    delete from preachers;
  end if;
end;
$$;

grant execute on function public.admin_reset_donation_data() to authenticated;
grant execute on function public.admin_reset_other_data(boolean) to authenticated;
revoke execute on function public.admin_reset_donation_data() from anon, public;
revoke execute on function public.admin_reset_other_data(boolean) from anon, public;


-- ═══════════════════════════════════════════════════════════════════════
-- STILL NEEDED FROM YOU — I don't have the source for these, so I could
-- not audit or harden them (they exist live in your Supabase project but
-- aren't in this repo's migration history):
--   • create_sale_with_items, create_credit_sale_with_ledger,
--     create_recovery_payment, update_donation_with_bhogas
--   • get_account_holder_dues, get_daily_sale_totals, get_daily_sold_stock,
--     get_daily_stock_adjustments, get_department_dues
--   • create_customer_order, get_public_available_stock
--   • process_scheduled_receipt and whatever else is in
--     auto_scheduled_receipts_and_credits.sql
-- Run `select pg_get_functiondef(oid) from pg_proc where proname = '...';`
-- for each in the SQL Editor and share the output, and I'll review them
-- for the same things this migration handles for the functions above
-- (quantity/amount > 0, valid references, no trusting client-computed
-- totals) plus tighten their grants the same way.
-- ═══════════════════════════════════════════════════════════════════════

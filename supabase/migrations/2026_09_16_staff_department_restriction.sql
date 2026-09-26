-- ══════════════════════════════════════════════════════════════════
-- Department-restricted staff accounts.
--
-- A staff member can now be scoped to just ONE department: they can
-- still be granted the Reports / Book Orders tabs exactly as before
-- (allowed_tabs is unchanged), but when this column is set, they only
-- ever see or place THAT department's rows. Enforced here at the RLS
-- level — not just the frontend hiding a dropdown — because every
-- sb.from(...)/sb.rpc(...) call in this app already carries the logged-in
-- staff member's own access token (see supabaseClient.js), so a
-- department-restricted user calling Supabase directly and bypassing the
-- UI entirely still can't read another department's sales, recoveries,
-- or ledger.
--
-- NULL (the default) = no restriction — exactly today's behavior for
-- every existing staff account. Admins are never restricted by this,
-- regardless of what this column holds (mirrors the existing
-- staff_restrict_reports_to_today() carve-out for admins).
-- ══════════════════════════════════════════════════════════════════

alter table public.staff_users
  add column if not exists restrict_to_department text;

-- Resolves the CURRENT staff member's department restriction to the
-- matching departments.id — NULL if unrestricted. Stored as a NAME on
-- staff_users (matching how the rest of the app already refers to
-- departments by name, e.g. CreditReport.jsx's department dropdown), so
-- this does the name -> id lookup once per check.
create or replace function public.staff_department_restriction_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select d.id
  from staff_users su
  join departments d on upper(d.name) = upper(su.restrict_to_department)
  where su.id = auth.uid()
    and su.restrict_to_department is not null
    and not is_admin();
$$;

grant execute on function public.staff_department_restriction_id() to anon, authenticated;

-- ── sales / sale_items — view restricted to the matching department;
--    rows with no department at all (cash/paytm/individual credit) are
--    untouched by this — it only ever narrows department-credit rows,
--    layered on top of (not replacing) the existing permissive policies. ──
drop policy if exists "department-restricted staff view only their department (sales)" on public.sales;
create policy "department-restricted staff view only their department (sales)"
  on public.sales as restrictive for select
  using (
    staff_department_restriction_id() is null
    or department_id is null
    or department_id = staff_department_restriction_id()
  );

drop policy if exists "department-restricted staff insert only their department (sales)" on public.sales;
create policy "department-restricted staff insert only their department (sales)"
  on public.sales as restrictive for insert
  with check (
    staff_department_restriction_id() is null
    or department_id is null
    or department_id = staff_department_restriction_id()
  );

drop policy if exists "department-restricted staff view only their department (sale_items)" on public.sale_items;
create policy "department-restricted staff view only their department (sale_items)"
  on public.sale_items as restrictive for select
  using (
    staff_department_restriction_id() is null
    or exists (
      select 1 from public.sales s
      where s.id = sale_items.sale_id
        and (s.department_id is null or s.department_id = staff_department_restriction_id())
    )
  );

drop policy if exists "department-restricted staff insert only their department (sale_items)" on public.sale_items;
create policy "department-restricted staff insert only their department (sale_items)"
  on public.sale_items as restrictive for insert
  with check (
    staff_department_restriction_id() is null
    or exists (
      select 1 from public.sales s
      where s.id = sale_items.sale_id
        and (s.department_id is null or s.department_id = staff_department_restriction_id())
    )
  );

-- ── credit_payments — recovery payments, view-only for staff at the
--    table level already (creation goes through create_recovery_payment,
--    a security-definer function — see the note at the end of this file
--    about that RPC's own department check). ──────────────────────────
drop policy if exists "department-restricted staff view only their department (credit_payments)" on public.credit_payments;
create policy "department-restricted staff view only their department (credit_payments)"
  on public.credit_payments as restrictive for select
  using (
    staff_department_restriction_id() is null
    or department_id is null
    or department_id = staff_department_restriction_id()
  );

-- ── department_ledger_entries — always has a department_id (unlike the
--    two tables above, there's no "ungated" row shape here to leave
--    alone). ─────────────────────────────────────────────────────────
drop policy if exists "department-restricted staff view only their department (department_ledger_entries)" on public.department_ledger_entries;
create policy "department-restricted staff view only their department (department_ledger_entries)"
  on public.department_ledger_entries as restrictive for select
  using (
    staff_department_restriction_id() is null
    or department_id = staff_department_restriction_id()
  );

-- ══════════════════════════════════════════════════════════════════
-- GAP CLOSED in 2026_09_19_close_department_restriction_gap.sql:
-- create_recovery_payment and create_credit_sale_with_ledger are both
-- SECURITY DEFINER, so they bypassed RLS (including the restrictive
-- policy above) for their own INSERTs — meaning a department-restricted
-- staff member who was ALSO granted the 'payment' or 'credit' tab could,
-- in principle, log a recovery or credit sale against a department other
-- than their own through those RPCs. Today's two accounts (dayavananitai,
-- Sundarananda) are NOT granted 'payment' or 'credit', so this never
-- actually affected them in practice — but both functions now carry the
-- same staff_department_restriction_id() check create_staff_order() has,
-- so it's safe even if a department-restricted account is ever also given
-- Credit Sale or Credit Recovery access. Apply that migration after this
-- one (it depends on staff_department_restriction_id(), created above).
-- ══════════════════════════════════════════════════════════════════

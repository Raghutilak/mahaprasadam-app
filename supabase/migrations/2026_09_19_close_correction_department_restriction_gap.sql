-- ══════════════════════════════════════════════════════════════════
-- Closes a second department-restriction gap, this time in the
-- CORRECTION path rather than the creation path (2026_09_19_close_
-- department_restriction_gap.sql already covered creation via
-- create_credit_sale_with_ledger / create_recovery_payment).
--
-- correct_credit_sale and delete_sale_entry are both SECURITY DEFINER
-- and neither checked staff_department_restriction_id() at all — so a
-- department-restricted staff member granted the 'credit' tab could, in
-- principle:
--   • open ANY department's credit entry for correction (not just their
--     own department's), via CreditReport.jsx's "✏️ Correct" flow
--   • reassign an entry to a DIFFERENT department entirely, since
--     correct_credit_sale takes p_department_id as a plain parameter
--     with no ownership check
--   • delete any department's credit entry via delete_sale_entry
--
-- Individual credit entries (account_holder_id, not department_id) are
-- deliberately left unrestricted by this, same as the original
-- 2026_09_16 migration's design: department restriction is about
-- departments, not individual account holders, so it never narrowed
-- individual-credit rows to begin with.
--
-- Requires 2026_09_16_staff_department_restriction.sql to already be
-- applied (staff_department_restriction_id() must exist).
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.correct_credit_sale(
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
  v_restricted_dept_id uuid;
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

  -- Department-restriction check: only ever the EXISTING entry's own
  -- department, and (for a department entry) never reassigned away from
  -- it either. Doesn't apply to individual_credit at all — see the note
  -- at the top of this file.
  v_restricted_dept_id := staff_department_restriction_id();
  if v_restricted_dept_id is not null then
    if not v_is_department
       or v_sale.department_id is distinct from v_restricted_dept_id
       or p_department_id is distinct from v_restricted_dept_id
    then
      raise exception 'Your account can only correct credit entries for your own department.';
    end if;
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

CREATE OR REPLACE FUNCTION public.delete_sale_entry(p_sale_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  v_restricted_dept_id uuid;
begin
  select * into v_sale from sales where id = p_sale_id;
  if not found then
    return; -- already gone — treat as success, matches the app's existing "already deleted elsewhere" handling
  end if;

  if not staff_has_tab(sale_type_tab(v_sale.sale_type)) then
    raise exception 'You do not have access to delete this entry.';
  end if;

  -- Same department-restriction check as correct_credit_sale — only their
  -- own department's department_credit rows; cash/upi/individual_credit
  -- (department_id is null) are untouched by this, same as the read-side
  -- RLS policies from 2026_09_16_staff_department_restriction.sql.
  v_restricted_dept_id := staff_department_restriction_id();
  if v_restricted_dept_id is not null and v_sale.department_id is not null
     and v_sale.department_id is distinct from v_restricted_dept_id then
    raise exception 'Your account can only delete credit entries for your own department.';
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

-- Signatures are unchanged — restating the original grants so this file
-- is safe to run on its own regardless of history.
grant execute on function public.correct_credit_sale(bigint, jsonb, uuid, uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.delete_sale_entry(bigint) to authenticated;
revoke execute on function public.correct_credit_sale(bigint, jsonb, uuid, uuid, uuid, text, text, text, text) from anon, public;
revoke execute on function public.delete_sale_entry(bigint) from anon, public;

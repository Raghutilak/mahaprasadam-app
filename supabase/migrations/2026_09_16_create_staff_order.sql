-- ══════════════════════════════════════════════════════════════════
-- Staff-placed orders — a logged-in staff member (e.g. a department
-- account holder) booking an order themselves, distinct from
-- create_customer_order (the public-facing Book Order portal).
--
-- Order for TODAY: capped by the same live available stock the public
-- portal uses (get_public_available_stock()) — reused directly rather
-- than re-implementing that formula here.
--
-- Order for a FUTURE day: today's live stock doesn't mean anything for a
-- day that hasn't happened yet, so instead every item is capped at a
-- flat 100 units. Anything beyond that (or any other request/feedback)
-- goes in p_notes instead of being silently rejected or truncated.
-- ══════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists requested_date date,
  add column if not exists department text,
  add column if not exists placed_by_staff_id uuid references public.staff_users(id);

-- A future-dated order's flat per-item cap — one place to change it.
create or replace function public.staff_order_future_day_cap()
returns numeric
language sql
immutable
as $$
  select 100::numeric;
$$;

create or replace function public.create_staff_order(
  p_department text,
  p_requested_date date,
  p_items jsonb,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_order_id uuid;
  v_item jsonb;
  v_sweet_id uuid;
  v_qty numeric;
  v_sweet_name text;
  v_available numeric;
  v_availability_by_name jsonb := '{}'::jsonb;
  v_is_future boolean;
  v_restricted_dept_id uuid;
begin
  if not is_staff() then
    raise exception 'Only a logged-in staff member can place an order this way.';
  end if;

  if p_department is null or btrim(p_department) = '' then
    raise exception 'A department is required.';
  end if;

  if p_requested_date is null then
    raise exception 'An order date is required.';
  end if;

  if p_requested_date < ist_today() then
    raise exception 'Cannot place an order for a past date.';
  end if;

  -- A department-restricted staff member can only order for their own
  -- department — checked here, not just left to the frontend, since this
  -- function is SECURITY DEFINER and therefore bypasses the RLS
  -- restriction on the sales/sale_items tables entirely.
  v_restricted_dept_id := staff_department_restriction_id();
  if v_restricted_dept_id is not null then
    if not exists (
      select 1 from departments d
      where d.id = v_restricted_dept_id and upper(d.name) = upper(p_department)
    ) then
      raise exception 'Your account can only place orders for your own department.';
    end if;
  end if;

  if not exists (select 1 from departments where upper(name) = upper(p_department)) then
    raise exception 'Unknown department.';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item.';
  end if;

  v_is_future := p_requested_date > ist_today();

  -- Only fetch today's live stock when it's actually needed — a
  -- future-dated order never touches this at all.
  if not v_is_future then
    select coalesce(jsonb_object_agg(sweet_name, available), '{}'::jsonb)
    into v_availability_by_name
    from get_public_available_stock();
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if v_item->>'sweet_id' is null then
      raise exception 'Missing sweet_id for an order item.';
    end if;

    v_sweet_id := (v_item->>'sweet_id')::uuid;
    v_qty := (v_item->>'quantity')::numeric;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Quantity must be greater than zero for every item.';
    end if;

    select name into v_sweet_name from sweets where id = v_sweet_id;
    if v_sweet_name is null then
      raise exception 'Unknown sweet in order.';
    end if;

    if v_is_future then
      if v_qty > staff_order_future_day_cap() then
        raise exception 'Quantity for % cannot exceed % for a future-dated order — use the message box for anything beyond that.',
          v_sweet_name, staff_order_future_day_cap();
      end if;
    else
      v_available := coalesce((v_availability_by_name ->> v_sweet_name)::numeric, 0);
      if v_qty > v_available then
        raise exception 'Only % of % is currently available today.', v_available, v_sweet_name;
      end if;
    end if;
  end loop;

  insert into public.orders (department, requested_date, placed_by_staff_id, notes)
  values (p_department, p_requested_date, auth.uid(), nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (order_id, sweet_id, quantity)
    values (v_order_id, (v_item->>'sweet_id')::uuid, (v_item->>'quantity')::numeric);
  end loop;

  return v_order_id;
end;
$function$;

grant execute on function public.staff_order_future_day_cap() to anon, authenticated;
grant execute on function public.create_staff_order(text, date, jsonb, text) to authenticated;
revoke execute on function public.create_staff_order(text, date, jsonb, text) from anon, public;

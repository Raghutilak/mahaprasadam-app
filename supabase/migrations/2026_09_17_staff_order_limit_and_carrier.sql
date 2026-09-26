-- ══════════════════════════════════════════════════════════════════
-- 1) A staff member may only have 2 ACTIVE orders (status 'pending' or
--    'confirmed') at a time — a 3rd is blocked until one of the existing
--    two is fulfilled or cancelled. "Active" rather than "ever placed":
--    a lifetime cap of 2 would permanently lock someone out after two
--    legitimate, already-fulfilled orders, which isn't the intent.
--
-- 2) orders.carrier_id — who will physically collect it, chosen at
--    booking time from the same `carriers` master table Department
--    Credit already uses. Lets a confirmed order's details be shared
--    straight to that carrier's phone (see Orders.jsx's "Share with
--    Carrier" button) without them needing any access to this app at
--    all — they just show the message at the counter.
-- ══════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists carrier_id uuid references public.carriers(id);

drop function if exists public.create_staff_order(text, date, jsonb, text);

create or replace function public.create_staff_order(
  p_department text,
  p_requested_date date,
  p_items jsonb,
  p_notes text default null,
  p_carrier_id uuid default null
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
  v_active_order_count int;
begin
  if not is_staff() then
    raise exception 'Only a logged-in staff member can place an order this way.';
  end if;

  -- Cap of 2 ACTIVE (pending/confirmed) orders per staff member, counting
  -- today's order the same as any other — once at the cap, place no more
  -- until an existing one is fulfilled or cancelled.
  select count(*) into v_active_order_count
  from orders
  where placed_by_staff_id = auth.uid()
    and status in ('pending', 'confirmed');
  if v_active_order_count >= 2 then
    raise exception 'You already have 2 active orders — wait for one to be fulfilled or cancelled before placing another.';
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

  if p_carrier_id is not null and not exists (select 1 from carriers where id = p_carrier_id) then
    raise exception 'Unknown carrier.';
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

  insert into public.orders (department, requested_date, placed_by_staff_id, carrier_id, notes)
  values (p_department, p_requested_date, auth.uid(), p_carrier_id, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (order_id, sweet_id, quantity)
    values (v_order_id, (v_item->>'sweet_id')::uuid, (v_item->>'quantity')::numeric);
  end loop;

  return v_order_id;
end;
$function$;

grant execute on function public.create_staff_order(text, date, jsonb, text, uuid) to authenticated;
revoke execute on function public.create_staff_order(text, date, jsonb, text, uuid) from anon, public;

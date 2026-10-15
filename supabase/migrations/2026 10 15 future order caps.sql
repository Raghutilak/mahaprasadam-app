-- Per-sweet quantity caps for FUTURE-dated staff orders.
-- Edit any number later in Supabase → Table Editor → future_order_caps
-- (or with: update future_order_caps set cap = 4 where sweet_name = 'Peda';).
-- A sweet with no row here, or cap = 0, cannot be ordered for a future date.

create table if not exists public.future_order_caps (
  sweet_name text primary key,   -- must match sweets.name (case-insensitive)
  cap        numeric not null check (cap >= 0)
);

insert into public.future_order_caps (sweet_name, cap) values
  ('Peda', 5), ('Sandesh', 5), ('Rasagulla', 2), ('Rasamalai', 2),
  ('Sweet Samosa', 5), ('Cake', 2), ('Ladoo', 0)
on conflict (sweet_name) do update set cap = excluded.cap;

-- Staff screens may READ the caps; only you (dashboard / SQL editor) change them.
alter table public.future_order_caps enable row level security;
drop policy if exists "caps readable by authenticated" on public.future_order_caps;
create policy "caps readable by authenticated" on public.future_order_caps
  for select to authenticated using (true);
grant select on public.future_order_caps to authenticated;

-- Replace the old single-number helper with a per-sweet one.
drop function if exists public.staff_order_future_day_cap();

create or replace function public.staff_order_future_day_cap(p_sweet_name text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select cap from public.future_order_caps
                   where upper(sweet_name) = upper(p_sweet_name)), 0)
$$;
grant execute on function public.staff_order_future_day_cap(text) to authenticated;

-- create_staff_order: identical to your current version except the
-- future-day check now uses the per-sweet cap.
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
  v_cap numeric;
begin
  if not is_staff() then
    raise exception 'Only a logged-in staff member can place an order this way.';
  end if;

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
      v_cap := staff_order_future_day_cap(v_sweet_name);
      if v_cap <= 0 then
        raise exception '% cannot be ordered for a future date — use the message box instead.', v_sweet_name;
      elsif v_qty > v_cap then
        raise exception 'Quantity for % cannot exceed % for a future-dated order — use the message box for anything beyond that.',
          v_sweet_name, v_cap;
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

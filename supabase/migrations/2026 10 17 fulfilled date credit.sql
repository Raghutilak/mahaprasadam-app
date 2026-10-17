-- 1) Record WHEN an order was fulfilled.
alter table public.orders add column if not exists fulfilled_at timestamptz;
 
create or replace function public.trg_orders_set_fulfilled_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'fulfilled' and (tg_op = 'INSERT' or old.status is distinct from 'fulfilled') then
    new.fulfilled_at := now();
  elsif new.status <> 'fulfilled' then
    new.fulfilled_at := null;
  end if;
  return new;
end;
$$;
 
drop trigger if exists trg_orders_set_fulfilled_at on public.orders;
create trigger trg_orders_set_fulfilled_at
  before insert or update of status on public.orders
  for each row execute function public.trg_orders_set_fulfilled_at();
 
-- Orders already fulfilled before this change: use the credit time if there is one.
update public.orders set fulfilled_at = coalesce(credited_at, created_at)
where status = 'fulfilled' and fulfilled_at is null;
 
-- 2) Credit is raised when an order is FULFILLED (not merely confirmed).
create or replace function public.trg_auto_credit_order()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'fulfilled' and new.credited_at is null then
    perform public.auto_credit_order(new.id);
  end if;
  return new;
end;
$function$;
 
-- 3) The credit is dated on the fulfilled date. If the order was requested for a
--    future day, nothing is credited until that day arrives; it is then dated that day.
create or replace function public.auto_credit_order(p_order_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_order record;
  v_department_id uuid;
  v_sale_id uuid;
  v_subtotal numeric := 0;
  v_notes text;
  v_holder text;
  v_sale_date date;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    return;
  end if;
 
  if v_order.status <> 'fulfilled' then
    return;
  end if;
  if v_order.credited_at is not null then
    return;
  end if;
  if v_order.requested_date is null or v_order.requested_date > ist_today() then
    return; -- requested for a later day — the daily sweep credits it when that day arrives
  end if;
  if v_order.department is null or btrim(v_order.department) = '' then
    return; -- a customer order, not a staff/department one — nothing to credit
  end if;
 
  select id into v_department_id from departments where upper(name) = upper(v_order.department);
  if v_department_id is null then
    return; -- unknown department name — leave it uncredited rather than guess
  end if;
 
  select coalesce(sum(oi.quantity * s.price), 0) into v_subtotal
  from public.order_items oi join public.sweets s on s.id = oi.sweet_id
  where oi.order_id = v_order.id;
 
  if v_subtotal <= 0 then
    return; -- no priced items on this order — nothing to credit
  end if;
 
  -- Credit date = the later of the fulfilled date and the requested date.
  v_sale_date := greatest(
    coalesce((v_order.fulfilled_at at time zone 'Asia/Kolkata')::date, ist_today()),
    v_order.requested_date
  );
 
  -- The staff member who placed the order is the account holder.
  select name into v_holder from public.staff_users where id = v_order.placed_by_staff_id;
 
  v_notes := 'Auto-generated — Order #' || left(v_order.id::text, 8)
             || ' accepted for ' || v_order.requested_date::text;
 
  insert into public.sales (
    sale_date, sale_type, department_id, carrier_id, customer_name,
    subtotal, discount, total_amount, amount_paid, balance_amount, notes
  ) values (
    v_sale_date, 'department_credit', v_department_id, v_order.carrier_id, v_holder,
    v_subtotal, 0, v_subtotal, 0, v_subtotal, v_notes
  ) returning id into v_sale_id;
 
  insert into public.sale_items (sale_id, sweet_id, quantity, rate, total_amount)
  select v_sale_id, oi.sweet_id, oi.quantity, s.price, oi.quantity * s.price
  from public.order_items oi join public.sweets s on s.id = oi.sweet_id
  where oi.order_id = v_order.id;
 
  insert into public.department_ledger_entries (department_id, entry_type, amount, sale_id, description)
  values (v_department_id, 'credit_sale', v_subtotal, v_sale_id, v_notes);
 
  update public.orders set credited_at = now() where id = v_order.id;
end;
$function$;
 
-- 4) Daily sweep: fulfilled orders whose requested day has now arrived.
create or replace function public.auto_credit_orders_due_today()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r record;
begin
  for r in
    select id from public.orders
    where status = 'fulfilled'
      and credited_at is null
      and requested_date is not null
      and requested_date <= ist_today()
  loop
    perform public.auto_credit_order(r.id);
  end loop;
end;
$function$;

-- Auto department credit for an order: fill "Account Holder" with the staff
-- member who placed the order (sales.customer_name is where the app stores a
-- Department Credit's account holder / contact person).
 
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
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then
    return;
  end if;
 
  if v_order.status not in ('confirmed', 'fulfilled') then
    return;
  end if;
  if v_order.credited_at is not null then
    return;
  end if;
  if v_order.requested_date is null or v_order.requested_date > ist_today() then
    return; -- not due yet — the nightly sweep below will pick it up once it is
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
 
  -- The staff member who placed the order is the account holder.
  select name into v_holder from public.staff_users where id = v_order.placed_by_staff_id;
 
  v_notes := 'Auto-generated — Order #' || left(v_order.id::text, 8)
             || ' accepted for ' || v_order.requested_date::text;
 
  insert into public.sales (
    sale_date, sale_type, department_id, carrier_id, customer_name,
    subtotal, discount, total_amount, amount_paid, balance_amount, notes
  ) values (
    ist_today(), 'department_credit', v_department_id, v_order.carrier_id, v_holder,
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
 
-- One-off backfill: auto credits already created with a blank account holder.
update public.sales s
set customer_name = su.name
from public.orders o
join public.staff_users su on su.id = o.placed_by_staff_id
where s.sale_type = 'department_credit'
  and s.customer_name is null
  and s.notes like 'Auto-generated — Order #' || left(o.id::text, 8) || ' accepted for %';
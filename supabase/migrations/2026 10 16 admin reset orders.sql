-- Admin-only: delete ALL orders (and their items) — nothing else.
create or replace function public.admin_reset_orders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.staff_users
    where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Only an admin can clear orders.';
  end if;
 
  delete from public.order_items where true;
  delete from public.orders where true;
end;
$$;
 
revoke execute on function public.admin_reset_orders() from anon, public;
grant execute on function public.admin_reset_orders() to authenticated;

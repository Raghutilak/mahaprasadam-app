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
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

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
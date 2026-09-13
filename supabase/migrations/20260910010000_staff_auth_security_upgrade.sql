-- ══════════════════════════════════════════════════════════════════
-- Security upgrade: staff login moves from a plaintext-password table
-- to real Supabase Auth (auth.users), same trust model customers
-- already get. This migration REPLACES the old staff_users table from
-- 20260910000000_staff_users.sql.
--
-- After running this, staff_users holds PROFILE data only (name,
-- mobile, role, allowed tabs) — no passwords at all. Passwords live in
-- Supabase's own auth.users, hashed, and are only ever touched via:
--   • supabase.auth.signInWithPassword()   — staff logging in
--   • supabase.auth.updateUser()           — a staff member changing
--                                             their OWN password
--   • the admin-staff-management Edge Function, using the service-role
--     key (never shipped to the browser/Vercel) — admin creating a
--     staff account or resetting someone else's password
--
-- IMPORTANT — run scripts/bootstrap-staff.mjs once after this migration
-- to (re)create the 3 staff accounts as real Supabase Auth users. Until
-- you do, nobody can log in (the old rows are gone).
-- ══════════════════════════════════════════════════════════════════

drop table if exists staff_users;

create table staff_users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text,
  mobile text,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  allowed_tabs text[] not null default '{}',
  restrict_reports_to_today boolean not null default false,
  created_at timestamptz not null default now()
);

alter table staff_users enable row level security;

-- A staff member can always read their own profile (used to build the
-- sidebar/tab list after they log in).
create policy "staff can read own profile"
  on staff_users for select
  using (auth.uid() = id);

-- Admins can read/insert/update/delete every profile row. "Admin" here
-- means the JWT's app_metadata.role = 'admin' — app_metadata can ONLY be
-- set via the Supabase Admin API (service-role key), i.e. from inside the
-- admin-staff-management Edge Function or the bootstrap script, never by
-- a user themselves. This is what keeps a staff member from just editing
-- their own row to grant themselves more tabs.
create policy "admin can manage all profiles"
  on staff_users for all
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Note: password reset / staff creation are NOT plain table writes —
-- they go through the Edge Function (below) since only the Admin API can
-- create an auth.users row or change someone else's password.

-- ══════════════════════════════════════════════════════════════════
-- staff_users
-- Backs the multi-staff login system (replaces the old single
-- hardcoded admin login). Each row is one staff member's login +
-- the list of sidebar tabs they're allowed to see.
--
-- NOTE ON PASSWORDS: per requirements, the admin needs to be able to
-- SEE every staff member's current password (not just reset it), so
-- passwords are stored in plain text here — same trust model as the
-- old hardcoded admin login (this table is gated by the app's own
-- staff-login screen, not a "real" auth system). Do not reuse this
-- pattern for anything customer-facing — customers use real Supabase
-- Auth (see supabaseAuthClient.js), which hashes passwords properly.
-- ══════════════════════════════════════════════════════════════════

create table if not exists staff_users (
  id bigint generated always as identity primary key,
  name text not null,
  email text,                          -- may be null (e.g. mobile-only staff)
  mobile text,                         -- may be null, but at least one of email/mobile is required
  password text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  allowed_tabs text[] not null default '{}',   -- e.g. '{dashboard,donations,reset_donation}'
  restrict_reports_to_today boolean not null default false,
  created_at timestamptz not null default now(),
  constraint staff_users_identifier_required check (email is not null or mobile is not null)
);

-- One-time seed of the three staff accounts set up so far. Safe to run
-- more than once — on_conflict just leaves existing rows untouched
-- since email/mobile aren't declared unique here; if you've already
-- created these rows by hand, skip this block.
--
-- NOTE: 'orders' (Book Order) is included for every staff member below,
-- per policy — Book Order is accessible to all staff regardless of role.
insert into staff_users (name, email, mobile, password, role, allowed_tabs, restrict_reports_to_today)
select * from (values
  ('Raghu Tilak Das', 'raghutilak.das@gmail.com', '8422886705', '123', 'admin',
    array['dashboard','receive','cash','paytm','credit','payment','donations','orders','reports','close',
          'reset_donation','reset_other','export']::text[], false),
  ('Dayavan Prabhu', null, '9819279878', '456', 'staff',
    array['dashboard','donations','reset_donation','orders']::text[], false),
  ('Palsura', 'palsura0@gmail.com', '9004504015', '789', 'staff',
    array['dashboard','receive','cash','paytm','credit','payment','export','reports','orders']::text[], true)
) as seed(name, email, mobile, password, role, allowed_tabs, restrict_reports_to_today)
where not exists (select 1 from staff_users);

-- RLS: the app talks to Supabase with the anon/publishable key (same as every
-- other table here), so keep this table reachable the same way the rest of
-- the app's tables are. If you have RLS enabled project-wide, add a policy
-- here matching your other tables' policy (e.g. allow anon select/insert/update).

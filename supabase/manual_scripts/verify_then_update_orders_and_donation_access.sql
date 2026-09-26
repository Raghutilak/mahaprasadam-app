-- ══════════════════════════════════════════════════════════════════
-- NOT auto-run — this is a hand-run checklist, not a migration to apply
-- blindly. It changes WHO specific named people are, which this repo's
-- seed data (20260910000000_staff_users.sql) may no longer reflect
-- accurately since staff rows get edited over time via Manage Passwords.
-- Run each SELECT, confirm it's the right person, THEN run the UPDATE
-- directly below it. Do this in the Supabase SQL editor (or via
-- `supabase db execute`, not as a checked-in migration file).
-- ══════════════════════════════════════════════════════════════════

-- ── STEP 1 — find Suraj Pal's row ──────────────────────────────────
-- (seeded as "Palsura" — restrict_reports_to_today = true is the
-- fingerprint mentioned across several migration comments as his rule)
select id, name, email, mobile, role, allowed_tabs, restrict_reports_to_today
from staff_users
where name ilike '%suraj%' or name ilike '%palsura%' or restrict_reports_to_today = true;

-- Once you've confirmed the id above is Suraj Pal, grant him "All Orders"
-- (the 'orders' tab) by adding it to whatever he already has — this does
-- NOT remove anything else he currently holds:
-- update staff_users
-- set allowed_tabs = array(select distinct unnest(allowed_tabs || array['orders']))
-- where id = <SURAJ_PAL_ID_FROM_ABOVE>;

-- ── STEP 2 — find Dayavan Nitai's row ──────────────────────────────
-- (seeded as "Dayavan Prabhu" — Donations + Reset Donation Data is the
-- fingerprint; only one staff account currently holds Donations at all)
select id, name, email, mobile, role, allowed_tabs, restrict_to_department
from staff_users
where name ilike '%dayavan%' or name ilike '%nitai%' or 'donations' = any(allowed_tabs);

-- Once you've confirmed the id above is Dayavan Nitai, remove BOTH
-- 'orders' and 'reset_donation' from his allowed_tabs, leaving everything
-- else (Dashboard, Donations, ...) untouched:
-- update staff_users
-- set allowed_tabs = array(
--   select unnest(allowed_tabs) except select unnest(array['orders','reset_donation'])
-- )
-- where id = <DAYAVAN_NITAI_ID_FROM_ABOVE>;

-- ── Alternative to all of the above ────────────────────────────────
-- Both changes can also be made with zero SQL at all, straight from the
-- app: log in as admin -> "Manage Passwords" -> open Suraj Pal's row,
-- check "📋 All Orders" -> Save; open Dayavan Nitai's row, uncheck
-- "📋 All Orders" and "🧹 Reset Donation Data" -> Save. That UI writes to
-- the exact same allowed_tabs column, so either path is equally valid —
-- pick whichever is easier to verify you've got the right person.

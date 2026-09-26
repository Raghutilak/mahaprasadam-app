-- ══════════════════════════════════════════════════════════════════
-- Run these SELECTs first (read-only, changes nothing) to confirm
-- whether the auto-credit trigger fired for orders that predate it and
-- were already manually credited the old way — that's what would cause
-- today's stock to look wrong.
-- ══════════════════════════════════════════════════════════════════

-- 1) Every auto-generated department-credit sale dated today (or any
--    date) — if this has entries you don't recognize creating, or way
--    more than the number of orders you actually placed through "Book
--    an Order" today, that's the flood.
select id, sale_date, department_id, total_amount, notes, created_at
from sales
where sale_type = 'department_credit'
  and notes like 'Auto-generated — Order #%'
order by created_at desc;

-- 2) Orders that are already confirmed/fulfilled AND have now been
--    auto-credited — cross-check the count against how many NEW orders
--    you actually placed since deploying this feature. A much bigger
--    number here than that means old orders got swept in too.
select id, status, department, requested_date, credited_at, created_at
from orders
where credited_at is not null
order by credited_at desc;

-- 3) For comparison — orders that are confirmed/fulfilled but NOT yet
--    auto-credited (department is null, or department name doesn't
--    match any row in `departments`, or items have zero price — these
--    correctly no-op rather than credit, per auto_credit_order()'s design).
select id, status, department, requested_date, credited_at
from orders
where status in ('confirmed', 'fulfilled') and credited_at is null;

-- 4) Today's live stock math, per sweet — opening + received - sold
--    (mirrors close_business_day's formula, using tables directly so
--    you can see exactly what's dragging it negative).
select
  s.name,
  coalesce(o.quantity, 0)  as opening,
  coalesce(r.quantity, 0)  as received_today,
  coalesce(sd.quantity, 0) as sold_today,
  coalesce(o.quantity, 0) + coalesce(r.quantity, 0) - coalesce(sd.quantity, 0) as available_now
from sweets s
left join inventory_openings o on o.sweet_id = s.id and o.stock_date = current_date
left join (
  select sri.sweet_id, sum(sri.quantity) as quantity
  from stock_receipt_items sri
  join stock_receipts sr on sr.id = sri.receipt_id
  where sr.receipt_date = current_date
  group by sri.sweet_id
) r on r.sweet_id = s.id
left join (
  select si.sweet_id, sum(si.quantity) as quantity
  from sale_items si
  join sales sa on sa.id = si.sale_id
  where sa.sale_date = current_date
  group by si.sweet_id
) sd on sd.sweet_id = s.id
order by s.name;

-- ══════════════════════════════════════════════════════════════════
-- If query #1 shows auto-generated entries for orders you know were
-- already manually recorded as a department credit sale the old way,
-- those are duplicates — each one double-deducted stock for goods that
-- only left the shop once. Reverse ONLY the auto-generated duplicate
-- (never the original manual entry) with:
--
--   select delete_sale_entry(<id from query #1's "id" column>);
--
-- delete_sale_entry() properly reverses the department_ledger_entries
-- amount and recomputes inventory if needed — don't delete these rows
-- with a plain `delete from sales` instead.
--
-- Run 2026_09_20_backfill_credited_at_prevent_double_credit.sql AFTER
-- you've finished this review (see that file's own instructions for
-- the one exception — a genuinely new, never-otherwise-credited order
-- caught in query #3).
-- ══════════════════════════════════════════════════════════════════

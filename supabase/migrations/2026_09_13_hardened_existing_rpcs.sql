-- ═══════════════════════════════════════════════════════════════════════
-- HARDEN EXISTING RPCs — these 5 functions were shared for audit. All are
-- SECURITY DEFINER but none checked WHO was calling them, which means:
--   • Every RLS policy built in the last two migrations means nothing for
--     writes that go through these — SECURITY DEFINER bypasses RLS.
--   • Any authenticated Supabase user — including an ordinary customer
--     account created just to place a sweet order — could call
--     create_sale_with_items, create_credit_sale_with_ledger,
--     create_recovery_payment, or update_donation_with_bhogas directly
--     and freely create/alter/delete sales, credit, and donation records.
--   • None of them validated quantity/amount > 0, a valid sale/payment
--     type, or recomputed price/total server-side — all of that was
--     trusted from the client's request body.
--   • update_donation_with_bhogas has a live syntax bug in its INSERT
--     branch (missing parentheses after VALUES) that will throw a runtime
--     error the first time anyone tries to add a new donation line
--     through it — not a security issue, but worth fixing in the same
--     pass since it's the same function.
--
-- Every function below keeps its EXACT original signature (name +
-- parameter names/types), so no client code needs to change — only the
-- function bodies gain: an is_staff()/staff_has_tab() check up front,
-- input validation, and server-computed totals instead of trusting the
-- client's numbers.
-- ═══════════════════════════════════════════════════════════════════════


-- ── create_sale_with_items — used directly by Cash/Paytm sale entry, and
-- indirectly (via create_credit_sale_with_ledger) by Credit sale entry.
-- Since both callers need it, this checks staff_has_tab() for whichever
-- tab the sale_type implies, rather than hardcoding one tab. ──────────
CREATE OR REPLACE FUNCTION public.create_sale_with_items(p_sale jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
    v_sale_id uuid;
    v_item jsonb;
    v_sale_type text := p_sale->>'sale_type';
    v_price numeric;
    v_qty numeric;
    v_subtotal numeric := 0;
BEGIN
    IF v_sale_type NOT IN ('cash', 'upi', 'department_credit', 'individual_credit') THEN
        RAISE EXCEPTION 'Invalid sale_type: %', v_sale_type;
    END IF;

    IF NOT staff_has_tab(sale_type_tab(v_sale_type)) THEN
        RAISE EXCEPTION 'You do not have access to record this kind of sale.';
    END IF;

    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'At least one sale item is required';
    END IF;

    -- Validate every item and compute the true total server-side BEFORE
    -- inserting anything — never trust a client-supplied rate/total_amount.
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        IF v_item->>'sweet_id' IS NULL THEN
            RAISE EXCEPTION 'Missing sweet_id for sale item: %', v_item;
        END IF;
        v_qty := (v_item->>'quantity')::numeric;
        IF v_qty IS NULL OR v_qty <= 0 THEN
            RAISE EXCEPTION 'Quantity must be greater than zero for every item.';
        END IF;
        SELECT price INTO v_price FROM sweets WHERE id = (v_item->>'sweet_id')::uuid;
        IF v_price IS NULL THEN
            RAISE EXCEPTION 'Unknown sweet_id: %', v_item->>'sweet_id';
        END IF;
        v_subtotal := v_subtotal + v_price * v_qty;
    END LOOP;

    INSERT INTO public.sales (
        sale_date, sale_type, payment_method, customer_name, department_id, account_holder_id,
        carrier_id, receipt_number, subtotal, discount, total_amount, amount_paid, balance_amount,
        notes, reference_type, reference_name
    )
    VALUES (
        (p_sale->>'sale_date')::date,
        v_sale_type,
        p_sale->>'payment_method',
        p_sale->>'customer_name',
        NULLIF(p_sale->>'department_id', '')::uuid,
        NULLIF(p_sale->>'account_holder_id', '')::uuid,
        NULLIF(p_sale->>'carrier_id', '')::uuid,
        p_sale->>'receipt_number',
        v_subtotal,
        COALESCE((p_sale->>'discount')::numeric, 0),
        v_subtotal - COALESCE((p_sale->>'discount')::numeric, 0),
        COALESCE((p_sale->>'amount_paid')::numeric, v_subtotal),
        COALESCE((p_sale->>'balance_amount')::numeric, 0),
        p_sale->>'notes',
        p_sale->>'reference_type',
        p_sale->>'reference_name'
    )
    RETURNING id INTO v_sale_id;

    INSERT INTO public.sale_items (sale_id, sweet_id, quantity, rate, total_amount)
    SELECT
        v_sale_id,
        (i->>'sweet_id')::uuid,
        (i->>'quantity')::numeric,
        s.price,
        (i->>'quantity')::numeric * s.price
    FROM jsonb_array_elements(p_items) i
    JOIN sweets s ON s.id = (i->>'sweet_id')::uuid;

    RETURN v_sale_id;
END;
$function$;

-- ── create_credit_sale_with_ledger — wraps the above; ledger amount is
-- now taken from the SALE's own computed total (via create_sale_with_items)
-- rather than trusting p_ledger->>'amount' as an independent number, so
-- the two can never disagree. ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_credit_sale_with_ledger(p_sale jsonb, p_items jsonb, p_ledger_table text, p_ledger jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
    v_sale_id uuid;
    v_sale_total numeric;
    v_department_id uuid := NULLIF(p_sale->>'department_id', '')::uuid;
    v_account_holder_id uuid := NULLIF(p_sale->>'account_holder_id', '')::uuid;
BEGIN
    IF NOT staff_has_tab('credit') THEN
        RAISE EXCEPTION 'You do not have access to record credit sales.';
    END IF;

    IF p_ledger_table = 'department_ledger_entries' THEN
        IF v_department_id IS NULL THEN
            RAISE EXCEPTION 'department_id is required for a department credit sale';
        END IF;
        IF v_account_holder_id IS NOT NULL THEN
            RAISE EXCEPTION 'account_holder_id must be null for a department credit sale';
        END IF;
    ELSIF p_ledger_table = 'account_ledger_entries' THEN
        IF v_account_holder_id IS NULL THEN
            RAISE EXCEPTION 'account_holder_id is required for an individual credit sale';
        END IF;
        IF v_department_id IS NOT NULL THEN
            RAISE EXCEPTION 'department_id must be null for an individual credit sale';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unknown ledger table: %', p_ledger_table;
    END IF;

    -- create_sale_with_items re-checks staff_has_tab(sale_type_tab(...))
    -- itself too — 'department_credit'/'individual_credit' both map to
    -- 'credit', so this is a consistent, not a redundant-but-conflicting, check.
    v_sale_id := public.create_sale_with_items(p_sale, p_items);
    SELECT total_amount INTO v_sale_total FROM sales WHERE id = v_sale_id;

    IF p_ledger_table = 'department_ledger_entries' THEN
        INSERT INTO public.department_ledger_entries (department_id, entry_type, amount, sale_id, description)
        VALUES (v_department_id, COALESCE(p_ledger->>'entry_type', 'sale'), v_sale_total, v_sale_id, p_ledger->>'description');
    ELSE
        INSERT INTO public.account_ledger_entries (account_holder_id, entry_type, amount, sale_id, description)
        VALUES (v_account_holder_id, COALESCE(p_ledger->>'entry_type', 'sale'), v_sale_total, v_sale_id, p_ledger->>'description');
    END IF;

    RETURN v_sale_id;
END;
$function$;

-- ── create_recovery_payment — Credit Recovery tab only. ────────────────
CREATE OR REPLACE FUNCTION public.create_recovery_payment(p_payment jsonb, p_ledger_table text, p_ledger jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
    v_payment_id uuid;
    v_amount numeric := (p_payment->>'amount')::numeric;
    v_department_id uuid := NULLIF(p_payment->>'department_id', '')::uuid;
    v_account_holder_id uuid := NULLIF(p_payment->>'account_holder_id', '')::uuid;
BEGIN
    IF NOT staff_has_tab('payment') THEN
        RAISE EXCEPTION 'You do not have access to record recovery payments.';
    END IF;

    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be greater than zero.';
    END IF;

    IF ((v_department_id IS NOT NULL)::int + (v_account_holder_id IS NOT NULL)::int) <> 1 THEN
        RAISE EXCEPTION 'Exactly one debtor (department_id or account_holder_id) is required';
    END IF;

    IF v_department_id IS NOT NULL AND p_ledger_table <> 'department_ledger_entries' THEN
        RAISE EXCEPTION 'department_id requires p_ledger_table = department_ledger_entries';
    END IF;
    IF v_account_holder_id IS NOT NULL AND p_ledger_table <> 'account_ledger_entries' THEN
        RAISE EXCEPTION 'account_holder_id requires p_ledger_table = account_ledger_entries';
    END IF;

    INSERT INTO public.credit_payments (
        payment_date, sale_id, department_id, account_holder_id, amount, payment_method, reference_number, notes
    )
    VALUES (
        COALESCE((p_payment->>'payment_date')::date, ist_today()),
        NULLIF(p_payment->>'sale_id', '')::uuid,
        v_department_id, v_account_holder_id, v_amount,
        p_payment->>'payment_method', p_payment->>'reference_number', p_payment->>'notes'
    )
    RETURNING id INTO v_payment_id;

    IF p_ledger_table = 'department_ledger_entries' THEN
        INSERT INTO public.department_ledger_entries (department_id, entry_type, amount, payment_id, description)
        VALUES (v_department_id, COALESCE(p_ledger->>'entry_type', 'payment'), -v_amount, v_payment_id, p_ledger->>'description');
    ELSE
        INSERT INTO public.account_ledger_entries (account_holder_id, entry_type, amount, payment_id, description)
        VALUES (v_account_holder_id, COALESCE(p_ledger->>'entry_type', 'payment'), -v_amount, v_payment_id, p_ledger->>'description');
    END IF;

    RETURN v_payment_id;
END;
$function$;

-- ── update_donation_with_bhogas — Donations tab only. Also fixes the
-- malformed INSERT (missing parens after VALUES, which would have thrown
-- a runtime syntax error the first time an insert row was actually hit). ──
CREATE OR REPLACE FUNCTION public.update_donation_with_bhogas(p_shared jsonb, p_updates jsonb, p_delete_ids jsonb, p_inserts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
    v_item jsonb;
    v_new_id bigint;
    v_inserted_ids bigint[] := ARRAY[]::bigint[];
    v_amount numeric;
BEGIN
    IF NOT staff_has_tab('donations') THEN
        RAISE EXCEPTION 'You do not have access to manage donations.';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_updates, '[]'::jsonb)) LOOP
        v_amount := (v_item->>'amount')::numeric;
        IF v_amount IS NULL OR v_amount <= 0 THEN
            RAISE EXCEPTION 'Donation amount must be greater than zero.';
        END IF;
        UPDATE public.donations
        SET
            tr_no = p_shared->>'tr_no',
            donation_date = (p_shared->>'donation_date')::date,
            bhoge_date = (p_shared->>'bhoge_date')::date,
            bhoga_day = p_shared->>'bhoga_day',
            donor_name = p_shared->>'donor_name',
            donor_mobile = p_shared->>'donor_mobile',
            preacher_name = p_shared->>'preacher_name',
            preacher_mobile = p_shared->>'preacher_mobile',
            preacher_id = NULLIF(p_shared->>'preacher_id', '')::uuid,
            payment_mode = p_shared->>'payment_mode',
            verified_by_asst = (p_shared->>'verified_by_asst')::boolean,
            bhoge_type = v_item->>'bhoge_type',
            bhoga_type_id = NULLIF(v_item->>'bhoga_type_id', '')::uuid,
            amount = v_amount
        WHERE id = (v_item->>'id')::bigint;
    END LOOP;

    IF p_delete_ids IS NOT NULL AND jsonb_array_length(p_delete_ids) > 0 THEN
        DELETE FROM public.donations
        WHERE id IN (SELECT (value)::text::bigint FROM jsonb_array_elements(p_delete_ids));
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_inserts, '[]'::jsonb)) LOOP
        v_amount := (v_item->>'amount')::numeric;
        IF v_amount IS NULL OR v_amount <= 0 THEN
            RAISE EXCEPTION 'Donation amount must be greater than zero.';
        END IF;
        INSERT INTO public.donations (
            tr_no, donation_date, bhoge_date, bhoga_day, donor_name, donor_mobile,
            preacher_name, preacher_mobile, preacher_id, payment_mode, verified_by_asst,
            bhoge_type, bhoga_type_id, amount
        )
        VALUES (
            p_shared->>'tr_no',
            (p_shared->>'donation_date')::date,
            (p_shared->>'bhoge_date')::date,
            p_shared->>'bhoga_day',
            p_shared->>'donor_name',
            p_shared->>'donor_mobile',
            p_shared->>'preacher_name',
            p_shared->>'preacher_mobile',
            NULLIF(p_shared->>'preacher_id', '')::uuid,
            p_shared->>'payment_mode',
            (p_shared->>'verified_by_asst')::boolean,
            v_item->>'bhoge_type',
            NULLIF(v_item->>'bhoga_type_id', '')::uuid,
            v_amount
        )
        RETURNING id INTO v_new_id;
        v_inserted_ids := array_append(v_inserted_ids, v_new_id);
    END LOOP;

    RETURN jsonb_build_object('inserted_ids', to_jsonb(v_inserted_ids));
END;
$function$;

-- ── create_customer_order — NOT security definer (runs as the caller,
-- relying on the customer's own RLS grant), so the "bypasses RLS" issue
-- doesn't apply here. Still needed: reject garbage/zero quantities and
-- validate contact fields, since it's directly reachable by any signed-up
-- customer with an arbitrary JSON body. ────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_customer_order(p_order jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path = public
AS $function$
declare
  v_order_id uuid;
  v_item jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item';
  end if;

  if p_order->>'customer_email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid email address is required.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if v_item->>'sweet_id' is null then
      raise exception 'Missing sweet_id for an order item.';
    end if;
    if (v_item->>'quantity')::numeric is null or (v_item->>'quantity')::numeric <= 0 then
      raise exception 'Quantity must be greater than zero for every item.';
    end if;
    if not exists (select 1 from sweets where id = (v_item->>'sweet_id')::uuid) then
      raise exception 'Unknown sweet in order.';
    end if;
  end loop;

  insert into public.orders (customer_id, customer_email, customer_mobile, notes)
  values (auth.uid(), p_order->>'customer_email', p_order->>'customer_mobile', p_order->>'notes')
  returning id into v_order_id;

  insert into public.order_items (order_id, sweet_id, quantity)
  select v_order_id, (item->>'sweet_id')::uuid, (item->>'quantity')::numeric
  from jsonb_array_elements(p_items) as item;

  return v_order_id;
end;
$function$;

-- ── process_scheduled_receipt — confirmed cron-only (no client call site
-- anywhere in the app). Lock it down the same way as close_business_day. ──
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('process_scheduled_receipt', 'create_stock_receipt_with_items', 'auto_build_receipt_items')
  LOOP
    EXECUTE format('revoke execute on function %s from public, anon, authenticated;', r.sig);
  END LOOP;
END $$;

-- Re-grant the staff-facing ones to `authenticated` (the DO block above
-- revoked from everyone for simplicity; these three are cron-internal
-- helpers with no client call site at all, so leaving them fully revoked
-- is correct — they only ever run as the cron job owner).


-- ═══════════════════════════════════════════════════════════════════════
-- STILL MISSING — process_scheduled_receipt calls these two, which
-- weren't in the audit batch. Please run the same pg_get_functiondef
-- query for them so I can check the same things (especially
-- create_stock_receipt_with_items, since it's the one actually writing
-- stock_receipts/stock_receipt_items — the receiving side of the exact
-- inventory chain this whole cascade fix depends on):
--   • create_stock_receipt_with_items(jsonb, jsonb)
--   • auto_build_receipt_items(jsonb)
-- Also still outstanding from before: get_account_holder_dues,
-- get_daily_sale_totals, get_daily_sold_stock, get_daily_stock_adjustments,
-- get_department_dues, get_public_available_stock — these are all SELECT-
-- only reporting functions so the stakes are lower, but worth a pass too.
-- ═══════════════════════════════════════════════════════════════════════

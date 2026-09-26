-- ══════════════════════════════════════════════════════════════════
-- Closes the gap documented at the bottom of
-- 2026_09_16_staff_department_restriction.sql: create_staff_order()
-- already checks staff_department_restriction_id() before letting a
-- department-restricted staff member act outside their own department;
-- create_credit_sale_with_ledger() and create_recovery_payment() did
-- not, even though both are SECURITY DEFINER and therefore bypass the
-- restrictive RLS policies from that same migration entirely for their
-- own inserts.
--
-- Requires 2026_09_16_staff_department_restriction.sql to have already
-- been run (it's what creates staff_department_restriction_id() and the
-- restrict_to_department column these checks depend on) — apply that
-- migration first if you haven't already.
--
-- Both signatures are unchanged, so no client code needs updating —
-- only the function bodies gain the same check create_staff_order()
-- already has.
-- ══════════════════════════════════════════════════════════════════

-- ── create_credit_sale_with_ledger — Credit Sale tab. A department-
--    restricted staff member may only ever record a DEPARTMENT credit
--    sale for their own department — never an individual (account
--    holder) credit sale at all, restricted or not, since the
--    restriction is inherently about a department. ────────────────────
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
    v_restricted_dept_id uuid;
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

    -- Department-restriction check — mirrors create_staff_order()'s.
    v_restricted_dept_id := staff_department_restriction_id();
    IF v_restricted_dept_id IS NOT NULL THEN
        IF p_ledger_table <> 'department_ledger_entries' OR v_department_id <> v_restricted_dept_id THEN
            RAISE EXCEPTION 'Your account can only record credit sales for your own department.';
        END IF;
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

-- ── create_recovery_payment — Credit Recovery tab. Same reasoning: a
--    department-restricted staff member may only log a recovery against
--    their own department, never against an individual account holder. ──
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
    v_restricted_dept_id uuid;
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

    -- Department-restriction check — mirrors create_staff_order()'s.
    v_restricted_dept_id := staff_department_restriction_id();
    IF v_restricted_dept_id IS NOT NULL THEN
        IF v_department_id IS NULL OR v_department_id <> v_restricted_dept_id THEN
            RAISE EXCEPTION 'Your account can only record recovery payments for your own department.';
        END IF;
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

-- Same grants as when these were first hardened — CREATE OR REPLACE keeps
-- a function's grants, but restating them here makes this file runnable
-- on its own with no surprises either way.
GRANT EXECUTE ON FUNCTION public.create_credit_sale_with_ledger(jsonb, jsonb, text, jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_credit_sale_with_ledger(jsonb, jsonb, text, jsonb) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.create_recovery_payment(jsonb, text, jsonb) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_recovery_payment(jsonb, text, jsonb) FROM anon, public;

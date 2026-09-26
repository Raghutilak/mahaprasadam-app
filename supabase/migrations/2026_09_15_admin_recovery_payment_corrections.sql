-- ── Admin-only corrections for recovery payments (credit_payments). ────
-- credit_payments has been view-only for staff at the table level, with
-- creation only via create_recovery_payment (see mediated_writes_and_
-- strict_rls.sql) and no correction/delete path at all. The Credit
-- Recovery Report now needs one — but unlike a sale entry, a mis-recorded
-- recovery represents money that either was or wasn't actually received,
-- so this is kept admin-only rather than open to any staff member with
-- the payment tab (staff_has_tab('payment')).
--
-- Both functions follow the same audit-preserving pattern already used by
-- correct_credit_sale / delete_sale_entry: the original row is corrected
-- in place (or removed), and a compensating 'correction' ledger entry is
-- inserted rather than editing/deleting the original ledger row — so the
-- department/individual's running due balance stays correct without
-- rewriting history.

CREATE OR REPLACE FUNCTION public.admin_correct_recovery_payment(p_payment_id uuid, p_updates jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_payment record;
    v_new_amount numeric;
    v_delta numeric;
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Only an admin can correct a recovery payment.';
    END IF;

    SELECT * INTO v_payment FROM public.credit_payments WHERE id = p_payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This recovery payment no longer exists.';
    END IF;

    v_new_amount := COALESCE((p_updates->>'amount')::numeric, v_payment.amount);
    IF v_new_amount IS NULL OR v_new_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero.';
    END IF;

    UPDATE public.credit_payments
    SET
        amount = v_new_amount,
        payment_method = COALESCE(p_updates->>'payment_method', payment_method),
        payment_date = COALESCE((p_updates->>'payment_date')::date, payment_date),
        reference_number = COALESCE(NULLIF(p_updates->>'reference_number', ''), reference_number),
        notes = COALESCE(NULLIF(p_updates->>'notes', ''), notes)
    WHERE id = p_payment_id;

    -- Ledger rows store a payment as a negative amount (-old_amount); this
    -- delta, added as a fresh 'correction' entry, brings the running total
    -- in line with the new amount without touching the original row.
    v_delta := v_payment.amount - v_new_amount;

    IF v_delta <> 0 THEN
        IF v_payment.department_id IS NOT NULL THEN
            INSERT INTO public.department_ledger_entries (department_id, entry_type, amount, payment_id, description)
            VALUES (v_payment.department_id, 'correction', v_delta, p_payment_id, format('Correction to recovery #%s', p_payment_id));
        ELSE
            INSERT INTO public.account_ledger_entries (account_holder_id, entry_type, amount, payment_id, description)
            VALUES (v_payment.account_holder_id, 'correction', v_delta, p_payment_id, format('Correction to recovery #%s', p_payment_id));
        END IF;
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_recovery_payment(p_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_payment record;
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Only an admin can delete a recovery payment.';
    END IF;

    SELECT * INTO v_payment FROM public.credit_payments WHERE id = p_payment_id;
    IF NOT FOUND THEN
        RETURN; -- already gone — treat as success, same as delete_sale_entry
    END IF;

    DELETE FROM public.credit_payments WHERE id = p_payment_id;

    -- No payment_id on this reversal row (same reasoning as delete_sale_entry
    -- not referencing sale_id on its reversal): the payment it would point to
    -- no longer exists.
    IF v_payment.department_id IS NOT NULL THEN
        INSERT INTO public.department_ledger_entries (department_id, entry_type, amount, description)
        VALUES (v_payment.department_id, 'correction', v_payment.amount, format('Reversal — deleted recovery #%s', p_payment_id));
    ELSE
        INSERT INTO public.account_ledger_entries (account_holder_id, entry_type, amount, description)
        VALUES (v_payment.account_holder_id, 'correction', v_payment.amount, format('Reversal — deleted recovery #%s', p_payment_id));
    END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_correct_recovery_payment(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_recovery_payment(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_correct_recovery_payment(uuid, jsonb) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_delete_recovery_payment(uuid) FROM anon, public;

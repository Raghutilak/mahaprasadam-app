CREATE OR REPLACE FUNCTION public.admin_reset_donation_data()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only an admin can do this.';
  END IF;
  DELETE FROM donations WHERE true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reset_other_data(p_include_master boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only an admin can do this.';
  END IF;

  DELETE FROM sale_items WHERE true;
  DELETE FROM stock_receipt_items WHERE true;
  DELETE FROM department_ledger_entries WHERE true;
  DELETE FROM account_ledger_entries WHERE true;
  DELETE FROM credit_payments WHERE true;
  DELETE FROM sales WHERE true;
  DELETE FROM stock_receipts WHERE true;
  DELETE FROM inventory_openings WHERE true;
  DELETE FROM inventory_closings WHERE true;
  DELETE FROM stock_adjustments WHERE true;
  DELETE FROM daily_reports WHERE true;

  IF p_include_master THEN
    DELETE FROM departments WHERE true;
    DELETE FROM account_holders WHERE true;
    DELETE FROM carriers WHERE true;
    DELETE FROM sweets WHERE true;
    DELETE FROM bhoga_types WHERE true;
    DELETE FROM preachers WHERE true;
  END IF;
END;
$$;
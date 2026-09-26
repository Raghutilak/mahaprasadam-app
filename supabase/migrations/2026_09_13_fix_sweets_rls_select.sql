-- Allow the app/public menu to read sweet master data.
-- This is intentionally SELECT-only.
-- Writes remain restricted to authenticated staff.

ALTER TABLE public.sweets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone can view sweets" ON public.sweets;

CREATE POLICY "anyone can view sweets"
ON public.sweets
FOR SELECT
USING (true);

DROP POLICY IF EXISTS "staff can manage sweets" ON public.sweets;

CREATE POLICY "staff can manage sweets"
ON public.sweets
FOR INSERT
TO authenticated
WITH CHECK (is_staff());

DROP POLICY IF EXISTS "staff can update sweets" ON public.sweets;

CREATE POLICY "staff can update sweets"
ON public.sweets
FOR UPDATE
TO authenticated
USING (is_staff())
WITH CHECK (is_staff());

DROP POLICY IF EXISTS "staff can delete sweets" ON public.sweets;

CREATE POLICY "staff can delete sweets"
ON public.sweets
FOR DELETE
TO authenticated
USING (is_staff());
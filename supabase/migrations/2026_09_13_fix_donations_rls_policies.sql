DROP POLICY IF EXISTS "donations-tab staff can view"
ON public.donations;

CREATE POLICY "donations-tab staff can view"
ON public.donations
FOR SELECT
USING (staff_has_tab('donations'));

DROP POLICY IF EXISTS "donations-tab staff can insert"
ON public.donations;

CREATE POLICY "donations-tab staff can insert"
ON public.donations
FOR INSERT
WITH CHECK (staff_has_tab('donations'));

DROP POLICY IF EXISTS "donations-tab staff can update"
ON public.donations;

CREATE POLICY "donations-tab staff can update"
ON public.donations
FOR UPDATE
USING (staff_has_tab('donations'))
WITH CHECK (staff_has_tab('donations'));

DROP POLICY IF EXISTS "admin can delete a donation"
ON public.donations;

CREATE POLICY "admin can delete a donation"
ON public.donations
FOR DELETE
USING (is_admin());
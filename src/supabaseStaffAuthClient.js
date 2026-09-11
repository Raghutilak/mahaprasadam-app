// ══════════════════════════════════════════════════════════════════
// supabaseStaffAuthClient.js
// Real @supabase/supabase-js client for STAFF sessions specifically.
//
// This is deliberately a separate client instance from supabaseAuthClient.js
// (customers) — each supabase-js client keeps exactly one session in its own
// browser storage slot, so if staff and customer auth shared a client,
// logging in as staff on a device would silently sign out any customer
// session there (and vice versa). A distinct `storageKey` below keeps the
// two completely independent, e.g. for admin staff who also use "Preview
// Customer Book Order" on the same device.
//
// Session persistence, token refresh, and everything else about "is this
// still a valid login" is handled by Supabase Auth itself here — not a
// hand-rolled localStorage boolean.
// ══════════════════════════════════════════════════════════════════
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://mtenqjudpspxwntamgjv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BIsAjxfeXUa90vWHV2sRHA_zkwU4whJ";

export const supabaseStaffAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storageKey: "sweet-staff-auth" },
});

// Base URL for the admin-staff-management Edge Function (password resets,
// adding staff, role changes — anything needing the secret key (formerly the service_role key)).
export const EDGE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// Small helper so callers don't have to repeat the auth-header boilerplate.
export async function callAdminStaffFunction(action, payload = {}) {
  const { data: { session } } = await supabaseStaffAuth.auth.getSession();
  if (!session) return { error: { message: "Not logged in." } };

  const res = await fetch(`${EDGE_FUNCTIONS_URL}/admin-staff-management`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });

  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) return { error: body?.error ? { message: body.error } : { message: res.statusText } };
  return { data: body, error: null };
}

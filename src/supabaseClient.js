// ══════════════════════════════════════════════════════════════════
// supabaseClient.js
// Lightweight Supabase REST client (no SDK dependency).
// Same Supabase project used by the Mahaprasadam app's Donation
// module, so donation records stay in sync across both apps.
//
// SECURITY: every request now carries the logged-in STAFF member's own
// Supabase Auth access token (from supabaseStaffAuthClient.js) as its
// Bearer token, instead of just the shared publishable/anon key. This is
// what lets Row Level Security policies on the business tables (sales,
// donations, inventory, ...) actually tell WHO is asking — see
// supabase/migrations/20260913000000_business_tables_rls.sql. Every
// existing sb.from(...)/sb.rpc(...) call site in the app is unaffected —
// this file is the ONLY thing that changed to make that true.
//
// Falls back to the publishable key when nobody's logged in as staff yet
// (e.g. briefly on first load) — RLS still applies to that request as the
// `anon` role, exactly as before, so there's no new exposure either way.
// ══════════════════════════════════════════════════════════════════
import { supabaseStaffAuth } from "./supabaseStaffAuthClient";

const SUPABASE_URL = "https://mtenqjudpspxwntamgjv.supabase.co";
const SUPABASE_KEY = "sb_publishable_BIsAjxfeXUa90vWHV2sRHA_zkwU4whJ";

let currentAccessToken = null;
supabaseStaffAuth.auth.getSession().then(({ data }) => {
  currentAccessToken = data.session?.access_token || null;
});
supabaseStaffAuth.auth.onAuthStateChange((_event, session) => {
  currentAccessToken = session?.access_token || null;
});

function buildHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${currentAccessToken || SUPABASE_KEY}`,
  };
}

function buildJsonHeaders() {
  return { ...buildHeaders(), "Content-Type": "application/json" };
}

// Every method funnels through here so error shape is always consistent —
// callers can always trust { data, error } and must check `error` explicitly
// rather than relying on `data` being null/truthy to infer success.
async function toResult(r) {
  if (!r.ok) {
    let err;
    try { err = await r.json(); } catch { err = { message: r.statusText }; }
    return { data: null, error: { ...err, status: r.status } };
  }
  let data = null;
  try { data = await r.json(); } catch { /* empty body, e.g. 204 No Content */ }
  return { data, error: null };
}

const sb = {
  from: (table) => ({
    select: async (cols = "*") => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}`, { headers: buildHeaders() });
      return toResult(r);
    },

    selectEq: async (cols = "*", col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?select=${cols}&${col}=eq.${encodeURIComponent(val)}`,
        { headers: buildHeaders() }
      );
      return toResult(r);
    },

    // General-purpose filtered select — for anything selectEq/selectIlike don't
    // cover (date ranges, "in" lists, ordering, multiple conditions). Pass a
    // raw PostgREST query-string fragment, e.g.
    //   "sale_date=gte.2026-08-01&sale_date=lte.2026-08-31&sale_type=eq.department_credit&order=sale_date.asc"
    // or "sale_id=in.(1,2,3)". Caller is responsible for encoding any values
    // that need it.
    selectFilter: async (cols = "*", filterString = "") => {
      const query = filterString ? `&${filterString}` : "";
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}${query}`, { headers: buildHeaders() });
      return toResult(r);
    },

    // Case/whitespace-insensitive lookup — use for master-data name matching
    // (departments, account_holders, carriers, etc.) so "TEMPLE" and "Temple"
    // resolve to the same row instead of creating a duplicate.
    selectIlike: async (cols = "*", col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?select=${cols}&${col}=ilike.${encodeURIComponent(val.trim())}`,
        { headers: buildHeaders() }
      );
      return toResult(r);
    },

    insert: async (rows) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...buildJsonHeaders(), Prefer: "return=representation" },
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      });
      return toResult(r);
    },

    upsert: async (rows, onConflict) => {
      const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
        method: "POST",
        headers: { ...buildJsonHeaders(), Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      });
      return toResult(r);
    },

    update: async (updates, col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}`,
        {
          method: "PATCH",
          headers: { ...buildJsonHeaders(), Prefer: "return=representation" },
          body: JSON.stringify(updates),
        }
      );
      return toResult(r);
    },

    delete: async (col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}`,
        { method: "DELETE", headers: { ...buildHeaders(), Prefer: "return=representation" } }
      );
      // A successful DELETE that matched zero rows still returns 200/204 —
      // an empty array in `data` means no row in the table had this id.
      return toResult(r);
    },

    // Deletes EVERY row in the table (still governed by RLS). Used only by
    // the admin "Clear All Data" tool — never called from normal app flows.
    deleteAll: async () => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=not.is.null`, {
        method: "DELETE",
        headers: { ...buildHeaders(), Prefer: "return=minimal" },
      });
      return toResult(r);
    },
  }),

  // Calls a Postgres function (RPC). Used for anything that must be
  // atomic — e.g. a sale header + its line items + its ledger entry —
  // so a partial failure can never leave the database half-written.
  rpc: async (fnName, params = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: "POST",
      headers: buildJsonHeaders(),
      body: JSON.stringify(params),
    });
    return toResult(r);
  },
};

export default sb;

// ══════════════════════════════════════════════════════════════════
// supabaseClient.js
// Lightweight Supabase REST client (no SDK dependency).
// Same Supabase project used by the Mahaprasadam app's Donation
// module, so donation records stay in sync across both apps.
// ══════════════════════════════════════════════════════════════════

const SUPABASE_URL = "https://mtenqjudpspxwntamgjv.supabase.co";
const SUPABASE_KEY = "sb_publishable_BIsAjxfeXUa90vWHV2sRHA_zkwU4whJ";

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

const jsonHeaders = {
  ...headers,
  "Content-Type": "application/json",
};

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
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}`, { headers });
      return toResult(r);
    },

    selectEq: async (cols = "*", col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?select=${cols}&${col}=eq.${encodeURIComponent(val)}`,
        { headers }
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
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${cols}${query}`, { headers });
      return toResult(r);
    },

    // Case/whitespace-insensitive lookup — use for master-data name matching
    // (departments, account_holders, carriers, etc.) so "TEMPLE" and "Temple"
    // resolve to the same row instead of creating a duplicate.
    selectIlike: async (cols = "*", col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?select=${cols}&${col}=ilike.${encodeURIComponent(val.trim())}`,
        { headers }
      );
      return toResult(r);
    },

    insert: async (rows) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...jsonHeaders, Prefer: "return=representation" },
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      });
      return toResult(r);
    },

    upsert: async (rows, onConflict) => {
      const query = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
        method: "POST",
        headers: { ...jsonHeaders, Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
      });
      return toResult(r);
    },

    update: async (updates, col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}`,
        {
          method: "PATCH",
          headers: { ...jsonHeaders, Prefer: "return=representation" },
          body: JSON.stringify(updates),
        }
      );
      return toResult(r);
    },

    delete: async (col, val) => {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}`,
        { method: "DELETE", headers: { ...headers, Prefer: "return=representation" } }
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
        headers: { ...headers, Prefer: "return=minimal" },
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
      headers: jsonHeaders,
      body: JSON.stringify(params),
    });
    return toResult(r);
  },
};

export default sb;

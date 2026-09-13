// ══════════════════════════════════════════════════════════════════
// export-google-sheet
//
// Until now, the Google Apps Script export URL was a VITE_ env var —
// which Vite bundles directly into the shipped JS, meaning it was never
// actually secret. Anyone who opened the browser's dev tools could read
// it straight out of the bundle and POST arbitrary date ranges to it
// directly, with zero authentication, from outside the app entirely.
//
// This function is the fix: the frontend now calls THIS Edge Function
// (with the logged-in staff member's own access token) instead of the
// Apps Script URL directly. This function:
//   1. Verifies the caller has a valid, current staff session.
//   2. Verifies they're an admin OR have the 'export' tab.
//   3. Only then forwards the request to the Apps Script URL — which is
//      now a Supabase secret (GOOGLE_EXPORT_URL), never shipped to the
//      browser at all.
//   4. Attaches a shared secret (GOOGLE_EXPORT_SHARED_SECRET) the Apps
//      Script itself should check before running — belt-and-braces, in
//      case the Apps Script URL ever leaks some other way (it's still
//      technically guessable/loggable infrastructure, just no longer
//      bundled into public JS). See the Apps Script snippet in this
//      function's accompanying migration note.
//
// Deploy with:
//   supabase functions deploy export-google-sheet
// Then set (these are Supabase secrets, NOT Vercel env vars):
//   supabase secrets set GOOGLE_EXPORT_URL=https://script.google.com/... \
//     GOOGLE_EXPORT_SHARED_SECRET=$(openssl rand -hex 24) \
//     ALLOWED_ORIGIN=https://your-app.vercel.app
// Also remove VITE_GOOGLE_EXPORT_URL from .env / Vercel entirely once this
// is live — it should no longer exist as a client-visible variable.
// ══════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.115.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const GOOGLE_EXPORT_URL = Deno.env.get("GOOGLE_EXPORT_URL");
const GOOGLE_EXPORT_SHARED_SECRET = Deno.env.get("GOOGLE_EXPORT_SHARED_SECRET") || "";
// const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "https://sweet-accounts.vercel.app";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "http://localhost:5173";

function getSecretKey(): string | undefined {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      const key = keys?.default || Object.values(keys ?? {})[0];
      if (typeof key === "string" && key) return key;
    } catch { /* fall through */ }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}
const SECRET_KEY = getSecretKey();

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  if (!SUPABASE_URL || !SECRET_KEY || !GOOGLE_EXPORT_URL) {
    return json({ error: "Server configuration is incomplete." }, 500);
  }

  const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Missing Authorization header." }, 401);

  const { data: callerData, error: callerErr } = await admin.auth.getUser(token);
  if (callerErr || !callerData?.user) return json({ error: "Invalid or expired session." }, 401);

  const isAdmin = callerData.user.app_metadata?.role === "admin";
  let hasExportTab = isAdmin;
  if (!hasExportTab) {
    const { data: profile } = await admin.from("staff_users").select("allowed_tabs").eq("id", callerData.user.id).maybeSingle();
    hasExportTab = Array.isArray(profile?.allowed_tabs) && profile.allowed_tabs.includes("export");
  }
  if (!hasExportTab) return json({ error: "You do not have access to export data." }, 403);

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object") return json({ error: "Invalid JSON body." }, 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const fromDate = body.fromDate;
  const toDate = body.toDate;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof fromDate !== "string" || typeof toDate !== "string" || !dateRe.test(fromDate) || !dateRe.test(toDate)) {
    return json({ error: "fromDate and toDate must be YYYY-MM-DD strings." }, 400);
  }

  try {
    const upstream = await fetch(GOOGLE_EXPORT_URL, {
      method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
        },
        body: JSON.stringify({
          fromDate,
          toDate,
          sharedSecret: GOOGLE_EXPORT_SHARED_SECRET,
        }),
      });

    const text = await upstream.text();
    if (!upstream.ok) return json({ error: `Google export HTTP ${upstream.status}: ${text.slice(0, 200)}` }, 502);

    let data;
    try { data = JSON.parse(text); } catch { return json({ error: "Google Sheet server returned a non-JSON response." }, 502); }
    if (!data.success) return json({ error: data.error || "Google Sheet export failed." }, 502);

    return json(data);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Something went wrong contacting the export service." }, 500);
  }
});

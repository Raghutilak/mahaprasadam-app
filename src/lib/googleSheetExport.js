import { supabaseStaffAuth } from "../supabaseStaffAuthClient";

const SUPABASE_URL = "https://mtenqjudpspxwntamgjv.supabase.co";

// The Google Apps Script URL used to be a VITE_ env var, which Vite bundles
// straight into the shipped JS — meaning it was never actually secret, and
// anyone could POST directly to it with no login at all. This now calls a
// Supabase Edge Function instead, which holds the real URL as a
// server-side secret and checks the caller is staff with export access
// before forwarding anything. See supabase/functions/export-google-sheet.
export async function exportToGoogleSheet(fromDate, toDate) {
  const { data: { session } } = await supabaseStaffAuth.auth.getSession();
  if (!session) {
    throw new Error("You must be logged in as staff to export.");
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/export-google-sheet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ fromDate, toDate }),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Export service returned an unexpected response.");
  }

  if (!response.ok || data.error) {
    throw new Error(data.error || `Export failed (HTTP ${response.status}).`);
  }

  return data;
}

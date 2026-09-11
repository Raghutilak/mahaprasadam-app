import { useState } from "react";
import { supabaseStaffAuth } from "./supabaseStaffAuthClient";
import { normalizeStaffRow } from "./data/staffAccess";
import "./AdminLogin.css";

// ── Staff login — real Supabase Auth ──────────────────────────────────────
// Login is by EMAIL now (Supabase Auth's password grant needs an email or
// phone identifier; phone/SMS sign-in isn't configured for this project).
// Every staff member's password lives in Supabase's own auth.users table,
// hashed — never in a plaintext column we manage ourselves.
//
// To add/remove staff or change tab access, use "Manage Passwords" while
// logged in as admin. New accounts and password resets for OTHER people go
// through the admin-staff-management Edge Function (secret key, formerly
// called the service_role key — never shipped to the browser); each
// person's own password change goes through supabase.auth.updateUser()
// directly.

export default function AdminLogin({ onSuccess, onCancel }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);

    try {
      const { data: authData, error: authError } = await supabaseStaffAuth.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (authError || !authData?.user) {
        setError("❌ Those details don't match. Please check and try again.");
        return;
      }

      const { data: profileRow, error: profileError } = await supabaseStaffAuth
        .from("staff_users")
        .select("*")
        .eq("id", authData.user.id)
        .single();

      if (profileError || !profileRow) {
        setError("Logged in, but couldn't find a staff profile for this account. Ask an admin to check Manage Passwords.");
        await supabaseStaffAuth.auth.signOut();
        return;
      }

      // Role for permission checks always comes from the JWT's app_metadata
      // (tamper-proof, set only via the Admin API) — fall back to the
      // profile row's role only for display if that's ever missing.
      // const role = authData.user.app_metadata?.role || profileRow.role;

      const role = authData.user.app_metadata?.role;

      if (role !== "admin" && role !== "staff") {
        setError("This account is not configured as a staff account.");
        await supabaseStaffAuth.auth.signOut();
        return;
      }

      onSuccess(normalizeStaffRow({ ...profileRow, role }));
    } catch (err) {
      setError(err.message || "Something went wrong logging in. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-login-overlay" role="dialog" aria-modal="true">
      <div className="admin-login-card">
        <h2>🔒 Staff Login</h2>
        <p>Enter your staff email and password to open the admin dashboard.</p>

        <form onSubmit={handleSubmit} className="customer-auth-form">
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>
          <label>
            Password
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          {error && <p className="customer-auth-error">{error}</p>}

          <button type="submit" className="save-sale-button" disabled={busy}>
            {busy ? "Checking…" : "Log In"}
          </button>
        </form>

        <button type="button" className="adjust-btn-ghost" onClick={onCancel}>← Back to Book Order</button>
      </div>
    </div>
  );
}

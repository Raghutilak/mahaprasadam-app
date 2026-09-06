import { useState } from "react";
import "./AdminLogin.css";

// ── Hardcoded staff credentials ──────────────────────────────────────────
// IMPORTANT: this is a UI convenience gate only, NOT real authentication.
// Anyone who opens the browser dev tools / views the built JS bundle can
// read this value — it just keeps ordinary customers from stumbling into
// the admin dashboard by accident. Real data protection still comes from
// Supabase Row Level Security on the tables themselves (the `sb` client
// used throughout the admin app has no login of its own either).
// To change the staff login later, just edit the values below.
const ADMIN_CREDENTIALS = {
  email: "raghutilak.das@gmail.com",
  mobile: "8422886705",
  password: "123",
};

export default function AdminLogin({ onSuccess, onCancel }) {
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    const ok =
      email.trim().toLowerCase() === ADMIN_CREDENTIALS.email.toLowerCase() &&
      mobile.trim() === ADMIN_CREDENTIALS.mobile &&
      password === ADMIN_CREDENTIALS.password;

    if (ok) {
      setError("");
      onSuccess();
    } else {
      setError("❌ Those details don't match. Please check and try again.");
    }
  };

  return (
    <div className="admin-login-overlay" role="dialog" aria-modal="true">
      <div className="admin-login-card">
        <h2>🔒 Staff Login</h2>
        <p>Enter your staff details to open the admin dashboard.</p>

        <form onSubmit={handleSubmit} className="customer-auth-form">
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          <label>
            Mobile Number
            <input type="tel" required value={mobile} onChange={(e) => setMobile(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          {error && <p className="customer-auth-error">{error}</p>}

          <button type="submit" className="save-sale-button">Log In</button>
        </form>

        <button type="button" className="adjust-btn-ghost" onClick={onCancel}>← Back to Book Order</button>
      </div>
    </div>
  );
}

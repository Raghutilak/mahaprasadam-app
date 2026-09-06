import { useState } from "react";
import { supabaseAuth } from "../supabaseAuthClient";
import "./CustomerPortal.css";

export default function CustomerAuth({ onExit, onStaffLoginClick, onGuestContinue }) {
  const [mode, setMode] = useState("login"); // "login" | "signup" | "forgot"
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const switchMode = (nextMode) => { setMode(nextMode); setError(""); setMessage(""); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(""); setMessage("");

    try {
      if (mode === "forgot") {
        const { error: resetError } = await supabaseAuth.auth.resetPasswordForEmail(email.trim());
        if (resetError) throw resetError;
        setMessage("✅ If that email has an account, a password reset link has been sent — check your inbox.");
      } else if (mode === "signup") {
        if (!mobile.trim()) throw new Error("Please enter your mobile number.");
        const { data, error: signUpError } = await supabaseAuth.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { mobile: mobile.trim() } },
        });
        if (signUpError) throw signUpError;

        // If email confirmation is ON, there's no session yet — show a "check your inbox" message.
        // If it's OFF, Supabase returns a session immediately and the app will move to the booking
        // screen on its own (App.jsx listens for auth state changes).
        if (!data.session) {
          setMessage("✅ Account created! Please check your email to confirm your address, then log in.");
          setMode("login");
        }
      } else {
        const { error: signInError } = await supabaseAuth.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) throw signInError;
      }
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const titleByMode = {
    login: "Log in to place or view your order.",
    signup: "Create an account to book sweets.",
    forgot: "Enter your email and we'll send you a reset link.",
  };

  return (
    <div className="customer-portal">
      <div className="customer-auth-card">
        <h1>🍬 Book Order</h1>
        <p>{titleByMode[mode]}</p>

        <form onSubmit={handleSubmit} className="customer-auth-form">
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>

          {mode === "signup" && (
            <label>
              Mobile Number
              <input type="tel" required value={mobile} onChange={(e) => setMobile(e.target.value)} />
            </label>
          )}

          {mode !== "forgot" && (
            <label>
              Password
              <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          )}

          {error && <p className="customer-auth-error">❌ {error}</p>}
          {message && <p className="customer-auth-message">{message}</p>}

          <button type="submit" className="save-sale-button" disabled={busy}>
            {busy ? "Please wait..." : mode === "login" ? "Log In" : mode === "signup" ? "Create Account" : "Send Reset Link"}
          </button>
        </form>

        {mode === "login" && (
          <button type="button" className="adjust-btn-ghost" style={{ marginTop: 4 }} onClick={() => switchMode("forgot")}>
            Forgot password?
          </button>
        )}

        <button type="button" className="adjust-btn-ghost" onClick={() => switchMode(mode === "login" || mode === "forgot" ? "signup" : "login")}>
          {mode === "signup" ? "Already have an account? Log in" : "New here? Create an account"}
        </button>

        {mode === "forgot" && (
          <button type="button" className="adjust-btn-ghost" onClick={() => switchMode("login")}>
            ← Back to Log In
          </button>
        )}

        {onGuestContinue && (mode === "login" || mode === "signup") && (
          <button type="button" className="save-sale-button" style={{ marginTop: 12, background: "transparent", border: "1px solid var(--gold)", color: "var(--gold-light)", boxShadow: "none" }} onClick={onGuestContinue}>
            🎫 Continue as Guest (no account needed)
          </button>
        )}

        {onExit && (
          <button type="button" className="adjust-btn-ghost" style={{ marginTop: 8 }} onClick={onExit}>
            ← Back
          </button>
        )}

        {onStaffLoginClick && (
          <button type="button" className="staff-login-link" onClick={onStaffLoginClick}>
            🔒 Staff Login
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { supabaseStaffAuth, callAdminStaffFunction } from "./supabaseStaffAuthClient";
import { ALL_TABS, DEFAULT_NEW_STAFF_TABS, normalizeStaffRow } from "./data/staffAccess";
import "./ManagePasswords.css";

// ── "Reset Password Data" page ───────────────────────────────────────────
// Staff (non-admin): can only change their OWN password — via real
// Supabase Auth (supabase.auth.updateUser), not a table write.
// Admin: sees every staff member's profile (name/email/mobile/role/tabs —
// NO passwords are ever stored or displayed anywhere anymore) and can
// reset anyone's password, change tab access, change roles, or add new
// staff — all privileged actions go through the admin-staff-management
// Edge Function, which holds the secret key (formerly the service_role key) server-side.

export default function ManagePasswords({ currentStaff, onSelfUpdated }) {
  const isAdmin = currentStaff.role === "admin";

  return isAdmin
    ? <AdminPasswordPanel currentStaff={currentStaff} onSelfUpdated={onSelfUpdated} />
    : <SelfPasswordPanel currentStaff={currentStaff} />;
}

// ── Self-service: any staff member changing only their own password ─────
function SelfPasswordPanel({ currentStaff }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const handleSave = async (e) => {
    e.preventDefault();
    setMsg(""); setErr("");
    if (!newPassword || newPassword !== confirmPassword) {
      setErr("Passwords don't match (or are empty).");
      return;
    }
    if (newPassword.length < 6) {
      setErr("Password must be at least 6 characters (Supabase Auth's minimum).");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabaseStaffAuth.auth.updateUser({ password: newPassword });
      if (error) throw new Error(error.message || "Could not save the new password.");
      setNewPassword(""); setConfirmPassword("");
      setMsg("✅ Password updated.");
    } catch (e2) {
      setErr(e2.message || "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div><h1>🔑 My Password</h1><p>Only you can see or change your own login details here.</p></div>
      </header>

      <section className="batch-card">
        <h2>Your Details</h2>
        <div className="item-row"><span>Name</span><strong>{currentStaff.name}</strong></div>
        {currentStaff.email && <div className="item-row"><span>Email (login)</span><strong>{currentStaff.email}</strong></div>}
        {currentStaff.mobile && <div className="item-row"><span>Mobile</span><strong>{currentStaff.mobile}</strong></div>}
      </section>

      <section className="batch-card">
        <h2>Change Password</h2>
        <form onSubmit={handleSave} className="customer-auth-form">
          <label>
            New Password
            <input type="password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </label>
          <label>
            Confirm New Password
            <input type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </label>
          {err && <p className="customer-auth-error">{err}</p>}
          {msg && <p className="customer-auth-success">{msg}</p>}
          <button type="submit" className="save-sale-button" disabled={saving}>
            {saving ? "Saving…" : "Save New Password"}
          </button>
        </form>
      </section>
    </>
  );
}

// ── Admin: full staff directory, tab management, password resets ────────
function AdminPasswordPanel({ currentStaff, onSelfUpdated }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [editingId, setEditingId] = useState(null); // row currently being edited (tabs/name/mobile only)
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [rowMsg, setRowMsg] = useState({}); // { [id]: message }

  const [showAddForm, setShowAddForm] = useState(false);
  const [newStaff, setNewStaff] = useState({
    name: "", email: "", mobile: "", password: "", allowedTabs: [...DEFAULT_NEW_STAFF_TABS],
  });
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const loadStaff = async () => {
    setLoading(true); setLoadError("");
    try {
      const { data, error } = await supabaseStaffAuth.from("staff_users").select("*");
      if (error) throw new Error(error.message || "Could not load staff list.");
      setStaff((data || []).map(normalizeStaffRow).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      setLoadError(e.message || "Something went wrong loading the staff list.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStaff(); }, []);

  const startEdit = (row) => {
    setEditingId(row.id);
    setDraft({ name: row.name, mobile: row.mobile, allowedTabs: [...row.allowedTabs] });
  };
  const cancelEdit = () => { setEditingId(null); setDraft(null); };

  const toggleDraftTab = (key) => {
    setDraft((d) => ({
      ...d,
      allowedTabs: d.allowedTabs.includes(key) ? d.allowedTabs.filter((t) => t !== key) : [...d.allowedTabs, key],
    }));
  };

  const saveEdit = async (id) => {
    setSaving(true);
    try {
      const { data, error } = await supabaseStaffAuth
        .from("staff_users")
        .update({ name: draft.name.trim(), mobile: draft.mobile.trim() || null, allowed_tabs: draft.allowedTabs })
        .eq("id", id)
        .select()
        .single();
      if (error) throw new Error(error.message || "Could not save changes.");
      setStaff((prev) => prev.map((s) => (s.id === id ? normalizeStaffRow(data) : s)));
      if (id === currentStaff.id) onSelfUpdated(normalizeStaffRow(data));
      setRowMsg((m) => ({ ...m, [id]: "✅ Saved." }));
      setEditingId(null); setDraft(null);
    } catch (e) {
      setRowMsg((m) => ({ ...m, [id]: `❌ ${e.message || "Could not save."}` }));
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async (row) => {
    const newPassword = window.prompt(`New password for ${row.name}:`);
    if (!newPassword) return;
    if (newPassword.length < 6) { setRowMsg((m) => ({ ...m, [row.id]: "❌ Must be at least 6 characters." })); return; }

    setRowMsg((m) => ({ ...m, [row.id]: "Resetting…" }));
    const { error } = await callAdminStaffFunction("reset-password", { staffId: row.id, newPassword });
    setRowMsg((m) => ({ ...m, [row.id]: error ? `❌ ${error.message}` : "✅ Password reset." }));
  };

  const toggleRole = async (row) => {
    const newRole = row.role === "admin" ? "staff" : "admin";
    if (!window.confirm(`Change ${row.name} to ${newRole}?`)) return;
    setRowMsg((m) => ({ ...m, [row.id]: "Updating…" }));
    const { error } = await callAdminStaffFunction("update-role", { staffId: row.id, role: newRole });
    if (error) { setRowMsg((m) => ({ ...m, [row.id]: `❌ ${error.message}` })); return; }
    setStaff((prev) => prev.map((s) => (s.id === row.id ? { ...s, role: newRole } : s)));
    if (row.id === currentStaff.id) onSelfUpdated({ ...currentStaff, role: newRole });
    setRowMsg((m) => ({ ...m, [row.id]: "✅ Role updated." }));
  };

  const toggleNewStaffTab = (key) => {
    setNewStaff((s) => ({
      ...s,
      allowedTabs: s.allowedTabs.includes(key) ? s.allowedTabs.filter((t) => t !== key) : [...s.allowedTabs, key],
    }));
  };

  const handleAddStaff = async (e) => {
    e.preventDefault();
    setAddError("");
    if (!newStaff.name.trim() || !newStaff.email.trim() || !newStaff.password.trim()) {
      setAddError("Name, email, and password are required (Supabase Auth needs an email to log in with).");
      return;
    }
    if (newStaff.password.length < 6) { setAddError("Password must be at least 6 characters."); return; }

    setAddBusy(true);
    try {
      const { data, error } = await callAdminStaffFunction("add-staff", {
        name: newStaff.name.trim(),
        email: newStaff.email.trim().toLowerCase(),
        mobile: newStaff.mobile.trim() || null,
        password: newStaff.password,
        allowedTabs: newStaff.allowedTabs,
      });
      if (error) throw new Error(error.message);
      if (data?.staff) setStaff((prev) => [...prev, normalizeStaffRow(data.staff)].sort((a, b) => a.name.localeCompare(b.name)));
      setNewStaff({ name: "", email: "", mobile: "", password: "", allowedTabs: [...DEFAULT_NEW_STAFF_TABS] });
      setShowAddForm(false);
    } catch (e2) {
      setAddError(e2.message || "Something went wrong.");
    } finally {
      setAddBusy(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div><h1>🔑 Manage Passwords</h1><p>Staff logins & access — passwords themselves are never stored or shown here (Supabase Auth handles them).</p></div>
      </header>

      {loading && <p>Loading staff…</p>}
      {loadError && <p className="customer-auth-error">{loadError}</p>}

      {!loading && !loadError && (
        <section className="batch-card">
          <h2>Staff Accounts ({staff.length})</h2>
          <div className="adjust-table-wrap">
            <table className="adjust-table manage-passwords-table">
              <thead>
                <tr><th>Name</th><th>Email (login)</th><th>Mobile</th><th>Role</th><th>Tabs</th><th></th></tr>
              </thead>
              <tbody>
                {staff.map((row) => {
                  const editing = editingId === row.id;
                  return (
                    <tr key={row.id}>
                      <td>{editing ? <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} /> : row.name}</td>
                      <td>{row.email || "—"}</td>
                      <td>{editing ? <input value={draft.mobile || ""} onChange={(e) => setDraft((d) => ({ ...d, mobile: e.target.value }))} /> : (row.mobile || "—")}</td>
                      <td>
                        {row.role === "admin" ? "Admin" : "Staff"}{" "}
                        <button className="adjust-btn-ghost" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => toggleRole(row)}>
                          {row.role === "admin" ? "Make Staff" : "Make Admin"}
                        </button>
                      </td>
                      <td>
                        {editing ? (
                          <div className="tab-checkbox-grid">
                            {ALL_TABS.map((t) => (
                              <label key={t.key} className="tab-checkbox">
                                <input type="checkbox" checked={draft.allowedTabs.includes(t.key)} onChange={() => toggleDraftTab(t.key)} />
                                {t.label}
                              </label>
                            ))}
                          </div>
                        ) : row.role === "admin" ? "All" : (row.allowedTabs.map((k) => ALL_TABS.find((t) => t.key === k)?.label || k).join(", ") || "—")}
                      </td>
                      <td>
                        {editing ? (
                          <>
                            <button className="adjust-btn-primary" disabled={saving} onClick={() => saveEdit(row.id)}>Save</button>
                            <button className="adjust-btn-discard" disabled={saving} onClick={cancelEdit}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button className="adjust-btn-ghost" onClick={() => startEdit(row)}>Edit Tabs</button>{" "}
                            <button className="adjust-btn-ghost" onClick={() => resetPassword(row)}>Reset Password</button>
                          </>
                        )}
                        {rowMsg[row.id] && <p className="row-msg">{rowMsg[row.id]}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="batch-card">
        <h2>Add Staff</h2>
        {!showAddForm ? (
          <button className="save-sale-button" onClick={() => setShowAddForm(true)}>➕ Add New Staff Member</button>
        ) : (
          <form onSubmit={handleAddStaff} className="customer-auth-form">
            <label>Name<input required value={newStaff.name} onChange={(e) => setNewStaff((s) => ({ ...s, name: e.target.value }))} /></label>
            <label>Email (used to log in)<input type="email" required value={newStaff.email} onChange={(e) => setNewStaff((s) => ({ ...s, email: e.target.value }))} /></label>
            <label>Mobile (optional, for display only)<input type="tel" value={newStaff.mobile} onChange={(e) => setNewStaff((s) => ({ ...s, mobile: e.target.value }))} /></label>
            <label>Temporary Password (they can change it later)<input required value={newStaff.password} onChange={(e) => setNewStaff((s) => ({ ...s, password: e.target.value }))} /></label>
            <div className="tab-checkbox-grid">
              {ALL_TABS.map((t) => (
                <label key={t.key} className="tab-checkbox">
                  <input type="checkbox" checked={newStaff.allowedTabs.includes(t.key)} onChange={() => toggleNewStaffTab(t.key)} />
                  {t.label}
                </label>
              ))}
            </div>
            <p style={{ fontSize: 12, opacity: 0.7 }}>📦 Book Order is always available to every staff member, in addition to whatever's checked above.</p>
            {addError && <p className="customer-auth-error">{addError}</p>}
            <button type="submit" className="save-sale-button" disabled={addBusy}>{addBusy ? "Adding…" : "Add Staff Member"}</button>
            <button type="button" className="adjust-btn-ghost" onClick={() => setShowAddForm(false)}>Cancel</button>
          </form>
        )}
      </section>
    </>
  );
}

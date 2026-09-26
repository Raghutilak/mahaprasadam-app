import { Fragment, useEffect, useMemo, useState } from "react";
import "./CreditReport.css"; // shared table/print/control styling
import sb from "./supabaseClient";
import { departments } from "./DepartmentCredit";
import { getBusinessDate, getBusinessMonth } from "./dateUtils";

const todayISO = getBusinessDate;
const currentMonthStr = getBusinessMonth;

const formatDateForDisplay = (isoDate) => {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// Maps the raw payment_method stored in Supabase to the display labels used
// on the Credit Recovery form ("Cash" / "Paytm" / "T.R.").
const paymentMethodLabel = (m) => (m === "cash" ? "Cash" : m === "paytm" ? "Paytm" : m === "tr" ? "T.R." : m ? "Other" : "—");

// The Recovery Mode column shows the mode plus whatever identifies that
// specific payment: for Cash/Paytm that's the date it was actually
// received; for T.R./Other, the T.R. No. / reference number entered on the
// form (credit_payments.reference_number).
const formatModeWithReference = (p) => {
  const mode = paymentMethodLabel(p.payment_method);
  if (p.payment_method === "cash" || p.payment_method === "paytm") {
    return p.payment_date ? `${mode} — ${formatDateForDisplay(p.payment_date)}` : mode;
  }
  return p.reference_number ? `${mode} — ${p.reference_number}` : mode;
};

// The Credit Recovery form writes "Received From" info into
// credit_payments.notes as "Type: Name (mobile)" (see saveRecoveryToSupabase
// in App.jsx) — pull just the name back out. Falls back to the raw note for
// older/manual entries that aren't in that shape.
const extractPayerFromNotes = (notes) => {
  if (!notes) return "";
  const match = String(notes).match(/^[^:]+:\s*(.+?)(\s*\([^)]*\))?$/);
  return match ? match[1].trim() : String(notes).trim();
};

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// creditType: "department" | "individual"
// isAdmin: only admins can correct/delete a recovery payment — money has
// already changed hands, so this stays tighter than the sale corrections
// any staff member with the payment tab can do elsewhere.
function CreditRecoveryReport({ creditType, backLabel = "← Back to Reports", onBack, isAdmin = false }) {
  const [period, setPeriod] = useState("daily");
  const [fromDate, setFromDate] = useState(todayISO());
  const [toDate, setToDate] = useState(todayISO());
  const [month, setMonth] = useState(currentMonthStr());

  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedIndividual, setSelectedIndividual] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [payments, setPayments] = useState([]);

  const [departmentIdToName, setDepartmentIdToName] = useState({});
  const [accountHolderIdToName, setAccountHolderIdToName] = useState({});

  // Bumped after a correction/delete is saved, to force the payments fetch
  // below to re-run so the report reflects it immediately.
  const [reloadKey, setReloadKey] = useState(0);

  // ── Correction (admin-only) state ──────────────────────────────────
  const [editingPayment, setEditingPayment] = useState(null); // raw credit_payments row
  const [editForm, setEditForm] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [actionError, setActionError] = useState("");
  const [actionMsg, setActionMsg] = useState("");

  const title = creditType === "department" ? "🏢 Department Credit Recovery" : "👤 Individual Credit Recovery";

  // ── Load name lookups once ─────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const { data: deptRows, error: deptErr } = await sb.from("departments").select("id,name");
        if (!deptErr && Array.isArray(deptRows)) {
          const map = {};
          deptRows.forEach((r) => { map[r.id] = r.name; });
          setDepartmentIdToName(map);
        }
        const { data: holderRows, error: holderErr } = await sb.from("account_holders").select("id,name");
        if (!holderErr && Array.isArray(holderRows)) {
          const map = {};
          holderRows.forEach((r) => { map[r.id] = r.name; });
          setAccountHolderIdToName(map);
        }
      } catch (e) {
        console.error("Credit recovery report lookup load error:", e);
      }
    };
    load();
  }, []);

  const individualOptions = useMemo(
    () => [...new Set(Object.values(accountHolderIdToName))].sort((a, b) => a.localeCompare(b)),
    [accountHolderIdToName]
  );

  // ── Resolve the effective date range for the current period ───────
  const effectiveRange = useMemo(() => {
    if (period === "daily") return { from: fromDate, to: toDate };
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return { from: null, to: null };
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to };
  }, [period, fromDate, toDate, month]);

  // ── Fetch recovery payments for the current filters ────────────────
  useEffect(() => {
    const load = async () => {
      if (!effectiveRange.from || !effectiveRange.to) return;
      setLoading(true);
      setLoadError("");
      try {
        const entityCol = creditType === "department" ? "department_id" : "account_holder_id";
        const filter = `payment_date=gte.${effectiveRange.from}&payment_date=lte.${effectiveRange.to}&${entityCol}=not.is.null&order=payment_date.asc`;
        const { data, error } = await sb.from("credit_payments").selectFilter("*", filter);
        if (error) throw error;
        setPayments(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Credit recovery report load error:", e);
        setLoadError(e?.message || "Could not load recovery data.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [effectiveRange.from, effectiveRange.to, creditType, reloadKey]);

  // ── Build display rows — one row per recovery payment ──────────────
  const rows = useMemo(() => {
    return payments
      .map((p) => {
        const name = creditType === "department" ? departmentIdToName[p.department_id] : accountHolderIdToName[p.account_holder_id];
        return {
          id: p.id,
          date: p.payment_date,
          name: name || "—",
          amount: Number(p.amount) || 0,
          mode: formatModeWithReference(p),
          baseMode: paymentMethodLabel(p.payment_method),
          payer: extractPayerFromNotes(p.notes),
          reference: p.reference_number || "",
          // Raw fields, kept around for the admin edit form.
          rawPaymentMethod: p.payment_method,
          rawNotes: p.notes || "",
        };
      })
      .filter((r) => {
        if (creditType === "department" && selectedDepartment) return r.name.toUpperCase() === selectedDepartment.toUpperCase();
        if (creditType === "individual" && selectedIndividual) return r.name === selectedIndividual;
        return true;
      })
      .sort((a, b) => {
        if (a.date !== b.date) return (a.date || "") > (b.date || "") ? 1 : -1;
        return (a.name || "").trim().toUpperCase().localeCompare((b.name || "").trim().toUpperCase());
      });
  }, [payments, creditType, departmentIdToName, accountHolderIdToName, selectedDepartment, selectedIndividual]);

  // ── Admin-only correction/delete ────────────────────────────────────
  const openEditForPayment = (paymentId) => {
    const raw = payments.find((p) => p.id === paymentId);
    if (!raw) return;
    setActionError("");
    setActionMsg("");
    setEditingPayment(raw);
    setEditForm({
      amount: String(raw.amount ?? ""),
      paymentMethod: raw.payment_method || "cash",
      paymentDate: raw.payment_date || todayISO(),
      referenceNumber: raw.reference_number || "",
    });
  };

  const cancelEdit = () => {
    setEditingPayment(null);
    setEditForm(null);
  };

  const saveEdit = async () => {
    if (!editingPayment || !editForm) return;
    const amount = Number(editForm.amount);
    if (!amount || amount <= 0) { setActionError("Amount must be greater than zero."); return; }
    if ((editForm.paymentMethod === "tr" || editForm.paymentMethod === "other") && !editForm.referenceNumber.trim()) {
      setActionError(editForm.paymentMethod === "tr" ? "Enter the T.R. No." : "Enter a reference number.");
      return;
    }
    setSavingEdit(true);
    setActionError("");
    try {
      const { error } = await sb.rpc("admin_correct_recovery_payment", {
        p_payment_id: editingPayment.id,
        p_updates: {
          amount,
          payment_method: editForm.paymentMethod,
          payment_date: editForm.paymentDate,
          reference_number: editForm.referenceNumber.trim() || null,
        },
      });
      if (error) throw error;
      setActionMsg("Recovery payment updated.");
      cancelEdit();
      setReloadKey((k) => k + 1);
    } catch (e) {
      console.error("Recovery correction error:", e);
      setActionError(e?.message || "Could not save the correction.");
    } finally {
      setSavingEdit(false);
    }
  };

  const deletePayment = async (paymentId) => {
    if (!window.confirm("Delete this recovery payment? The due amount will be restored.")) return;
    setDeletingId(paymentId);
    setActionError("");
    setActionMsg("");
    try {
      const { error } = await sb.rpc("admin_delete_recovery_payment", { p_payment_id: paymentId });
      if (error) throw error;
      setActionMsg("Recovery payment deleted.");
      setReloadKey((k) => k + 1);
    } catch (e) {
      console.error("Recovery delete error:", e);
      setActionError(e?.message || "Could not delete this payment.");
    } finally {
      setDeletingId(null);
    }
  };

  const grandTotal = rows.reduce((t, r) => t + r.amount, 0);
  const modeSubtotals = useMemo(() => {
    const totals = {};
    rows.forEach((r) => { totals[r.baseMode] = (totals[r.baseMode] || 0) + r.amount; });
    return totals;
  }, [rows]);

  // ── Print — see CreditReport.jsx for the reasoning behind the hidden
  // same-tab iframe approach (far more reliable on mobile than window.open
  // or printing the app's own flex/sticky layout directly).
  const handlePrint = () => {
    const scopeLine = [
      period === "daily"
        ? `Daily Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`
        : `Monthly Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`,
      creditType === "department" ? (selectedDepartment ? `Department: ${selectedDepartment}` : "All Departments") : "",
      creditType === "individual" && selectedIndividual ? `Individual: ${selectedIndividual}` : "",
    ]
      .filter(Boolean)
      .map(escapeHtml)
      .join(" — ");

    const bodyRows =
      rows
        .map(
          (r) => `<tr>
        <td>${escapeHtml(formatDateForDisplay(r.date))}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.mode)}</td>
        <td>${escapeHtml(r.payer || "—")}</td>
        <td class="amt">₹ ${r.amount}</td>
      </tr>`
        )
        .join("") ||
      `<tr><td colspan="5" style="text-align:center;color:#666;padding:20px;">No recoveries in this range.</td></tr>`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title.replace(/[^\w\s]/g, "").trim())}</title>
<style>
  @page { margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #000; background: #fff; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .scope { font-size: 13px; color: #333; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th { background: #eee; }
  tfoot td { border-top: 2px solid #333; }
  td.amt, th:last-child { text-align: right; white-space: nowrap; }
  tr { break-inside: avoid; }
  @media (max-width: 500px) { table, th, td { font-size: 11px; } }
</style>
</head>
<body>
  <h1>${escapeHtml(title)} — ${period === "daily" ? "Daily Report" : "Monthly Report"}</h1>
  <p class="scope">${scopeLine}</p>
  <table>
    <thead><tr><th>Date</th><th>${creditType === "department" ? "Department" : "Individual"}</th><th>Recovery Mode</th><th>Received From</th><th>Amount</th></tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr><td colspan="4"><strong>Total</strong></td><td class="amt"><strong>₹ ${grandTotal}</strong></td></tr></tfoot>
  </table>
</body>
</html>`;

    const existing = document.getElementById("credit-recovery-print-frame");
    if (existing) existing.remove();
    const iframe = document.createElement("iframe");
    iframe.id = "credit-recovery-print-frame";
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const frameDoc = iframe.contentWindow.document;
    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();

    let printed = false;
    const doPrint = () => {
      if (printed) return;
      printed = true;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch {
        // Nothing more to do if the browser refuses the print call outright.
      }
    };
    iframe.onload = doPrint;
    setTimeout(doPrint, 400);
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 60000);
  };

  return (
    <div className="credit-report">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          <p>Every recovery payment received — not merged into the credit-sale ledger.</p>
        </div>
        <div className="credit-report-header-actions">
          <button type="button" className="credit-report-print" onClick={handlePrint}>🖨️ Print</button>
          <button className="credit-report-back" onClick={onBack}>{backLabel}</button>
        </div>
      </header>

      <p className="credit-report-print-only credit-report-print-scope">
        {period === "daily"
          ? `Daily Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`
          : `Monthly Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`}
      </p>

      <section className="credit-report-controls">
        <div className="credit-report-period-toggle">
          <button className={period === "daily" ? "active" : ""} onClick={() => setPeriod("daily")}>Daily</button>
          <button className={period === "monthly" ? "active" : ""} onClick={() => setPeriod("monthly")}>Monthly</button>
        </div>

        {period === "daily" ? (
          <div className="credit-report-dates">
            <label>From<input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
            <label>To<input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
          </div>
        ) : (
          <div className="credit-report-dates">
            <label>Month<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
          </div>
        )}

        <div className="credit-report-dropdown">
          {creditType === "department" ? (
            <label>
              Department
              <select value={selectedDepartment} onChange={(e) => setSelectedDepartment(e.target.value)}>
                <option value="">All Departments</option>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Individual
              <select value={selectedIndividual} onChange={(e) => setSelectedIndividual(e.target.value)}>
                <option value="">All Individuals</option>
                {individualOptions.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>

      {loading && <p className="credit-report-status">Loading…</p>}
      {loadError && <p className="credit-report-status credit-report-error">{loadError}</p>}
      {actionError && <p className="credit-report-status credit-report-error">{actionError}</p>}
      {actionMsg && <p className="credit-report-status">{actionMsg}</p>}

      {!loading && !loadError && (
        <>
          <section className="report-grid">
            {Object.entries(modeSubtotals).map(([mode, amt]) => (
              <div className="report-card" key={mode}>
                <span>{mode} Recovery</span>
                <strong>₹ {amt}</strong>
              </div>
            ))}
          </section>

          <div className="credit-report-table-wrap">
            <table className="credit-report-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>{creditType === "department" ? "Department" : "Individual"}</th>
                  <th>Recovery Mode</th>
                  <th>Received From</th>
                  <th>Amount</th>
                  {isAdmin && <th className="credit-report-actions-col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 6 : 5} className="credit-report-empty">No recovery payments found for this selection.</td>
                  </tr>
                )}
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      <td>{formatDateForDisplay(r.date)}</td>
                      <td>{r.name}</td>
                      <td>{r.mode}</td>
                      <td>{r.payer || "—"}</td>
                      <td className="credit-report-amount">₹ {r.amount}</td>
                      {isAdmin && (
                        <td className="credit-report-actions">
                          <button type="button" onClick={() => openEditForPayment(r.id)}>✏️ Correct</button>
                          <button type="button" onClick={() => deletePayment(r.id)} disabled={deletingId === r.id}>
                            {deletingId === r.id ? "Deleting…" : "🗑️ Delete"}
                          </button>
                        </td>
                      )}
                    </tr>
                    {isAdmin && editingPayment?.id === r.id && editForm && (
                      <tr className="credit-report-subrow">
                        <td colSpan={6}>
                          <div className="credit-report-edit-panel">
                            <label>
                              Amount
                              <input type="number" min="1" value={editForm.amount} onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))} />
                            </label>
                            <label>
                              Mode
                              <select value={editForm.paymentMethod} onChange={(e) => setEditForm((f) => ({ ...f, paymentMethod: e.target.value }))}>
                                <option value="cash">Cash</option>
                                <option value="paytm">Paytm</option>
                                <option value="tr">T.R.</option>
                                <option value="other">Other</option>
                              </select>
                            </label>
                            <label>
                              Date Received
                              <input type="date" value={editForm.paymentDate} onChange={(e) => setEditForm((f) => ({ ...f, paymentDate: e.target.value }))} />
                            </label>
                            {(editForm.paymentMethod === "tr" || editForm.paymentMethod === "other") && (
                              <label>
                                {editForm.paymentMethod === "tr" ? "T.R. No." : "Reference No."}
                                <input type="text" value={editForm.referenceNumber} onChange={(e) => setEditForm((f) => ({ ...f, referenceNumber: e.target.value }))} />
                              </label>
                            )}
                            <div className="credit-report-edit-actions">
                              <button type="button" className="credit-report-save-correction" onClick={saveEdit} disabled={savingEdit}>
                                {savingEdit ? "Saving…" : "💾 Save"}
                              </button>
                              <button type="button" onClick={cancelEdit} disabled={savingEdit}>Cancel</button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={4}><strong>Total</strong></td>
                    <td className="credit-report-amount"><strong>₹ {grandTotal}</strong></td>
                    {isAdmin && <td />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default CreditRecoveryReport;

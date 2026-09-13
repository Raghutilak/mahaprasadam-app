import { useEffect, useMemo, useState } from "react";
import "./CreditReport.css";
import sb from "./supabaseClient";

const sweetOrder = ["Peda", "Sandesh", "Rasagulla", "Rasamalai", "Sweet Samosa", "Cake", "Ladoo"];

const prices = {
  Peda: 15,
  Sandesh: 15,
  Rasagulla: 25,
  Rasamalai: 25,
  "Sweet Samosa": 150,
  Cake: 60,
  Ladoo: 60,
};

// saleType: "cash" | "upi" — "upi" covers BOTH channels the Paytm Sale entry form can save under
// (payment_method "paytm" or "upi"), so this report matches everything that section records —
// same set of rows the Dashboard's own paytmTotal already sums.

const todayISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

function SaleReport({ saleType, selectedDate, setSelectedDate, onCorrected, dateLocked = false }) {
  const [sales, setSales] = useState([]);
  const [itemsBySaleId, setItemsBySaleId] = useState({});
  const [sweetIdToName, setSweetIdToName] = useState({});
  const [nameToSweetId, setNameToSweetId] = useState({});

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  // Bump this to force the sales/sale_items fetch below to re-run after a
  // correction has been saved, so the report reflects it immediately.
  const [reloadKey, setReloadKey] = useState(0);

  // ── Correction (quantities-only) state ─────────────────────────────
  const [editingSaleId, setEditingSaleId] = useState(null);
  const [editQuantities, setEditQuantities] = useState(null); // { sweetName: qty }
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [actionError, setActionError] = useState("");
  const [actionMsg, setActionMsg] = useState("");

  const title = saleType === "cash" ? "💵 Cash Sale Report" : "📱 Paytm Sale Report";

  // ── Load the sweets master list once, so sale_items can be labeled ──
  useEffect(() => {
    const loadSweets = async () => {
      try {
        const { data, error } = await sb.from("sweets").select("id,name");
        if (error) throw error;
        if (Array.isArray(data)) {
          const idToName = {};
          const toId = {};
          data.forEach((r) => {
            idToName[r.id] = r.name;
            toId[r.name] = r.id;
          });
          setSweetIdToName(idToName);
          setNameToSweetId(toId);
        }
      } catch (e) {
        console.error("Sweets lookup load error:", e);
      }
    };
    loadSweets();
  }, []);

  // ── Fetch sales + sale_items for the selected date ──────────────────
  useEffect(() => {
    const load = async () => {
      if (!selectedDate || Object.keys(sweetIdToName).length === 0) return;
      setLoading(true);
      setLoadError("");
      try {
        const filter =
          saleType === "cash"
            ? `sale_date=eq.${selectedDate}&sale_type=eq.cash&order=created_at.asc`
            : `sale_date=eq.${selectedDate}&sale_type=eq.upi&order=created_at.asc`;
        const { data: saleRows, error: saleErr } = await sb.from("sales").selectFilter("*", filter);
        if (saleErr) throw saleErr;

        const rows = Array.isArray(saleRows) ? saleRows : [];
        setSales(rows);

        if (rows.length === 0) {
          setItemsBySaleId({});
          setLoading(false);
          return;
        }

        const ids = rows.map((r) => r.id).join(",");
        const { data: itemRows, error: itemErr } = await sb.from("sale_items").selectFilter("*", `sale_id=in.(${ids})`);
        if (itemErr) throw itemErr;

        const grouped = {};
        (Array.isArray(itemRows) ? itemRows : []).forEach((it) => {
          if (!grouped[it.sale_id]) grouped[it.sale_id] = {};
          const name = sweetIdToName[it.sweet_id];
          if (!name) return;
          grouped[it.sale_id][name] = (grouped[it.sale_id][name] || 0) + (Number(it.quantity) || 0);
        });
        setItemsBySaleId(grouped);
      } catch (e) {
        console.error("Sale report load error:", e);
        setLoadError(e?.message || "Could not load sale report data.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [selectedDate, saleType, sweetIdToName, reloadKey]);

  const rows = useMemo(
    () =>
      sales.map((s) => ({
        id: s.id,
        time: s.created_at
          ? new Date(s.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
          : "—",
        channel: s.payment_method === "upi" ? "UPI" : s.payment_method === "paytm" ? "Paytm" : s.payment_method,
        sweetQtys: itemsBySaleId[s.id] || {},
        amount: Number(s.total_amount) || 0,
      })),
    [sales, itemsBySaleId]
  );

  const grandTotal = rows.reduce((t, r) => t + r.amount, 0);
  const sweetTotals = sweetOrder.reduce((acc, sw) => {
    acc[sw] = rows.reduce((t, r) => t + (r.sweetQtys?.[sw] || 0), 0);
    return acc;
  }, {});

  // Viewing any date is always allowed — only EDITING/DELETING is restricted
  // for accounts with dateLocked, and only when the report is showing a day
  // other than today (every row here belongs to selectedDate).
  const editingBlocked = dateLocked && selectedDate !== todayISO();

  // ── Correction helpers (quantities only — no name/date/delete changes) ──
  const openEdit = (saleId) => {
    setActionError("");
    setActionMsg("");
    const current = itemsBySaleId[saleId] || {};
    const q = {};
    sweetOrder.forEach((sw) => {
      q[sw] = current[sw] || 0;
    });
    setEditingSaleId(saleId);
    setEditQuantities(q);
  };

  const cancelEdit = () => {
    setEditingSaleId(null);
    setEditQuantities(null);
  };

  const updateQty = (sweet, value) =>
    setEditQuantities((q) => ({ ...q, [sweet]: Math.max(0, Number(value) || 0) }));

  const editTotal = editQuantities
    ? sweetOrder.reduce((t, sw) => t + (prices[sw] || 0) * (editQuantities[sw] || 0), 0)
    : 0;

  const saveEdit = async () => {
    if (!editingSaleId || !editQuantities) return;

    const validItems = sweetOrder.filter((sw) => editQuantities[sw] > 0);
    if (validItems.length === 0) {
      setActionError(
        "This form only corrects quantities — it can't save an entry with every item at 0. " +
        "Use the 🗑️ Delete button instead if this whole entry was a mistake."
      );
      return;
    }

    setSavingEdit(true);
    setActionError("");
    setActionMsg("");

    try {
      const newTotal = validItems.reduce((t, sw) => t + (prices[sw] || 0) * editQuantities[sw], 0);
      void newTotal; // computed for the UI's own display; the RPC recomputes it server-side and is authoritative

      const items = validItems.map((sw) => ({ sweet_id: nameToSweetId[sw], quantity: editQuantities[sw] }));
      const { error: rpcErr } = await sb.rpc("correct_cash_or_paytm_sale", { p_sale_id: editingSaleId, p_items: items });
      if (rpcErr) {
        if (/no longer exists/i.test(rpcErr.message || "")) {
          setActionError("This entry no longer exists — it looks like it was already deleted (possibly on another device). Refreshing the list…");
          setEditingSaleId(null);
          setEditQuantities(null);
          setReloadKey((k) => k + 1);
          return;
        }
        throw rpcErr;
      }

      setActionMsg("✅ Entry corrected successfully.");
      setEditingSaleId(null);
      setEditQuantities(null);
      setReloadKey((k) => k + 1);
      if (onCorrected) onCorrected(); // let the parent refresh Daily Report / Dashboard totals right away
    } catch (e) {
      console.error("Sale correction save error:", e);
      // Same race as the existence check above, just lost by a hair — the parent sales row vanished
      // between the check and this write (another device deleted it at almost the same moment).
      if (e?.message?.includes("sale_items_sale_id_fkey")) {
        setActionError("This entry was deleted (on another device) while you were correcting it. Refreshing the list…");
        setEditingSaleId(null);
        setEditQuantities(null);
        setReloadKey((k) => k + 1);
      } else {
        setActionError(`❌ Could not save correction (${e?.message || "unknown error"}).`);
      }
    } finally {
      setSavingEdit(false);
    }
  };

  // Zeroing out the only item on a sale via saveEdit above is deliberately refused ("keep at least
  // one item > 0") — that form only ever corrects quantities, it was never meant to also handle
  // removing an entry entirely. This gives that case a real path: delete the whole sale (and its
  // items), the same way the Credit reports already let you delete a mis-entered credit sale.
  const deleteSale = async (saleId) => {
    if (!window.confirm("Delete this sale entry? This cannot be undone.")) return;

    setDeletingId(saleId);
    setActionError("");
    setActionMsg("");

    try {
      const { error: rpcErr } = await sb.rpc("delete_sale_entry", { p_sale_id: saleId });
      if (rpcErr) throw rpcErr;

      setActionMsg("🗑️ Entry deleted.");
      if (editingSaleId === saleId) {
        setEditingSaleId(null);
        setEditQuantities(null);
      }
      setReloadKey((k) => k + 1);
      if (onCorrected) onCorrected();
    } catch (e) {
      console.error("Sale delete error:", e);
      setActionError(`❌ Could not delete this entry (${e?.message || "unknown error"}).`);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="credit-report">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          <p>
            Itemized {saleType === "cash" ? "cash" : "Paytm/UPI"} sale transactions for the selected date — correct a
            quantity if a sale was entered wrong.
          </p>
        </div>
      </header>

      <div className="credit-report-controls">
        <div className="credit-report-dates">
          <label>
            Date
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          </label>
        </div>
      </div>

      {loading && <p className="credit-report-status">Loading…</p>}
      {loadError && <p className="credit-report-status credit-report-error">⚠️ {loadError}</p>}
      {actionMsg && <p className="credit-report-status credit-report-success">{actionMsg}</p>}
      {actionError && <p className="credit-report-status credit-report-error">{actionError}</p>}

      {editingSaleId && editQuantities && (
        <div className="credit-report-edit-panel">
          <h3>✏️ Correct Entry #{editingSaleId}</h3>

          <h4>🍬 Sweet Items</h4>
          {sweetOrder.map((sw) => {
            const rate = prices[sw] || 0;
            const amount = rate * (editQuantities[sw] || 0);
            return (
              <div className="credit-report-edit-row" key={sw}>
                <span>{sw}</span>
                <input type="number" min="0" value={editQuantities[sw]} onChange={(e) => updateQty(sw, e.target.value)} />
                <span>Rate ₹{rate}</span>
                <span>Amount ₹{amount}</span>
              </div>
            );
          })}

          <h4>Corrected Total: ₹{editTotal}</h4>

          <div className="credit-report-edit-actions">
            <button type="button" className="credit-report-save-correction" onClick={saveEdit} disabled={savingEdit}>
              {savingEdit ? "Saving…" : "💾 Save Correction"}
            </button>
            <button type="button" onClick={cancelEdit} disabled={savingEdit}>Cancel</button>
          </div>
        </div>
      )}

      {!loading && !loadError && (
        <div className="credit-report-table-wrap">
          <table className="credit-report-table">
            <thead>
              <tr>
                <th>Time</th>
                {saleType !== "cash" && <th>Channel</th>}
                {sweetOrder.map((sw) => (
                  <th key={sw}>{sw} (₹{prices[sw]})</th>
                ))}
                <th>Total Amount</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={99} className="credit-report-empty">
                    No {saleType === "cash" ? "cash" : "Paytm/UPI"} sales found for this date.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.time}</td>
                  {saleType !== "cash" && <td>{r.channel}</td>}
                  {sweetOrder.map((sw) => (
                    <td key={sw}>{r.sweetQtys?.[sw] || 0}</td>
                  ))}
                  <td className="credit-report-amount">₹ {r.amount}</td>
                  <td className="credit-report-actions">
                    <button
                      type="button"
                      onClick={() => openEdit(r.id)}
                      disabled={editingBlocked}
                      title={editingBlocked ? "Your account can only edit today's entries — this date is view-only" : undefined}
                    >
                      ✏️ Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSale(r.id)}
                      disabled={deletingId === r.id || editingBlocked}
                      title={editingBlocked ? "Your account can only edit today's entries — this date is view-only" : undefined}
                    >
                      {deletingId === r.id ? "Deleting…" : "🗑️ Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={saleType !== "cash" ? 2 : 1}><strong>Total</strong></td>
                  {sweetOrder.map((sw) => (
                    <td key={sw}><strong>{sweetTotals[sw]}</strong></td>
                  ))}
                  <td className="credit-report-amount"><strong>₹ {grandTotal}</strong></td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

export default SaleReport;

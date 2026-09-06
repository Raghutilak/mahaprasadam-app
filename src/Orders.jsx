import { useEffect, useState } from "react";
import sb from "./supabaseClient";
import "./Orders.css";

// ── Order status lifecycle (mirrors the customer-facing MyOrders.jsx labels) ──
const STATUS_LABEL = { pending: "⏳ Pending", confirmed: "✅ Confirmed", fulfilled: "📦 Fulfilled", cancelled: "❌ Cancelled" };
const STATUS_FILTERS = ["all", "pending", "confirmed", "fulfilled", "cancelled"];

// Next-step actions offered for each status — keeps the buttons on every card
// limited to moves that actually make sense from where the order currently is.
const NEXT_ACTIONS = {
  pending: [{ status: "confirmed", label: "✅ Confirm" }, { status: "cancelled", label: "❌ Cancel" }],
  confirmed: [{ status: "fulfilled", label: "📦 Mark Fulfilled" }, { status: "cancelled", label: "❌ Cancel" }],
  fulfilled: [],
  cancelled: [{ status: "pending", label: "↩️ Reopen" }],
};

const fmtWhen = (iso) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("pending");
  const [updatingId, setUpdatingId] = useState(null);

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    // NOTE: this app's admin/staff side (src/App.jsx) talks to Supabase through the plain
    // publishable-key REST client `sb` — no logged-in session at all, unlike the customer
    // portal's `supabaseAuth` client. The customer-facing RLS policies on orders/order_items
    // are scoped to "the logged-in customer's own rows" (see src/supabaseAuthClient.js), so
    // for staff to see EVERY order here, the `orders` and `order_items` tables need an
    // additional RLS policy granting SELECT/UPDATE to the anon/publishable role — the same way
    // every other table this app reads (sales, donations, stock_receipts, ...) already does.
    // If this list stays empty despite orders existing, that policy is what's missing.
    const { data, error: err } = await sb
      .from("orders")
      .select("id,status,created_at,customer_email,customer_mobile,notes,order_items(quantity,sweets(name))");
    if (err) {
      console.error("Orders load error:", err);
      setError(err.message || "Could not load orders.");
      setOrders([]);
    } else {
      // Newest first — matches MyOrders.jsx's ordering for the same table.
      setOrders((data || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    }
    setLoading(false);
  };

  useEffect(() => { loadOrders(); }, []);

  const updateStatus = async (orderId, nextStatus) => {
    setUpdatingId(orderId);
    const { error: err } = await sb.from("orders").update({ status: nextStatus }, "id", orderId);
    if (err) {
      console.error("Order status update error:", err);
      alert(`Could not update order (${err.message || "unknown error"}).`);
    } else {
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: nextStatus } : o)));
    }
    setUpdatingId(null);
  };

  const visibleOrders = filter === "all" ? orders : orders.filter((o) => o.status === filter);
  const countFor = (status) => (status === "all" ? orders.length : orders.filter((o) => o.status === status).length);

  return (
    <div>
      <div className="orders-header">
        <div className="orders-header-title">
          <span className="icon">📦</span>
          <div>
            <h2>Book Orders</h2>
            <p>Orders placed by customers through the online Book Order portal</p>
          </div>
        </div>
        <button className="orders-refresh-btn" onClick={loadOrders} disabled={loading}>
          🔄 {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="orders-stats">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            className={`orders-stat-card ${filter === s ? "active" : ""}`}
            onClick={() => setFilter(s)}
          >
            <span className="orders-stat-count">{countFor(s)}</span>
            <span className="orders-stat-label">{s === "all" ? "All Orders" : STATUS_LABEL[s]}</span>
          </button>
        ))}
      </div>

      {loading && <div className="orders-loading">Loading orders...</div>}
      {!loading && error && <div className="orders-error">❌ {error}</div>}
      {!loading && !error && visibleOrders.length === 0 && (
        <div className="orders-empty">No {filter === "all" ? "" : filter} orders.</div>
      )}

      {!loading && !error && visibleOrders.length > 0 && (
        <div className="orders-list">
          {visibleOrders.map((o) => (
            <div className={`order-card status-${o.status}`} key={o.id}>
              <div className="order-card-top">
                <div className="order-card-customer">
                  <strong>{o.customer_email}</strong>
                  {o.customer_mobile && <span className="order-mobile">📱 {o.customer_mobile}</span>}
                  <div className="order-card-when">Booked {fmtWhen(o.created_at)}</div>
                </div>
                <span className={`order-status-badge status-${o.status}`}>{STATUS_LABEL[o.status] || o.status}</span>
              </div>

              <div className="order-card-items">
                {(o.order_items || []).length === 0 && <span className="order-item-chip">No items</span>}
                {(o.order_items || []).map((it, i) => (
                  <span className="order-item-chip" key={i}>
                    <span className="qty">{it.quantity}×</span>{it.sweets?.name || "Unknown"}
                  </span>
                ))}
              </div>

              {o.notes && <div className="order-card-notes">📝 {o.notes}</div>}

              <div className="order-card-actions">
                {(NEXT_ACTIONS[o.status] || []).length === 0 && <span className="order-card-no-actions">No further action needed</span>}
                {(NEXT_ACTIONS[o.status] || []).map((action) => (
                  <button
                    key={action.status}
                    className={`order-action-btn ${action.status === "cancelled" ? "discard" : "primary"}`}
                    disabled={updatingId === o.id}
                    onClick={() => updateStatus(o.id, action.status)}
                  >
                    {updatingId === o.id ? "..." : action.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

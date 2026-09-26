import { useEffect, useState } from "react";
import sb from "./supabaseClient";
import "./Orders.css";

// ── Mirrors Orders.jsx's status labels — same lifecycle, just no action
// buttons here since a staff member can view but not action their own order
// (accepting/cancelling is the "All Orders" tab's job). ──────────────────
const STATUS_LABEL = { pending: "⏳ Pending", confirmed: "✅ Confirmed", fulfilled: "📦 Fulfilled", cancelled: "❌ Cancelled" };

const fmtWhen = (iso) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

// currentStaff: the logged-in staff member — only THEIR own placed orders
// are shown (placed_by_staff_id = their id), enforced here and, more
// importantly, by RLS server-side (see the "staff read all orders" policy).
export default function StaffMyOrders({ currentStaff }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadOrders = async () => {
    if (!currentStaff?.id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await sb.from("orders").selectFilter(
      "id,status,created_at,department,requested_date,notes,carriers(name,mobile),order_items(quantity,sweets(name))",
      `placed_by_staff_id=eq.${currentStaff.id}&order=created_at.desc`
    );
    if (err) {
      console.error("My Orders load error:", err);
      setError(err.message || "Could not load your orders.");
      setOrders([]);
    } else {
      setOrders(data || []);
    }
    setLoading(false);
  };

  useEffect(() => { loadOrders(); }, [currentStaff?.id]);

  return (
    <div>
      <div className="orders-header">
        <div className="orders-header-title">
          <span className="icon">🧾</span>
          <div>
            <h2>My Orders</h2>
            <p>Orders you've placed through Book an Order — including future-dated ones not yet due.</p>
          </div>
        </div>
        <button className="orders-refresh-btn" onClick={loadOrders} disabled={loading}>
          🔄 {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {loading && <div className="orders-loading">Loading your orders...</div>}
      {!loading && error && <div className="orders-error">❌ {error}</div>}
      {!loading && !error && orders.length === 0 && (
        <div className="orders-empty">You haven't placed any orders yet.</div>
      )}

      {!loading && !error && orders.length > 0 && (
        <div className="orders-list">
          {orders.map((o) => (
            <div className={`order-card status-${o.status}`} key={o.id}>
              <div className="order-card-top">
                <div className="order-card-customer">
                  <strong>{o.department ? `🏢 ${o.department}` : "—"}</strong>
                  {o.requested_date && <span className="order-mobile">📅 For {o.requested_date}</span>}
                  {o.carriers?.name && <span className="order-mobile">🚚 {o.carriers.name}{o.carriers.mobile ? ` (${o.carriers.mobile})` : ""}</span>}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

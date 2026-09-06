import { useEffect, useState } from "react";
import { supabaseAuth } from "../supabaseAuthClient";

const STATUS_LABEL = { pending: "⏳ Pending", confirmed: "✅ Confirmed", fulfilled: "📦 Fulfilled", cancelled: "❌ Cancelled" };

export default function MyOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      // RLS already restricts this to the logged-in customer's own rows.
      const { data, error } = await supabaseAuth
        .from("orders")
        .select("id,status,created_at,order_items(quantity,sweets(name))")
        .order("created_at", { ascending: false });
      if (error) console.error("My orders load error:", error);
      setOrders(data || []);
      setLoading(false);
    };
    load();
  }, []);

  if (loading) return <p>Loading your orders...</p>;

  return (
    <div className="batch-card">
      <h2>Your Orders</h2>
      {orders.length === 0 && <p>You haven't booked any orders yet.</p>}
      {orders.map((o) => (
        <div className="item-row" key={o.id}>
          <div className="item-name">
            <strong>{STATUS_LABEL[o.status] || o.status}</strong>
            <span>
              {(o.order_items || []).map((it) => `${it.quantity} ${it.sweets?.name || ""}`).join(", ")}
              {" · "}
              {new Date(o.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
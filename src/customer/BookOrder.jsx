import { useEffect, useState } from "react";
import { supabaseAuth } from "../supabaseAuthClient";

// `customer` is { email, mobile } for a logged-in account, or the guest's typed-in
// details for a guest checkout. `isGuest` controls whether the email field is
// editable (guests have no account email to lock it to) and whether we show the
// "orders aren't tracked" note.
export default function BookOrder({ customer, isGuest }) {
  const [stock, setStock] = useState([]); // [{ sweet_id, sweet_name, available }]
  const [quantities, setQuantities] = useState({});
  const [email, setEmail] = useState(customer?.email || "");
  const [mobile, setMobile] = useState(customer?.mobile || "");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { ok, message }

  useEffect(() => {
    const loadStock = async () => {
      setLoading(true);
      // get_public_available_stock() only returns names, not ids — fetch sweets separately (name+id,
      // no price/other accounting fields) so quantities can be posted back by sweet_id.
      const [{ data: stockRows, error: stockErr }, { data: sweetRows, error: sweetErr }] = await Promise.all([
        supabaseAuth.rpc("get_public_available_stock"),
        supabaseAuth.from("sweets").select("id,name"),
      ]);
      if (stockErr || sweetErr) {
        console.error("Stock load error:", stockErr || sweetErr);
        setLoading(false);
        return;
      }
      const idByName = Object.fromEntries((sweetRows || []).map((s) => [s.name, s.id]));
      setStock((stockRows || []).map((r) => ({ sweet_id: idByName[r.sweet_name], sweet_name: r.sweet_name, available: +r.available || 0 })));
      setLoading(false);
    };
    loadStock();
  }, []);

  const setQty = (sweetId, value, max) => {
    let qty = Math.max(0, Number(value) || 0);
    if (qty > max) qty = max;
    setQuantities((q) => ({ ...q, [sweetId]: qty }));
  };

  const handleSubmit = async () => {
    const items = Object.entries(quantities)
      .filter(([, qty]) => qty > 0)
      .map(([sweet_id, quantity]) => ({ sweet_id, quantity }));

    if (items.length === 0) { setResult({ ok: false, message: "Please choose a quantity for at least one item." }); return; }
    if (isGuest && !email.trim()) { setResult({ ok: false, message: "Please enter your email address." }); return; }
    if (!mobile.trim()) { setResult({ ok: false, message: "Please enter a mobile number so we can reach you." }); return; }

    setSubmitting(true);
    setResult(null);
    try {
      // Works the same way whether it came from a logged-in account or a guest — the RPC
      // takes the email/mobile straight from the form, it doesn't need an auth session for
      // that. (For a guest with no session, the `orders`/`order_items` tables' RLS still
      // needs to permit an anonymous insert here, same note as the admin Orders page.)
      const { error } = await supabaseAuth.rpc("create_customer_order", {
        p_order: { customer_email: email.trim(), customer_mobile: mobile.trim(), notes: null },
        p_items: items,
      });
      if (error) throw error;
      setResult({
        ok: true,
        message: isGuest
          ? "✅ Order booked! We'll email or call you shortly with the amount to pay and pickup/delivery details. (Guest orders aren't listed under \"My Orders\" — keep an eye on your email or phone.)"
          : "✅ Order booked! We'll email or call you shortly with the amount to pay and pickup/delivery details.",
      });
      setQuantities({});
    } catch (e) {
      console.error("Order booking error:", e);
      setResult({ ok: false, message: `❌ Could not book this order (${e.message || "unknown error"}). Please try again.` });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <p>Loading available stock...</p>;

  return (
    <div className="batch-card">
      <h2>Available Sweets</h2>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        Choose quantities and book your order. No payment is collected here — we'll contact you with how much to pay and how/where to collect it.
      </p>

      {stock.map((item) => (
        <div className="item-row" key={item.sweet_id}>
          <div className="item-name">
            <strong>{item.sweet_name}</strong>
            <span>Available: {item.available}</span>
          </div>
          <input
            type="number" min="0" max={item.available} style={{ width: 70 }}
            value={quantities[item.sweet_id] || ""}
            disabled={item.available === 0}
            onChange={(e) => setQty(item.sweet_id, e.target.value, item.available)}
          />
        </div>
      ))}

      {isGuest && (
        <div className="item-row">
          <div className="item-name">
            <strong>Your Email</strong>
            <span>So we can send order updates</span>
          </div>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email Address" />
        </div>
      )}

      <div className="item-row">
        <div className="item-name">
          <strong>Your Mobile Number</strong>
          <span>So we can reach you about payment and delivery</span>
        </div>
        <input type="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="Mobile Number" />
      </div>

      {result && <p style={{ color: result.ok ? "lightgreen" : "salmon" }}>{result.message}</p>}

      <button className="save-sale-button" onClick={handleSubmit} disabled={submitting}>
        {submitting ? "Booking..." : "📦 Book Order"}
      </button>
    </div>
  );
}

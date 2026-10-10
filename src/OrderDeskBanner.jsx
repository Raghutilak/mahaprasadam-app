import { useEffect, useRef } from "react";
import { startCounterWatch, holdStaff, releaseStaff, dismissPlaced, useOrderDesk } from "./orderDesk";

// Short beep so the counter notices a new booking even when not looking at the screen.
// (Browsers only allow sound after the person has clicked somewhere on the page once.)
const beep = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    setTimeout(() => ctx.close(), 400);
  } catch { /* sound is optional */ }
};

// Floating panel for counter staff and admin. Shows who is booking an order right now,
// lets the counter put one on HOLD (their Book Order button is blocked) and release it again.
export default function OrderDeskBanner({ currentStaff, onOpenOrders }) {
  const desk = useOrderDesk();
  const seenBookers = useRef(new Set());
  const seenPlaced = useRef(new Set());

  useEffect(() => startCounterWatch(currentStaff?.name), [currentStaff?.name]);

  // Everyone booking right now, except the person looking at this screen.
  const bookers = desk.bookers.filter((b) => String(b.staffId) !== String(currentStaff?.id));
  const holds = desk.holds;
  const isHeld = (id) => holds.some((h) => String(h.staffId) === String(id));
  const heldNotBooking = holds.filter((h) => !bookers.some((b) => String(b.staffId) === String(h.staffId)));
  const placed = desk.placed.filter((p) => String(p.staffId) !== String(currentStaff?.id));

  // Beep when a new person opens the form, or an order is placed.
  useEffect(() => {
    let fresh = false;
    bookers.forEach((b) => { if (!seenBookers.current.has(b.key)) { seenBookers.current.add(b.key); fresh = true; } });
    const live = new Set(bookers.map((b) => b.key));
    seenBookers.current.forEach((k) => { if (!live.has(k)) seenBookers.current.delete(k); });
    placed.forEach((p) => { if (!seenPlaced.current.has(p.id)) { seenPlaced.current.add(p.id); fresh = true; } });
    if (fresh) beep();
  }, [bookers, placed]);

  // "Order placed" notices clear themselves after 30 seconds.
  useEffect(() => {
    if (placed.length === 0) return undefined;
    const timers = placed.map((p) => setTimeout(() => dismissPlaced(p.id), 30000));
    return () => timers.forEach(clearTimeout);
  }, [placed.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (bookers.length === 0 && heldNotBooking.length === 0 && placed.length === 0) return null;

  const box = {
    position: "fixed", top: 12, right: 12, zIndex: 2000,
    width: "min(92vw, 360px)", display: "flex", flexDirection: "column", gap: 8,
  };
  const card = (border) => ({
    background: "var(--surface)", border: `2px solid ${border}`, borderRadius: 10,
    padding: "10px 12px", boxShadow: "0 6px 18px rgba(0,0,0,0.45)", color: "var(--ivory)", fontSize: 14,
  });
  const btn = (bg) => ({
    border: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer",
    fontWeight: 700, background: bg, color: "#1a0a00", marginTop: 8,
  });

  return (
    <div style={box} role="status" aria-live="polite">
      {placed.map((p) => (
        <div key={p.id} style={card("var(--green)")}>
          ✅ <strong>New order placed</strong> by {p.name}{p.department ? ` (${p.department})` : ""}
          <div style={{ display: "flex", gap: 8 }}>
            {onOpenOrders && <button type="button" style={btn("var(--gold)")} onClick={() => { onOpenOrders(); dismissPlaced(p.id); }}>View orders</button>}
            <button type="button" style={btn("var(--muted)")} onClick={() => dismissPlaced(p.id)}>Dismiss</button>
          </div>
        </div>
      ))}

      {bookers.map((b) => (
        <div key={b.key} style={card(isHeld(b.staffId) ? "var(--red)" : "var(--gold)")}>
          {isHeld(b.staffId) ? "⛔" : "✍️"} <strong>{b.name}</strong>{b.department ? ` (${b.department})` : ""}{" "}
          {isHeld(b.staffId) ? "— booking is ON HOLD" : "is booking an order…"}
          <div>
            {isHeld(b.staffId) ? (
              <button type="button" style={btn("var(--green)")} onClick={() => releaseStaff(b.staffId)}>✅ Release</button>
            ) : (
              <button type="button" style={btn("var(--red)")} onClick={() => holdStaff(b)}>⛔ Hold — not enough stock</button>
            )}
          </div>
        </div>
      ))}

      {heldNotBooking.map((h) => (
        <div key={`held-${h.staffId}`} style={card("var(--red)")}>
          ⛔ <strong>{h.name}</strong>{h.department ? ` (${h.department})` : ""} is on hold
          {h.mine ? (
            <div><button type="button" style={btn("var(--green)")} onClick={() => releaseStaff(h.staffId)}>✅ Release</button></div>
          ) : (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>Held by {h.by || "another counter"}</div>
          )}
        </div>
      ))}
    </div>
  );
}

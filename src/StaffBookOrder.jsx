import { useEffect, useMemo, useState, useRef } from "react";
import sb from "./supabaseClient";
import { departments } from "./DepartmentCredit";
import { getBusinessDate, addBusinessDays } from "./dateUtils";
import { startBookingWatch, setMyBooking, announcePlaced, useOrderDesk, isOnHold, getDeptLock } from "./orderDesk";

const FUTURE_DAY_CAP = 10;

const tomorrowISO = () => addBusinessDays(1);
const todayISO = getBusinessDate;

// currentStaff: the logged-in staff member (for a department-restricted
// account, department is pre-set and locked — see lockedDepartment below).
export default function StaffBookOrder({ currentStaff }) {
  const lockedDepartment = currentStaff?.restrictToDepartment || "";

  const [department, setDepartment] = useState(lockedDepartment || "");
  const [dayChoice, setDayChoice] = useState("today"); // "today" | "future"
  const [futureDate, setFutureDate] = useState(tomorrowISO());

  const [sweets, setSweets] = useState([]); // [{id, name}]
  const [availableByName, setAvailableByName] = useState({}); // today's live stock, by sweet name
  const [loadingStock, setLoadingStock] = useState(true);

  const [carriers, setCarriers] = useState([]); // [{id, name, mobile}]
  const [carrierId, setCarrierId] = useState("");
  const [newCarrierName, setNewCarrierName] = useState("");
  const [newCarrierMobile, setNewCarrierMobile] = useState("");
  const [addingNewCarrier, setAddingNewCarrier] = useState(false);

  const [activeOrderCount, setActiveOrderCount] = useState(null); // null = not loaded yet
  const ACTIVE_ORDER_CAP = 2;

  const [quantities, setQuantities] = useState({}); // { [sweet_id]: qty }
  const [specialMessage, setSpecialMessage] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { ok, message }

  const desk = useOrderDesk();
  const onHold = isOnHold(desk, currentStaff?.id);
  const [bookingActive, setBookingActive] = useState(true);
  const skipActivateRef = useRef(false);

  const lock = getDeptLock(desk, department, bookingActive);
  const lockedOut = lock.status === "blocked" || lock.status === "checking";
  const IDLE_MINUTES = 5;
  const [idleReleased, setIdleReleased] = useState(false);
  const lastActivityRef = useRef(Date.now());
  const idleReleasedRef = useRef(false);

  useEffect(() => startBookingWatch(), []);

  useEffect(() => {
    const touch = () => {
      lastActivityRef.current = Date.now();
      if (idleReleasedRef.current) {
        idleReleasedRef.current = false;
        setIdleReleased(false);
        setBookingActive(true);
      }
    };
    const events = ["pointerdown", "keydown", "input"];
    events.forEach((e) => window.addEventListener(e, touch, true));
    const timer = setInterval(() => {
      if (!idleReleasedRef.current && Date.now() - lastActivityRef.current > IDLE_MINUTES * 60 * 1000) {
        idleReleasedRef.current = true;
        setIdleReleased(true);
        setBookingActive(false);
      }
    }, 15000);
    return () => { events.forEach((e) => window.removeEventListener(e, touch, true)); clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!currentStaff?.id) return;
    setMyBooking(bookingActive ? { staffId: currentStaff.id, name: currentStaff.name, department } : null);
  }, [bookingActive, department, currentStaff?.id, currentStaff?.name]);

  const refreshActiveOrderCount = async () => {
    if (!currentStaff?.id) return;
    try {
      const { data, error } = await sb.from("orders").selectFilter(
        "id",
        `status=in.(pending,confirmed)&placed_by_staff_id=eq.${currentStaff.id}`
      );
      if (error) throw error;
      setActiveOrderCount(Array.isArray(data) ? data.length : 0);
    } catch (e) {
      console.error("Active order count load error:", e);
      setActiveOrderCount(0); // fail open on the client — the RPC still enforces the real cap server-side
    }
  };

  useEffect(() => {
    const load = async () => {
      setLoadingStock(true);
      try {
        const [{ data: sweetRows, error: sweetErr }, { data: stockRows, error: stockErr }, { data: carrierRows, error: carrierErr }] = await Promise.all([
          sb.from("sweets").select("id,name"),
          sb.rpc("get_public_available_stock"),
          sb.from("carriers").select("id,name,mobile"),
        ]);
        if (sweetErr) throw sweetErr;
        setSweets(Array.isArray(sweetRows) ? sweetRows : []);
        if (!stockErr && Array.isArray(stockRows)) {
          const map = {};
          stockRows.forEach((r) => { map[r.sweet_name] = Number(r.available) || 0; });
          setAvailableByName(map);
        }
        if (!carrierErr && Array.isArray(carrierRows)) {
          setCarriers(carrierRows.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")));
        }
      } catch (e) {
        console.error("Book Order stock load error:", e);
      } finally {
        setLoadingStock(false);
      }
    };
    load();
    refreshActiveOrderCount();
  }, []);

  const isFuture = dayChoice === "future";
  const capFor = (sweetName) => (isFuture ? FUTURE_DAY_CAP : (availableByName[sweetName] ?? 0));

  const setQty = (sweetId, sweetName, value) => {
    let qty = Math.max(0, Number(value) || 0);
    const max = capFor(sweetName);
    if (qty > max) qty = max;
    setQuantities((q) => ({ ...q, [sweetId]: qty }));
  };

  const itemsToSubmit = useMemo(
    () => Object.entries(quantities).filter(([, qty]) => qty > 0).map(([sweet_id, quantity]) => ({ sweet_id, quantity })),
    [quantities]
  );

  const atCap = activeOrderCount !== null && activeOrderCount >= ACTIVE_ORDER_CAP;

  // Get-or-create a carrier by name (case-insensitive) — same pattern
  // Department Credit already uses for its own Carrier field.
  const resolveCarrierId = async () => {
    if (carrierId) return carrierId;
    const name = newCarrierName.trim();
    if (!name) return null;
    const { data: existing } = await sb.from("carriers").selectIlike("id,name", "name", name);
    if (Array.isArray(existing) && existing.length > 0) return existing[0].id;
    const { data: created, error } = await sb.from("carriers").insert({ name, mobile: newCarrierMobile.trim() || null });
    if (error) throw error;
    return created?.[0]?.id || null;
  };

  useEffect(() => {
    if (skipActivateRef.current) { skipActivateRef.current = false; return; }
    setBookingActive(true);
  }, [quantities, specialMessage, department, carrierId, dayChoice, futureDate]);

  const handleSubmit = async () => {
    setResult(null);

    if (lock.status === "blocked") { setResult({ ok: false, message: `⛔ ${lock.owner?.name || "Someone"} is already placing an order for ${department}. Please wait until they finish.` }); return; }
    if (lock.status === "checking" || lock.status === "idle") { setResult({ ok: false, message: "Please wait a moment and press Book Order again." }); return; }

    if (onHold) { setResult({ ok: false, message: "⛔ The counter has put your booking on hold (not enough stock right now). Please check with the counter." }); return; }
    if (atCap) { setResult({ ok: false, message: `You already have ${ACTIVE_ORDER_CAP} active orders — wait for one to be fulfilled or cancelled first.` }); return; }
    if (!department) { setResult({ ok: false, message: "Please choose a department." }); return; }
    if (itemsToSubmit.length === 0) { setResult({ ok: false, message: "Choose a quantity for at least one item." }); return; }

    setSubmitting(true);
    try {
      const resolvedCarrierId = await resolveCarrierId();
      const { error } = await sb.rpc("create_staff_order", {
        p_department: department,
        p_requested_date: isFuture ? futureDate : todayISO(),
        p_items: itemsToSubmit,
        p_notes: specialMessage.trim() || null,
        p_carrier_id: resolvedCarrierId,
      });
      if (error) throw error;
      setResult({ ok: true, message: `✅ Order booked for ${isFuture ? futureDate : "today"}.` });
      announcePlaced({ staffId: currentStaff?.id, name: currentStaff?.name, department });
      skipActivateRef.current = true;
      setBookingActive(false);
      setQuantities({});
      setSpecialMessage("");
      setCarrierId("");
      setNewCarrierName("");
      setNewCarrierMobile("");
      setAddingNewCarrier(false);
      refreshActiveOrderCount();
    } catch (e) {
      console.error("Staff order booking error:", e);
      setResult({ ok: false, message: `❌ Could not book this order (${e.message || "unknown error"}).` });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="batch-card">
      <h2>📦 Place a New Order</h2>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        Book for today (capped by what's actually available right now) or a future day (capped at {FUTURE_DAY_CAP} per item —
        use the message box below for anything more than that, or any other request).
      </p>

      {lock.status === "blocked" && (
        <p style={{ fontSize: 14, color: "salmon", fontWeight: 700 }}>
          ⛔ {lock.owner?.name} is already placing an order for {department}. You can look, but you can't book until they finish, close this page or go idle.
        </p>
      )}
      {lock.others.length > 0 && (
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          👥 Also open for {department}: {lock.others.map((o) => `${o.name}${lock.owner && o.key === lock.owner.key ? " (placing now)" : ""}`).join(", ")}
        </p>
      )}
      {idleReleased && (
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          💤 Paused after {IDLE_MINUTES} minutes without activity so others in your department can book. Click anywhere to continue.
        </p>
      )}

      {onHold && (
        <p style={{ fontSize: 14, color: "salmon", fontWeight: 700 }}>
          ⛔ The counter has put your booking on hold because there isn't enough stock right now. You can't book until they release it.
        </p>
      )}

      {activeOrderCount !== null && (
        <p style={{ fontSize: 13, color: atCap ? "salmon" : "var(--muted)" }}>
          {atCap
            ? `⚠️ You have ${activeOrderCount}/${ACTIVE_ORDER_CAP} active orders — you can't place another until one is fulfilled or cancelled.`
            : `You have ${activeOrderCount}/${ACTIVE_ORDER_CAP} active orders.`}
        </p>
      )}

      <div className="item-row">
        <div className="item-name"><strong>Department</strong></div>
        {lockedDepartment ? (
          <input className="dept-restricted-input" value={lockedDepartment} disabled title="Your account is restricted to this department" />
        ) : (
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">Select department</option>
            {departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}
      </div>

      <div className="item-row">
        <div className="item-name">
          <strong>Carrier</strong>
          <span>Whoever will collect this order — their confirmed order details can be shared straight to their phone.</span>
        </div>
        {!addingNewCarrier ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
              <option value="">Select carrier (optional)</option>
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.mobile ? ` — ${c.mobile}` : ""}</option>
              ))}
            </select>
            <button type="button" className="adjust-btn-ghost" onClick={() => { setAddingNewCarrier(true); setCarrierId(""); }}>
              + New Carrier
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input placeholder="Carrier name" value={newCarrierName} onChange={(e) => setNewCarrierName(e.target.value)} />
            <input placeholder="Mobile number" value={newCarrierMobile} onChange={(e) => setNewCarrierMobile(e.target.value)} />
            <button type="button" className="adjust-btn-ghost" onClick={() => { setAddingNewCarrier(false); setNewCarrierName(""); setNewCarrierMobile(""); }}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="item-row">
        <div className="item-name"><strong>Order For</strong></div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={!isFuture} onChange={() => setDayChoice("today")} /> Today
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" checked={isFuture} onChange={() => setDayChoice("future")} /> Future Day
          </label>
          {isFuture && (
            <input type="date" min={tomorrowISO()} value={futureDate} onChange={(e) => setFutureDate(e.target.value)} />
          )}
        </div>
      </div>

      {loadingStock ? (
        <p>Loading available stock…</p>
      ) : (
        sweets.map((s) => (
          <div className="item-row" key={s.id}>
            <div className="item-name">
              <strong>{s.name}</strong>
              <span>{isFuture ? `Max ${FUTURE_DAY_CAP} (future-dated order)` : `Available today: ${availableByName[s.name] ?? 0}`}</span>
            </div>
            <input
              type="number" min="0" max={capFor(s.name)} style={{ width: 70 }}
              value={quantities[s.id] || ""}
              disabled={capFor(s.name) === 0 || lockedOut}
              onChange={(e) => setQty(s.id, s.name, e.target.value)}
            />
          </div>
        ))
      )}

      <div className="item-row">
        <div className="item-name">
          <strong>Special Message</strong>
          <span>Need more than the cap above, or have some other request/feedback? Say so here.</span>
        </div>
        <textarea
          rows={3}
          style={{ width: "100%" }}
          value={specialMessage}
          onChange={(e) => setSpecialMessage(e.target.value)}
          placeholder="e.g. Need 150 Peda for a function on this date, please advise."
        />
      </div>

      {result && <p style={{ color: result.ok ? "lightgreen" : "salmon" }}>{result.message}</p>}

      <button className="save-sale-button" onClick={handleSubmit} disabled={submitting || loadingStock || atCap || onHold}>
        {submitting ? "Booking…" : "📦 Book Order"}
      </button>
    </section>
  );
}

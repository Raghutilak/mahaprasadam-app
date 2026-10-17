import { useCallback, useEffect, useRef, useState } from "react";
import sb from "./supabaseClient";
import "./AlternateScreens.css";
import { SweetPhoto, AutoScroll, SWEET_DISPLAY_ORDER, todayISO, addDaysISO, formatDateForDisplay } from "./AlternateScreens";

// ══════════════════════════════════════════════════════════════════
// Kitchen Display — full-screen display for the Deity kitchen.
// Rotates between Today's and Tomorrow's Minimum Sweets Requirement.
// Kept separate from Alternate Screens (the shop TV) on purpose, with
// its own permission ("Kitchen Display") in Manage Passwords.
// ══════════════════════════════════════════════════════════════════

// ── Screens 5 & 6 — Minimum Sweets Requirement (today / tomorrow) ───────
// Minimum sweets that must be ready for a given day =
//   (a) the sweets issued to that day's Bhoga donors, plus
//   (b) the sweets on that day's orders (requested_date = that day).
//
// (c) the fixed daily Temple order (see DAILY_TEMPLE_SWEETS below), counted under Orders.
// (a) mirrors public.auto_bhoga_credit_schedule in Supabase (the "items"
// column that process_auto_bhoga_credits uses). If you change the sweets
// per Bhoga there, change them here too. Udayastama = all six Bhogas.
const BHOGA_SWEETS = {
  "Balya Bhoga":     { "Peda": 2, "Sandesh": 3, "Rasagulla": 3, "Rasamalai": 3 },
  "Sakalika Bhoga":  { "Peda": 2, "Sandesh": 3 },
  "Raja Bhoga":      { "Peda": 2, "Sandesh": 3, "Rasagulla": 3, "Rasamalai": 3, "Sweet Samosa": 3 },
  "Vaikalika Bhoga": { "Peda": 2, "Sandesh": 3 },
  "Sandhya Bhoga":   { "Peda": 2, "Sandesh": 3 },
  "Shayana Bhoga":   { "Peda": 2, "Sandesh": 3 },
};
const SIX_BHOGAS = Object.keys(BHOGA_SWEETS);

// Fixed daily Temple credit (Vraja Sundari Mataji) — mirrors the
// 'Temple — Vraja Sundari Mataji' row in auto_department_credit_daily.
// Counted every day, today and tomorrow alike.
const DAILY_TEMPLE_SWEETS = { "Peda": 2, "Sandesh": 2, "Rasagulla": 1, "Rasamalai": 1 };

// Orders that still need sweets made: everything except cancelled.
const COUNTED_ORDER_STATUSES = "pending,confirmed,fulfilled";

const sortSweetNames = (a, b) => {
  const ia = SWEET_DISPLAY_ORDER.indexOf(a);
  const ib = SWEET_DISPLAY_ORDER.indexOf(b);
  if (ia === -1 && ib === -1) return a.localeCompare(b);
  if (ia === -1) return 1;
  if (ib === -1) return -1;
  return ia - ib;
};

// Returns { rows: [{ name, bhoga, orders, total }], donorCount, orderCount }
const loadSweetRequirement = async (dateISO) => {
  const [donRes, ordRes] = await Promise.all([
    sb.from("donations").selectFilter("id,bhoge_type", `bhoge_date=eq.${dateISO}`),
    sb.from("orders").selectFilter(
      "id,order_items(quantity,sweets(name))",
      `requested_date=eq.${dateISO}&status=in.(${COUNTED_ORDER_STATUSES})`
    ),
  ]);
  if (donRes.error) throw donRes.error;
  if (ordRes.error) throw ordRes.error;

  const byName = {}; // name -> { bhoga, orders }
  const bump = (name, field, qty) => {
    if (!name || !qty) return;
    if (!byName[name]) byName[name] = { donors: 0, orders: 0 };
    byName[name][field] += qty;
  };

  Object.entries(DAILY_TEMPLE_SWEETS).forEach(([name, qty]) => bump(name, "orders", qty)); // fixed daily order from the Temple department
  (donRes.data || []).forEach((d) => {
    const types = d.bhoge_type === "Udayastama" ? SIX_BHOGAS : [d.bhoge_type];
    types.forEach((t) => {
      Object.entries(BHOGA_SWEETS[t] || {}).forEach(([name, qty]) => bump(name, "donors", qty));
    });
  });
  (ordRes.data || []).forEach((o) => {
    (o.order_items || []).forEach((it) => bump(it.sweets?.name, "orders", Number(it.quantity) || 0));
  });

  const rows = Object.entries(byName)
    .map(([name, v]) => ({ name, ...v, total: v.donors + v.orders }))
    .sort((a, b) => sortSweetNames(a.name, b.name));
  return { rows, donorCount: (donRes.data || []).length, orderCount: (ordRes.data || []).length };
};

function RequirementScreen({ day }) {
  const [state, setState] = useState(null); // null = loading, { error } or data
  const dateISO = day === "tomorrow" ? addDaysISO(todayISO(), 1) : todayISO();
  const heading = day === "tomorrow" ? "🍬 Tomorrow's Minimum Sweets Requirement" : "🍬 Today's Minimum Sweets Requirement";

  useEffect(() => {
    let cancelled = false;
    loadSweetRequirement(dateISO)
      .then((r) => { if (!cancelled) setState(r); })
      .catch((e) => {
        console.error("Alternate Screens — sweet requirement load error:", e);
        if (!cancelled) setState({ error: true });
      });
    return () => { cancelled = true; };
  }, [dateISO]);

  return (
    <div className="alt-screen alt-screen-requirement">
      <h1 className="alt-screen-title">{heading}</h1>
      <div className="alt-festival-date">{formatDateForDisplay(dateISO)}</div>
      {state === null && <p className="alt-screen-loading">Loading...</p>}
      {state?.error && <p className="alt-screen-loading">Could not load the requirement right now.</p>}
      {state && !state.error && state.rows.length === 0 && (
        <p className="alt-screen-loading">No Bhoga donors or orders for this day yet.</p>
      )}
      {state && !state.error && state.rows.length > 0 && (
        <>
          <div className="alt-req-grid">
            {state.rows.map((r) => (
              <div className="alt-req-card" key={r.name}>
                <SweetPhoto name={r.name} />
                <div className="alt-sweet-name">{r.name}</div>
                <div className="alt-req-total">{r.total}</div>
                <div className="alt-req-breakdown">
                  {[r.donors > 0 && `🙏 Donors ${r.donors}`, r.orders > 0 && `📦 Orders ${r.orders}`].filter(Boolean).join(" · ")}
                </div>
              </div>
            ))}
          </div>
          <div className="alt-donors-total">
            {state.donorCount} Bhoga donation{state.donorCount === 1 ? "" : "s"} · {state.orderCount} order{state.orderCount === 1 ? "" : "s"}
          </div>
        </>
      )}
    </div>
  );
}

const KITCHEN_SCREENS = [
  { key: "req-today", render: () => <RequirementScreen day="today" /> },
  { key: "req-tomorrow", render: () => <RequirementScreen day="tomorrow" /> },
];

export default function KitchenScreens() {
  const [running, setRunning] = useState(false);
  const [screenIndex, setScreenIndex] = useState(0);
  const [intervalMinutes, setIntervalMinutes] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);

  const containerRef = useRef(null);
  const rotationTimerRef = useRef(null);
  const hideControlsTimerRef = useRef(null);

  const restartRotationTimer = useCallback((minutes) => {
    if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
    rotationTimerRef.current = setInterval(() => {
      setScreenIndex((i) => (i + 1) % KITCHEN_SCREENS.length);
    }, minutes * 60 * 1000);
  }, []);

  const start = async () => {
    setScreenIndex(0);
    setRunning(true);
    restartRotationTimer(intervalMinutes);
    try {
      if (containerRef.current?.requestFullscreen) await containerRef.current.requestFullscreen();
    } catch (e) {
      console.error("Kitchen Display — fullscreen request failed:", e);
    }
  };

  const stop = () => {
    setRunning(false);
    if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && running) stop();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => () => { if (rotationTimerRef.current) clearInterval(rotationTimerRef.current); }, []);

  const adjustMinutes = (delta) => {
    setIntervalMinutes((m) => {
      const next = Math.max(1, m + delta);
      if (running) restartRotationTimer(next);
      return next;
    });
  };

  const showControlsBriefly = () => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  };

  useEffect(() => {
    if (!running) return undefined;
    showControlsBriefly();
    return () => { if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  if (!running) {
    return (
      <div className="alt-setup">
        <h2>🍳 Kitchen Display</h2>
        <p>
          A full-screen display for the Deity kitchen — alternates between Today's and Tomorrow's Minimum Sweets
          Requirement (Bhoga donors + orders + the daily Temple order), refreshing every time it switches.
        </p>
        <label className="alt-setup-interval">
          Switch every
          <button type="button" onClick={() => adjustMinutes(-1)}>−</button>
          <strong>{intervalMinutes} min</strong>
          <button type="button" onClick={() => adjustMinutes(1)}>+</button>
        </label>
        <button className="alt-setup-start" onClick={start}>▶ Start Full-Screen Display</button>
        <p className="alt-setup-hint">
          Once running, move the mouse or tap the screen to bring up Exit and speed controls.
        </p>
      </div>
    );
  }

  return (
    <div className="alt-fullscreen-root" ref={containerRef} onMouseMove={showControlsBriefly} onTouchStart={showControlsBriefly}>
      <AutoScroll key={KITCHEN_SCREENS[screenIndex]?.key}>
        {KITCHEN_SCREENS[screenIndex]?.render()}
      </AutoScroll>
      <div className={`alt-controls ${controlsVisible ? "visible" : ""}`}>
        <button onClick={() => adjustMinutes(-1)}>−1 min</button>
        <span className="alt-controls-interval">{intervalMinutes} min</span>
        <button onClick={() => adjustMinutes(1)}>+1 min</button>
        <button onClick={() => setScreenIndex((i) => (i + 1) % KITCHEN_SCREENS.length)}>⏭ Next</button>
        <button className="alt-controls-exit" onClick={stop}>✖ Exit</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// orderDesk.js
// Live "someone is booking an order" alerts for the counter, plus a
// one-click HOLD that stops a staff member's booking.
//
// Built on Supabase Realtime (Presence + Broadcast) — nothing is saved in
// the database, so there is nothing to clean up. Two small channels:
//
//   order-desk-bookers  staff who have the Book an Order form open
//                       (their name + department) — shown to the counter.
//                       Also carries a "placed" message when an order is booked.
//   order-desk-holds    the counter's list of staff currently ON HOLD —
//                       the staff member's form listens and blocks Book Order.
//
// NOTE: a hold lives only while the counter's browser tab stays open and
// connected. It is an app-level block (see the note given with this file).
// ══════════════════════════════════════════════════════════════════
import { useSyncExternalStore } from "react";
import { supabaseStaffAuth } from "./supabaseStaffAuthClient";

const BOOKERS_TOPIC = "order-desk-bookers";
const HOLDS_TOPIC = "order-desk-holds";

// Unique per browser tab; used as the presence key.
export const MY_KEY = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let snapshot = { bookers: [], holds: [], placed: [] };
const listeners = new Set();
const emit = (patch) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
};

let bookersCh = null;
let holdsCh = null;
let bookersReady = false;
let holdsReady = false;
let users = 0;        // how many parts of the app are using the channels
let counterUsers = 0; // how many of them are the counter view

let myBooking = null; // { staffId, name, department, since } while the form is open
let myHolds = [];     // [{ staffId, name, department }] — people the counter has put on hold
let counterName = "";

const flatten = (state) => {
  const out = [];
  Object.entries(state || {}).forEach(([key, metas]) => {
    (metas || []).forEach((m) => out.push({ key, ...m }));
  });
  return out;
};

const syncBookerTrack = () => {
  if (!bookersCh || !bookersReady) return;
  if (myBooking) bookersCh.track(myBooking);
  else bookersCh.untrack();
};

const syncHoldsTrack = () => {
  if (!holdsCh || !holdsReady) return;
  if (counterUsers > 0) holdsCh.track({ holds: myHolds, by: counterName });
  else holdsCh.untrack();
};

const connect = () => {
  if (bookersCh) return;

  bookersCh = supabaseStaffAuth.channel(BOOKERS_TOPIC, { config: { presence: { key: MY_KEY } } });
  bookersCh.on("presence", { event: "sync" }, () => {
    emit({ bookers: flatten(bookersCh.presenceState()).filter((m) => m.staffId != null) });
  });
  bookersCh.on("broadcast", { event: "placed" }, ({ payload }) => {
    if (!payload) return;
    const entry = { ...payload, id: `${payload.staffId}-${payload.at}` };
    emit({ placed: [...snapshot.placed.filter((p) => p.id !== entry.id), entry] });
  });
  bookersCh.subscribe((status) => {
    if (status === "SUBSCRIBED") { bookersReady = true; syncBookerTrack(); }
  });

  holdsCh = supabaseStaffAuth.channel(HOLDS_TOPIC, { config: { presence: { key: MY_KEY } } });
  holdsCh.on("presence", { event: "sync" }, () => {
    const list = [];
    flatten(holdsCh.presenceState()).forEach((m) => {
      (m.holds || []).forEach((h) => list.push({ ...h, by: m.by, mine: m.key === MY_KEY }));
    });
    emit({ holds: list });
  });
  holdsCh.subscribe((status) => {
    if (status === "SUBSCRIBED") { holdsReady = true; syncHoldsTrack(); }
  });
};

const disconnect = () => {
  if (bookersCh) supabaseStaffAuth.removeChannel(bookersCh);
  if (holdsCh) supabaseStaffAuth.removeChannel(holdsCh);
  bookersCh = null; holdsCh = null;
  bookersReady = false; holdsReady = false;
  emit({ bookers: [], holds: [], placed: [] });
};

const acquire = () => {
  users += 1;
  connect();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users <= 0) { users = 0; disconnect(); }
  };
};

// ── Counter side ─────────────────────────────────────────────────
// Call from an effect; returns a cleanup function.
export const startCounterWatch = (name) => {
  counterUsers += 1;
  counterName = name || "Counter";
  const release = acquire();
  syncHoldsTrack();
  return () => {
    counterUsers = Math.max(0, counterUsers - 1);
    if (counterUsers === 0) myHolds = [];
    syncHoldsTrack();
    release();
  };
};

export const holdStaff = (target) => {
  if (!target || target.staffId == null) return;
  if (myHolds.some((h) => String(h.staffId) === String(target.staffId))) return;
  myHolds = [...myHolds, { staffId: target.staffId, name: target.name, department: target.department }];
  syncHoldsTrack();
};

export const releaseStaff = (staffId) => {
  myHolds = myHolds.filter((h) => String(h.staffId) !== String(staffId));
  syncHoldsTrack();
};

export const dismissPlaced = (id) => emit({ placed: snapshot.placed.filter((p) => p.id !== id) });

// ── Booking-form side ────────────────────────────────────────────
// Call from an effect when the Book an Order form opens; returns a cleanup.
export const startBookingWatch = () => {
  const release = acquire();
  return () => {
    myBooking = null;
    syncBookerTrack();
    release();
  };
};

// Pass the booking info while the staff member is filling the form, or null when idle.
export const setMyBooking = (info) => {
  myBooking = info ? { ...info, since: info.since || Date.now() } : null;
  syncBookerTrack();
};

export const announcePlaced = (info) => {
  if (!bookersCh || !bookersReady) return;
  bookersCh.send({ type: "broadcast", event: "placed", payload: { ...info, at: Date.now() } });
};

// ── React hook ───────────────────────────────────────────────────
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const getSnapshot = () => snapshot;
export const useOrderDesk = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

// True when the counter has put this staff member on hold.
export const isOnHold = (desk, staffId) =>
  staffId != null && desk.holds.some((h) => String(h.staffId) === String(staffId));

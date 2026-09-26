// ══════════════════════════════════════════════════════════════════
// staffAccess.js
// Single source of truth for "which sidebar tab is which permission
// key". App.jsx checks currentStaff.allowedTabs.includes(TAB.xxx)
// before showing a nav button or rendering a page — everything else
// (login, the Manage/My Password screen) reads from here too, so the
// list of tabs never drifts out of sync between the login table and
// the sidebar.
// ══════════════════════════════════════════════════════════════════

export const TABS = {
  DASHBOARD: "dashboard",
  RECEIVE: "receive",
  CASH: "cash",
  PAYTM: "paytm",
  CREDIT: "credit",           // also covers the "individual-credit" sub-page
  PAYMENT: "payment",         // Credit Recovery
  DONATIONS: "donations",
  ORDERS: "orders",           // All Orders — the admin/manage view (accept, cancel, fulfil)
  REPORTS: "reports",
  CLOSE: "close",             // Close Day
  RESET_DONATION: "reset_donation",
  RESET_OTHER: "reset_other",
  EXPORT: "export",           // Export to Google Sheet button
  PLACE_ORDER: "place-order", // Book an Order — the booking form itself
  MY_ORDERS: "my-orders",     // a staff member's own order history
  ALTERNATE_SCREENS: "alternate_screens", // full-screen rotating display (Sweets / Donors / Festival)
};

// Every real tab, in sidebar order — used for the "Admin" role and for
// the tab-picker checkboxes when adding/editing a staff member.
//
// NOTE: ORDERS ("All Orders") is now an individually-granted permission like
// any other tab — it shows every order across every department and lets
// whoever holds it accept/cancel/fulfil them, so it's deliberately NOT handed
// out to everyone the way it used to be. Today that's admin + Suraj Pal only
// (set per-person in Manage Passwords, not hardcoded here). PLACE_ORDER and
// MY_ORDERS are intentionally left OUT of this list — see canAccess() below.
export const ALL_TABS = [
  { key: TABS.DASHBOARD, label: "📊 Dashboard" },
  { key: TABS.RECEIVE, label: "📦 Receive" },
  { key: TABS.CASH, label: "💵 Cash Sale" },
  { key: TABS.PAYTM, label: "📱 Paytm Sale" },
  { key: TABS.CREDIT, label: "📋 Credit Sale" },
  { key: TABS.PAYMENT, label: "💰 Credit Recovery" },
  { key: TABS.DONATIONS, label: "🙏 Donations" },
  { key: TABS.ORDERS, label: "📋 All Orders" },
  { key: TABS.REPORTS, label: "📄 Reports" },
  { key: TABS.CLOSE, label: "🔒 Close Day" },
  { key: TABS.RESET_DONATION, label: "🧹 Reset Donation Data" },
  { key: TABS.RESET_OTHER, label: "🧹 Reset Other Data" },
  { key: TABS.EXPORT, label: "📊 Export to Google Sheet" },
  { key: TABS.ALTERNATE_SCREENS, label: "🖥️ Alternate Screens" },
];

export const ALL_TAB_KEYS = ALL_TABS.map((t) => t.key);

// "My Password" / "Manage Passwords" is deliberately NOT in ALL_TABS / gated
// by allowed_tabs — every logged-in staff member can always reach it (to
// change their own password), regardless of what else they're allowed to see.
//
// Policy: "Book an Order" (placing an order) and "My Orders" (a staff
// member's own order history) work the same way — every staff member,
// including a department-restricted account holder, can always reach both,
// no matter their role or individually-granted tabs. Only "All Orders" (the
// cross-department manage/accept/cancel view) is gated normally.
export const canAccess = (currentStaff, tabKey) => {
  if (!currentStaff) return false;
  if (tabKey === TABS.PLACE_ORDER || tabKey === TABS.MY_ORDERS) return true;
  return Array.isArray(currentStaff.allowedTabs) && currentStaff.allowedTabs.includes(tabKey);
};

// Tabs pre-checked when adding a brand-new staff member in "Manage Passwords".
// ORDERS is no longer pre-checked — it's a specifically-granted permission now
// (see the ALL_TABS note above), not a default every new staff member gets.
export const DEFAULT_NEW_STAFF_TABS = [TABS.DASHBOARD];

// Maps a Supabase staff_users row (snake_case) to the shape the rest of the
// app uses (camelCase), and to a safe default if a column is missing/null.
// Note: no password field — staff_users holds profile data only now,
// passwords live exclusively in Supabase Auth (see supabaseStaffAuthClient.js).
export const normalizeStaffRow = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email || "",
  mobile: row.mobile || "",
  role: row.role === "admin" ? "admin" : "staff",
  allowedTabs: Array.isArray(row.allowed_tabs) ? row.allowed_tabs : [],
  restrictReportsToToday: !!row.restrict_reports_to_today, // VIEWING any date is always allowed; this only blocks editing/deleting entries on a date other than today (see SaleReport/CreditReport)
  restrictToDepartment: row.restrict_to_department || null, // null = no restriction (sees/books every department); a department NAME = locked to only that one, enforced server-side too (see 2026_09_16_staff_department_restriction.sql)
});

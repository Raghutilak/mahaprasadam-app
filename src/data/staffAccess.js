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
  ORDERS: "orders",           // Book Orders
  REPORTS: "reports",
  CLOSE: "close",             // Close Day
  RESET_DONATION: "reset_donation",
  RESET_OTHER: "reset_other",
  EXPORT: "export",           // Export to Google Sheet button
};

// Every real tab, in sidebar order — used for the "Admin" role and for
// the tab-picker checkboxes when adding/editing a staff member.
export const ALL_TABS = [
  { key: TABS.DASHBOARD, label: "📊 Dashboard" },
  { key: TABS.RECEIVE, label: "📦 Receive" },
  { key: TABS.CASH, label: "💵 Cash Sale" },
  { key: TABS.PAYTM, label: "📱 Paytm Sale" },
  { key: TABS.CREDIT, label: "📋 Credit Sale" },
  { key: TABS.PAYMENT, label: "💰 Credit Recovery" },
  { key: TABS.DONATIONS, label: "🙏 Donations" },
  { key: TABS.ORDERS, label: "📦 Book Orders" },
  { key: TABS.REPORTS, label: "📄 Reports" },
  { key: TABS.CLOSE, label: "🔒 Close Day" },
  { key: TABS.RESET_DONATION, label: "🧹 Reset Donation Data" },
  { key: TABS.RESET_OTHER, label: "🧹 Reset Other Data" },
  { key: TABS.EXPORT, label: "📊 Export to Google Sheet" },
];

export const ALL_TAB_KEYS = ALL_TABS.map((t) => t.key);

// "My Password" / "Manage Passwords" is deliberately NOT in ALL_TABS / gated
// by allowed_tabs — every logged-in staff member can always reach it (to
// change their own password), regardless of what else they're allowed to see.

// Policy: Book Order is accessible to every staff member, no matter their
// role or individually-granted tabs — so access checks for ORDERS always
// pass once someone is logged in as staff, and the "add staff" form below
// pre-checks it by default (it can still be seen, just not un-granted, by
// the tab list a staff row happens to store).
export const canAccess = (currentStaff, tabKey) => {
  if (!currentStaff) return false;
  if (tabKey === TABS.ORDERS) return true;
  return Array.isArray(currentStaff.allowedTabs) && currentStaff.allowedTabs.includes(tabKey);
};

// Tabs pre-checked when adding a brand-new staff member in "Manage Passwords".
export const DEFAULT_NEW_STAFF_TABS = [TABS.DASHBOARD, TABS.ORDERS];

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
  restrictReportsToToday: !!row.restrict_reports_to_today,
});

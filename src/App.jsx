import { supabaseAuth } from "./supabaseAuthClient";
import CustomerPortal from "./customer/CustomerPortal";
import { useEffect, useRef, useState } from "react";
import { accountHolders, carriers } from "./data/people";
import DailyReport from "./DailyReport";
import "./index.css";
import DepartmentCredit from "./DepartmentCredit";
import IndividualCredit from "./IndividualCredit";
import CreditReport from "./CreditReport";
import SaleReport from "./SaleReport";
import Donations from "./Donations";
import Orders from "./Orders";
import AdminLogin from "./AdminLogin";
import sb from "./supabaseClient";
import { exportToGoogleSheet } from './lib/googleSheetExport';

function usePersistentState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try { const saved = localStorage.getItem(key); return saved ? JSON.parse(saved) : initialValue; }
    catch { return initialValue; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(value)); }, [key, value]);
  return [value, setValue];
}

const prices = {Peda: 15,Sandesh: 15,Rasagulla: 25,Rasamalai: 25,"Sweet Samosa": 150,Cake: 60,Ladoo: 60,};

const initialSchedule = [
  { time: "4:25 AM", received: false, items: { Peda: 27, Sandesh: 27, Rasagulla: 16, Rasamalai: 16, }, },
  { time: "8:20 AM", received: false, items: { Peda: 6, Sandesh: 18, }, },
  { time: "12:20 PM", received: false, items: { Peda: 6, Sandesh: 18, "Sweet Samosa": 30, }, },
  { time: "4:10 PM", received: false, items: { Peda: 5, Sandesh: 15, Cake: 24, Ladoo: 0, }, },
  { time: "6:50 PM", received: false, items: { Peda: 6, Sandesh: 18, Cake: 0, Ladoo: 0, }, },
  { time: "8:20 PM", received: false, items: { Peda: 5, Sandesh: 15, Cake: 0, Ladoo: 0, }, },
];

const createEmptyItems = () => ({Peda: 0, Sandesh: 0, Rasagulla: 0, Rasamalai: 0, "Sweet Samosa": 0, Cake: 0, Ladoo: 0, });

// Shifts an ISO date string ("YYYY-MM-DD") by N days (negative to go backward), returning an ISO
// string. Done entirely in UTC (Date.UTC / setUTCDate / toISOString, which is always UTC) so it's
// not affected by the browser's local timezone — building this from `new Date(dateStr + "T00:00:00")`
// instead would parse as LOCAL midnight, and for any positive-UTC-offset timezone (e.g. India,
// UTC+5:30) that silently rolls back to the previous UTC calendar day before any shift is applied.
const shiftDateISO = (dateStr, days) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

// Maps the raw payment_method stored in Supabase (credit_payments.payment_method) to the same
// display labels used throughout the Recovery UI ("Cash" / "Paytm" / "T.R."). Shared by the
// Supabase-sourced "Today's Recoveries" fetch below.
const paymentMethodModeLabel = (m) => (m === "cash" ? "Cash" : m === "paytm" ? "Paytm" : m === "tr" ? "T.R." : "Other");

const payers = [ ...new Map( [...accountHolders, ...carriers].map((person) => [ person.name, person ]) ).values() ];

function App() {  

  // const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", });
  // const todayISO = new Date().toISOString().slice(0, 10);

  const now = new Date();
  const today = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata", });
  const todayISO = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata", });
 
  
  const [selectedDate, setSelectedDate] = useState(todayISO);
  const [page, setPage] = useState("dashboard");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [touchStartX, setTouchStartX] = useState(null);
  const [exporting, setExporting] = useState(false);

  const handleGoogleSheetExport =
    async () => {
      try {
        setExporting(true);
        const today = new Date() .toISOString() .split('T')[0];
        const result = await exportToGoogleSheet( today, today );
        console.log("Google Sheet export result:", result);
        alert(
          `Google Sheet export completed!\n\n` +
          `Transactions: ${result.transactionRows ?? result.transactions ?? 0}\n` +
          `Recoveries: ${result.recoveryRows ?? result.recoveries ?? 0}`
        );
      } catch (error) {
        console.error( 'Google Sheet export error:', error );
        alert( 'Export failed: ' + error.message );
      } finally {
        setExporting(false);
      }
    };

  // ── Today's Bhoga donations, for the Dashboard summary ──────────
  const [todaysBhogaDonations, setTodaysBhogaDonations] = useState([]);

  // ── sweets master table: id per sweet name, seeded once from the
  //    fixed price list, then reused for every sale/inventory write ──
  const [sweetIdByName, setSweetIdByName] = usePersistentState("sweet-sweet-ids", {});
  // A plain boolean, stable in identity, standing in for "is sweetIdByName populated yet". Several effects below
  // used to depend on `sweetIdByName` itself (an object) just to know when it first goes from empty to populated.
  // The problem: every one of those effects ALSO re-runs whenever anything ELSE it touches changes — and at least
  // one of them (the schedule auto-receive effect below) writes back to its own other dependency on every attempt,
  // success or failure. An object dependency that's incidentally recreated by a state update inside the very effect
  // that depends on it turns "re-run when sweets resolve" into "re-run forever, as fast as the network round-trip
  // allows", which is exactly what produced the continuous Dashboard flicker — `schedule` (and anything derived
  // from it, like the Dashboard's Received Stock total) was being toggled true/false dozens of times a second.
  // `sweetsReady` only ever flips false → true, once, so effects gated on it settle down immediately after sweets load.
  const [sweetsReady, setSweetsReady] = useState(() => Object.keys(sweetIdByName).length > 0);
  
  useEffect(() => {
    const loadSweets = async () => {
      try {
        const { data: rows, error } = await sb.from("sweets").select("*");
        if (error) {
          console.error("Sweets load error:", error);
          return; // keep whatever was already cached locally
        }
        if (!rows) return;

        if (rows.length > 0) {
          const map = {}; rows.forEach((r) => { map[r.name] = r.id; }); setSweetIdByName(map); setSweetsReady(true); return;
        }

        // Table is empty — seed it once from the fixed price list
        const seedRows = Object.entries(prices).map(([name, price]) => ({ name, price, unit: "pc" }));
        const { data: created, error: insertError } = await sb.from("sweets").insert(seedRows);
        if (insertError) {
          console.error("Sweets seed error:", insertError);
          return;
        }
        if (Array.isArray(created)) {
          const map = {};
          created.forEach((r) => { map[r.name] = r.id; });
          setSweetIdByName(map);
          setSweetsReady(true);
        }
      } catch (e) {
        console.error("Sweets sync error:", e);
        // keep whatever was already cached locally
      }
    };
    loadSweets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Verify every sweet in an {itemName: qty} object has a resolved Supabase id BEFORE attempting to save — never silently filter a
  // missing one out, since that leaves a sale header with no items.
  const assertAllSweetIdsResolved = (itemsObj) => {
    const missing = Object.keys(itemsObj).filter((name) => (itemsObj[name] || 0) > 0 && !sweetIdByName[name]);
    if (missing.length > 0) {
      throw new Error(`Sweet mapping not yet loaded for: ${missing.join(", ")}. Please wait a moment and try again.`);
    }
  };

  // ── Cross-device consistency ─────────────────────────────────────
  // Stock/totals/dues used to be purely local, additive numbers — a sale made on one device was invisible to another until that other device
  // happened to reset. These refresh functions pull the REAL numbers from Supabase (via aggregation RPCs) and overwrite local state, so
  // every device converges to the same figures whenever a page loads or right after a save completes.

  const refreshDailyStockAndTotals = async () => {
    // const now = new Date();
    // const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    console.log("DAILY REPORT selectedDate:", selectedDate);

    const reportDate = selectedDate;
    try {
      const { data: stockRows, error: stockError } = await sb.rpc("get_daily_sold_stock", { p_date: reportDate });
      if (stockError) {
        console.error("Daily stock summary error:", stockError);
      } else if (Array.isArray(stockRows)) {
        const newCashStock = createEmptyItems(); const newPaytmStock = createEmptyItems(); const newDeptStock = createEmptyItems(); 
        const newIndivStock = createEmptyItems();
        stockRows.forEach((r) => {
          const target =
            r.sale_type === "cash" ? newCashStock :
            r.sale_type === "upi" ? newPaytmStock :
            r.sale_type === "department_credit" ? newDeptStock :
            r.sale_type === "individual_credit" ? newIndivStock : null;
          if (target && r.sweet_name in target) target[r.sweet_name] = +r.total_qty || 0;
        });
        setCashSoldStock(newCashStock); setPaytmSoldStock(newPaytmStock);
        setDepartmentCreditStock(newDeptStock); setIndividualCreditStock(newIndivStock);
      }

      const { data: totalRows, error: totalError } = await sb.rpc("get_daily_sale_totals", { p_date: reportDate });
      
      
      if (totalError) {
        console.error("Daily sale totals error:", totalError);
      } else if (Array.isArray(totalRows)) {
        const cash = totalRows.find((r) => r.sale_type === "cash"); const upi = totalRows.find((r) => r.sale_type === "upi");
        setCashTotal(+cash?.total || 0); setPaytmTotal(+upi?.total || 0);
      }

      // Credit sale totals used to be read ONLY from this device's local creditRecords/individualCreditRecords arrays
      // (never refreshed from Supabase) — so the Dashboard's Credit Sales card could go stale or show ₹0 for a real
      // sale the moment localStorage was cleared, or simply on a different device than the one the sale was made on.
      // Queried straight from the `sales` table (same approach the Department/Individual Credit pages already use for
      // their own totals) rather than assuming get_daily_sale_totals aggregates these sale_types too.
      try {
        const { data: creditRows, error: creditError } = await sb.from("sales").selectFilter(
          "sale_type,total_amount",
          `sale_date=eq.${reportDate}&sale_type=in.(department_credit,individual_credit)`
        );

        console.log("DAILY REPORT totalRows:", JSON.stringify(totalRows, null, 2));
        console.log("DAILY REPORT totalError:", totalError);

        if (creditError) {
          console.error("Daily credit totals error:", creditError);
        } else if (Array.isArray(creditRows)) {
          const deptTotal = creditRows.filter((r) => r.sale_type === "department_credit").reduce((t, r) => t + (Number(r.total_amount) || 0), 0);
          const indivTotal = creditRows.filter((r) => r.sale_type === "individual_credit").reduce((t, r) => t + (Number(r.total_amount) || 0), 0);
          setDepartmentCreditTotal(deptTotal);
          setIndividualCreditTotal(indivTotal);
        }
      } catch (e) {
        console.error("Daily credit totals error:", e);
      }

      // Stock adjustments — same cross-device treatment as everything else.
      const { data: adjRows, error: adjError } = await sb.rpc("get_daily_stock_adjustments", { p_date: reportDate });
      if (adjError) {
        console.error("Daily stock adjustments error:", adjError);
      } else if (Array.isArray(adjRows)) {
        const newEffects = createEmptyItems();
        adjRows.forEach((r) => {
          if (r.sweet_name in newEffects) newEffects[r.sweet_name] = +r.net_qty || 0;
        });
        setAdjustmentEffects(newEffects);
      }


      // Today's opening stock — read from Supabase so a device that wasn't present for the previous day's Close Day still gets the right baseline. 
      const { data: sweetRows, error: sweetRowsError } = await sb.from("sweets").select("id,name,price");

      if (sweetRowsError) {
        console.error("Opening stock sweets lookup error:", sweetRowsError);
      }
      const sweetById = Object.fromEntries(
        (sweetRows || []).map((s) => [s.id, s])
      );
      const applyOpeningStockRows = (rows) => {
        const updated = createEmptyItems();
        let value = 0;

        rows.forEach((r) => {
          const sweet = sweetById[r.sweet_id];
          if (!sweet) { console.warn( "Opening stock sweet ID not found in sweets table:", r.sweet_id ); return; }
          const quantity = Number(r.quantity) || 0;
          const price = Number(sweet.price) || 0;
          updated[sweet.name] = quantity;
          value += quantity * price;
        });

        console.log("Opening stock:", updated);
        console.log("Opening stock value:", value);
        setOpeningStock(updated);
        setOpeningStockValue(value);
      };
   
      const { data: openingRows, error: openingError } = await sb.from("inventory_openings").selectEq("*", "stock_date", reportDate);
      if (openingError) {
        console.error("Opening stock load error:", openingError);
      } else if (Array.isArray(openingRows) && openingRows.length > 0) {
        applyOpeningStockRows(openingRows);
      } else {
        // No inventory_openings row exists for this exact date — most likely a date just outside
        // the range covered by data so far (e.g. the day right before or after a single
        // bulk-imported day, before the app has been used continuously). Rather than showing a
        // flat, misleading 0 for Opening Stock, fall back to the nearest date that DOES have a
        // recorded snapshot: prefer the previous day's closing stock (the textbook "yesterday's
        // closing = today's opening" chain); if that's also missing, fall back to the NEXT day's
        // own opening stock as a rough stand-in. Every other figure on this page (received,
        // issued, sales, recoveries) is left at 0 regardless — there's genuinely no transaction
        // record for a date like this, only the opening-stock baseline is being inferred.
        try {
          const { data: prevClosingRows } = await sb.from("inventory_closings").selectEq("*", "stock_date", shiftDateISO(reportDate, -1));
          if (Array.isArray(prevClosingRows) && prevClosingRows.length > 0) {
            applyOpeningStockRows(prevClosingRows);
          } else {
            const { data: nextOpeningRows } = await sb.from("inventory_openings").selectEq("*", "stock_date", shiftDateISO(reportDate, 1));
            if (Array.isArray(nextOpeningRows) && nextOpeningRows.length > 0) {
              applyOpeningStockRows(nextOpeningRows);
            } else {
              setOpeningStock(createEmptyItems());
              setOpeningStockValue(0);
            }
          }
        } catch (e) {
          console.error("Opening stock fallback load error:", e);
          setOpeningStock(createEmptyItems());
          setOpeningStockValue(0);
        }
      }

      // Stock RECEIVED value for the selected date — used by the Reports > Daily Report page.
      // Deliberately separate from `receivedTotal` above (which is derived from today's live
      // receiving `schedule` and can only ever represent "today"). Any other date — including
      // bulk-imported historical stock receipts — has no `schedule`, so it must be read straight
      // from Supabase's stock_receipts/stock_receipt_items instead.
      //
      // Must dedupe by `notes` the same way refreshScheduleReceivedStatus does above: a batch
      // whose save fires twice (the race condition markReceivedInFlightRef guards against) can
      // leave two stock_receipts rows tagged with the same "Scheduled batch — {time}" note. The
      // schedule-based receivedTotal only ever sums one receipt per batch, so summing every row
      // here unconditionally double-counted those batches instead of matching the dashboard.
      try {
        const { data: receiptRows, error: receiptErr } = await sb.from("stock_receipts").selectEq("id,notes", "receipt_date", reportDate);
        if (receiptErr) {
          console.error("Report received-stock load error:", receiptErr);
          setReportReceivedStockValue(0);
        } else if (Array.isArray(receiptRows) && receiptRows.length > 0) {
          const idByNote = new Map();
          receiptRows.forEach((r) => {
            // Fall back to the row's own id as the dedup key when there's no note (e.g. manual
            // "Add Receipt" entries, or imported rows), so those still count individually.
            idByNote.set(r.notes || `__id_${r.id}`, r.id);
          });
          const receiptIds = [...idByNote.values()];
          const { data: itemRows, error: itemErr } = await sb
            .from("stock_receipt_items")
            .selectFilter("quantity,rate", `receipt_id=in.(${receiptIds.join(",")})`);
          if (itemErr) {
            console.error("Report received-stock items load error:", itemErr);
            setReportReceivedStockValue(0);
          } else if (Array.isArray(itemRows)) {
            setReportReceivedStockValue(itemRows.reduce((t, r) => t + (Number(r.quantity) || 0) * (Number(r.rate) || 0), 0));
          }
        } else {
          setReportReceivedStockValue(0);
        }
      } catch (e) {
        console.error("Report received-stock load error:", e);
      }

      // Recovery totals (Department vs Individual, split by Cash/Paytm/T.R.) for the selected
      // date — used by the Reports > Daily Report page, AND (since `selectedDate` is always
      // today's date on every page except Reports — see navigateTo() below) by the Dashboard's
      // and Credit Recovery page's "today" recovery cards too. Sourced straight from
      // credit_payments so it reflects recoveries recorded on ANY device, or inserted directly
      // into Supabase (e.g. by an import script), instead of only this device's in-memory
      // departmentPayments array (which only ever holds recoveries saved through THIS browser's
      // own Credit Recovery form, and is cleared on Close Day).
      try {
        const { data: paymentRows, error: paymentErr } = await sb.from("credit_payments").selectEq("*", "payment_date", reportDate);
        if (paymentErr) {
          console.error("Report recovery totals load error:", paymentErr);
        } else if (Array.isArray(paymentRows)) {
          const modeLabel = (m) => (m === "cash" ? "Cash" : m === "paytm" ? "Paytm" : m === "tr" ? "T.R." : "Other");
          const dept = { Cash: 0, Paytm: 0, "T.R.": 0 };
          const indiv = { Cash: 0, Paytm: 0, "T.R.": 0 };
          paymentRows.forEach((p) => {
            const label = modeLabel(p.payment_method);
            const bucket = p.department_id ? dept : indiv;
            bucket[label] = (bucket[label] || 0) + (Number(p.amount) || 0);
          });
          setReportDepartmentRecovery(dept);
          setReportIndividualRecovery(indiv);
        }
      } catch (e) {
        console.error("Report recovery totals load error:", e);
      }
    } catch (e) {
      console.error("refreshDailyStockAndTotals error:", e);
    }
  };

  const refreshDues = async () => {
    try {
      const { data: deptRows, error: deptError } = await sb.rpc("get_department_dues");
      if (deptError) {
        console.error("Department dues load error:", deptError);
      } else if (Array.isArray(deptRows)) {
        const map = {};
        deptRows.forEach((r) => { map[r.department_name] = +r.due || 0; }); setDepartmentDues(map);
      }

      const { data: acctRows, error: acctError } = await sb.rpc("get_account_holder_dues");
      if (acctError) {
        console.error("Account holder dues load error:", acctError);
      } else if (Array.isArray(acctRows)) {
        const map = {};
        acctRows.forEach((r) => { map[r.account_holder_name] = +r.due || 0; }); setIndividualDues(map);
      }
    } catch (e) {
      console.error("refreshDues error:", e);
    }
  };

  // Refresh on every page change — cheap enough for this app's traffic, and guarantees whichever page you land on shows real, current numbers
  // rather than whatever this device happened to accumulate locally.
  
  useEffect(() => {
    refreshDailyStockAndTotals();
    refreshDues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, selectedDate, sweetsReady]);


  // Insert one `sales` header row + its `sale_items` rows into Supabase,
  // atomically via RPC — never a header with no items.
  const saveSaleToSupabase = async (saleType, paymentMethod, itemsObj, total) => {
    const now = new Date();
    const saleDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    try {
      assertAllSweetIdsResolved(itemsObj);

      const itemRows = Object.entries(itemsObj)
        .filter(([, qty]) => qty > 0)
        .map(([name, qty]) => ({ sweet_id: sweetIdByName[name], quantity: qty, rate: prices[name] || 0, total_amount: qty * (prices[name] || 0), }));
      const { data: saleId, error } = await sb.rpc("create_sale_with_items", {
        p_sale: {
          sale_date: saleDate, sale_type: saleType, payment_method: paymentMethod, subtotal: total, 
          discount: 0, total_amount: total, amount_paid: total, balance_amount: 0,
        },
        p_items: itemRows,
      });
      if (error) throw error; if (!saleId) throw new Error("No sale id returned");
      return { ok: true };
    } catch (e) {
      console.error("Sale save error:", e);
      return { ok: false, error: e };
    }
  };

  // ── Recent Transactions, sourced from Supabase (so the same feed shows on every device, not just this browser's local cache) ─────────────
  const [cloudRecentTransactions, setCloudRecentTransactions] = useState([]);

  useEffect(() => {
    if (page !== "dashboard") return;

    const loadRecentTransactions = async () => {
      const now = new Date();
      const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const formatted = [];

      try {
        const { data: salesRows, error: salesError } = await sb.from("sales").selectEq("*", "sale_date", localToday);
        if (salesError) {
          console.error("Recent sales load error:", salesError);
        } else if (salesRows) {
          salesRows.forEach((s) => {
            const label =
              s.sale_type === "cash" ? "💵 Cash Sale" :
              s.sale_type === "upi" ? (s.payment_method === "paytm" ? "📱 Paytm Sale" : "📲 UPI Sale") :
              s.sale_type === "department_credit" ? "🏢 Department Credit" :
              s.sale_type === "individual_credit" ? "👤 Individual Credit" : s.sale_type;
            formatted.push({ id: `sale-${s.id}`, type: label, amount: +s.total_amount || 0, timestamp: s.created_at });
          });
        }

        const { data: paymentRows, error: paymentsError } = await sb.from("credit_payments").selectEq("*", "payment_date", localToday);
        if (paymentsError) {
          console.error("Recent recovery payments load error:", paymentsError);
        } else if (paymentRows) {
          paymentRows.forEach((p) => {
            formatted.push({ id: `payment-${p.id}`, type: `💰 Recovery — ${p.payment_method}`, amount: +p.amount || 0, timestamp: p.created_at });
          });
        }
      } catch (e) {
        console.error("Recent transactions load error:", e);
      }
      setCloudRecentTransactions(formatted);
    };
    loadRecentTransactions();
  }, [page]);

  // ── Today's Recoveries, sourced from Supabase ─────────────────────────────────────────────────
  // Fixes the same class of bug as cloudRecentTransactions above, but for the Credit Recovery
  // page's "Today's Recoveries" list AND the Dept/Individual Cash/Paytm/T.R. Recovery cards on
  // both the Dashboard and Credit Recovery page: those used to be computed PURELY from
  // `departmentPayments`, a per-browser localStorage array that only ever grows when a recovery
  // is saved through THIS device's own Credit Recovery form. A recovery entered on another
  // device, or inserted directly into Supabase (e.g. by the legacy-sheet import script), never
  // touched that array, so it never showed up here — even though it was correctly reducing dues
  // (get_department_dues / get_account_holder_dues) and correctly appearing in Recent
  // Transactions the whole time, since those two ARE Supabase-sourced.
  //
  // department/account_holder names are pulled in via PostgREST relation embedding
  // (`departments(name)` / `account_holders(name)`), which Supabase resolves automatically from
  // the credit_payments.department_id / account_holder_id foreign keys.
  const [cloudRecoveriesToday, setCloudRecoveriesToday] = useState([]);

  useEffect(() => {
    if (page !== "dashboard" && page !== "payment") return;

    const loadTodaysRecoveries = async () => {
      const now = new Date();
      const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      try {
        const { data: rows, error } = await sb.from("credit_payments").selectFilter(
          "id,payment_date,amount,payment_method,department_id,account_holder_id,created_at,departments(name),account_holders(name)",
          `payment_date=eq.${localToday}&order=created_at.desc`
        );
        if (error) {
          console.error("Today's recoveries load error:", error);
          return;
        }
        const formatted = (rows || []).map((r) => ({
          id: `cloud-recovery-${r.id}`,
          recoveryType: r.department_id ? "Department" : "Individual",
          department: r.department_id ? r.departments?.name : undefined,
          individualName: r.account_holder_id ? r.account_holders?.name : undefined,
          amount: +r.amount || 0,
          mode: paymentMethodModeLabel(r.payment_method),
          date: r.payment_date,
          timestamp: r.created_at,
          synced: true,
        }));
        setCloudRecoveriesToday(formatted);
      } catch (e) {
        console.error("Today's recoveries load error:", e);
      }
    };
    loadTodaysRecoveries();
  }, [page]);

  // Today's auto-generated department credit ("sweet issue") sales, keyed by
  // Bhoga type, used on the Dashboard to show proof that the sweet issue for
  // a given Bhoga donation was actually auto-recorded from the department —
  // separate from the donation record itself.
  const [todaysAutoSweetIssueByBhoga, setTodaysAutoSweetIssueByBhoga] = useState({});

  useEffect(() => {
    if (page !== "dashboard") return; // refetch every time the Dashboard is opened, not just once on app load

    const loadTodaysBhogaDonations = async () => {

      // Local calendar date (not UTC), matching how the Donations tab stores bhoge_date, so "today" lines up correctly in every timezone.
      const now = new Date();
      const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      let primarySucceeded = false;

      try {
        const { data, error } = await sb.from("donations").selectEq("*", "bhoge_date", localToday);
        if (!error && data) {
          primarySucceeded = true;
          setTodaysBhogaDonations(
            data
              .map((row) => ({ id: String(row.id), trNo: row.tr_no, bhogeType: row.bhoge_type, donorName: row.donor_name, amount: row.amount,
                preacherName: row.preacher_name, verifiedByAsst: row.verified_by_asst, deliveredToDonor: row.delivered_to_donor,
              }))
              .sort((a, b) => (b.id > a.id ? 1 : -1))
          );
        }
      } catch {
        /* fall through to the offline cache below */
      }

      // Cross-check today's department-credit sales for each Bhoga's auto sweet-issue proof — the Auto Bhoga
      // Credit tags its `notes` with "Auto-generated — {bhogaType}", so a match here is proof the sweet issue
      // from the department was actually recorded, independent of the donation row itself.
      try {
        const { data: saleRows, error: saleErr } = await sb.from("sales").selectEq("*", "sale_date", localToday);
        if (!saleErr && Array.isArray(saleRows)) {
          const map = {};
          saleRows
            .filter((s) => s.sale_type === "department_credit" && s.notes && s.notes.includes("Auto-generated —"))
            .forEach((s) => {
              const match = s.notes.match(/Auto-generated — (.+?) \(scheduled/);
              const bhogaType = match ? match[1] : null;
              if (bhogaType) map[bhogaType] = { amount: +s.total_amount || 0 };
            });
          setTodaysAutoSweetIssueByBhoga(map);
        }
      } catch (e) {
        console.error("Auto sweet-issue proof load error:", e);
      }

      if (primarySucceeded) return;

      // Offline fallback — filter whatever the Donations tab has cached locally
      try {
        const cached = JSON.parse(localStorage.getItem("sweet-donations") || "[]");
        setTodaysBhogaDonations(cached.filter((d) => d.bhogeDate === localToday));
      } catch {
        setTodaysBhogaDonations([]);
      }
    };
    loadTodaysBhogaDonations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Lets the counter staff manually mark a Bhoga donation as delivered/handed
  // over to the donor — this is a deliberate manual step (unlike the auto
  // sweet-issue proof above), since only a person at the counter can confirm
  // the donor actually received it.
  const handleToggleDeliveredToDonor = async (id, current) => {
    setTodaysBhogaDonations((prev) => prev.map((d) => (d.id === id ? { ...d, deliveredToDonor: !current } : d)));
    try {
      const { error } = await sb.from("donations").update({ delivered_to_donor: !current }, "id", id);
      if (error) {
        console.error("Delivered-to-donor toggle error:", error);
        setTodaysBhogaDonations((prev) => prev.map((d) => (d.id === id ? { ...d, deliveredToDonor: current } : d)));
        alert("❌ Could not update delivery status. Please try again.");
      }
    } catch (e) {
      console.error("Delivered-to-donor toggle error:", e);
      setTodaysBhogaDonations((prev) => prev.map((d) => (d.id === id ? { ...d, deliveredToDonor: current } : d)));
      alert("❌ Could not update delivery status. Please try again.");
    }
  };

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMenuOpen]);

  const navigateTo = (nextPage) => {
    // The Reports > Daily Report date picker and the Dashboard share the same underlying
    // Supabase-synced totals (openingStockValue, cashTotal, paytmTotal, etc. — all driven by
    // refreshDailyStockAndTotals(), keyed to `selectedDate`). Without this reset, picking a past
    // date on the Reports page and then switching to any other page (Dashboard included) left
    // those figures showing that past date's numbers instead of today's, since nothing ever put
    // `selectedDate` back to today. The Dashboard should only ever reflect today, so leaving the
    // Reports page resets the date picker back to today.
    if (nextPage !== "reports" && selectedDate !== todayISO) setSelectedDate(todayISO);
    setPage(nextPage);
    setMobileMenuOpen(false);
  };
  const handleTouchStart = (event) => { setTouchStartX(event.touches[0].clientX); };

  const handleTouchEnd = (event) => {
    if (touchStartX === null) return;
    const endX = event.changedTouches[0].clientX; const distance = endX - touchStartX; const startedAtLeftEdge = touchStartX <= 40;
    if (!mobileMenuOpen && startedAtLeftEdge && distance > 60) {
      setMobileMenuOpen(true);
    }
    if (mobileMenuOpen && distance < -60) {
      setMobileMenuOpen(false);
    }
    setTouchStartX(null);
  };

  const [schedule, setSchedule] = usePersistentState("sweet-schedule", initialSchedule);

  // The "received" flag per batch used to be a pure local boolean with no connection back to Supabase — so if a stock_receipts row was deleted
  // directly (e.g. via a SQL reset script) or created on another device, this device's checkboxes would silently disagree with reality. This
  // re-derives "received" from whatever stock_receipts rows actually exist in Supabase for today, so the flag can never drift out of sync.
  const refreshScheduleReceivedStatus = async () => {
    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    try {
      const { data: receipts, error } = await sb.from("stock_receipts").selectEq("id,notes", "receipt_date", localToday);
      if (error) {
        console.error("Schedule received-status load error:", error);
        return;
      }
      const receiptByNote = new Map((receipts || []).map((r) => [r.notes, r.id]));
      const receiptIds = [...receiptByNote.values()];

      // Pull item-level quantities for every matched receipt too, not just the received flag — so a correction saved on
      // one device (via the Receive correction table) is picked up here and shown correctly on every other device.
      const itemsByReceiptId = new Map();
      if (receiptIds.length > 0) {
        try {
          const idToName = Object.fromEntries(Object.entries(sweetIdByName).map(([name, id]) => [id, name]));
          const { data: itemRows, error: itemsError } = await sb
            .from("stock_receipt_items")
            .selectFilter("receipt_id,sweet_id,quantity", `receipt_id=in.(${receiptIds.join(",")})`);
          if (!itemsError && Array.isArray(itemRows)) {
            itemRows.forEach((r) => {
              const name = idToName[r.sweet_id];
              if (!name) return;
              const bucket = itemsByReceiptId.get(r.receipt_id) || createEmptyItems();
              bucket[name] = (bucket[name] || 0) + (Number(r.quantity) || 0);
              itemsByReceiptId.set(r.receipt_id, bucket);
            });
          }
        } catch (e) {
          console.error("Schedule received-items load error:", e);
        }
      }

      setSchedule((currentSchedule) =>
        currentSchedule.map((b) => {
          const note = `Scheduled batch — ${b.time}`; const match = receiptByNote.get(note);
          if (!match) return { ...b, received: false, receiptId: null };
          const syncedItems = itemsByReceiptId.get(match);
          return { ...b, received: true, receiptId: match, items: syncedItems || b.items };
        })
      );
    } catch (e) {
      console.error("Schedule received-status load error:", e);
    }
  };

  // Runs on EVERY page load/change, not just when the Receive page is open — schedule.received feeds Dashboard's received stock/total too,
  // so gating this to one page meant every other page (Dashboard included) kept showing stale data until you happened to visit Receive first.
  useEffect(() => {
    refreshScheduleReceivedStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // ── Stock Adjustment tool ────────────────────────────────────────
  // Replaces the old "Undo receipt" idea — undoing a receipt after sales have already been recorded against it could push available stock
  // negative. Instead, corrections are their own explicit, auditable entries (mirroring the Supabase stock_adjustments table), each with
  // its own type/reason, and they never remove anything already logged.
  const [showAdjustBox, setShowAdjustBox] = useState(false);
  const [adjustmentRows, setAdjustmentRows] = usePersistentState("sweet-stock-adjustment-drafts", []);
  // Net signed effect of every SAVED adjustment today, per sweet — folded into availableStock below, and refreshed from Supabase for cross-device
  // consistency the same way cash/paytm/credit stock already is.
  const [adjustmentEffects, setAdjustmentEffects] = usePersistentState("sweet-stock-adjustment-effects", createEmptyItems());

  const formatTimeNow = () => new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

  const addAdjustmentRow = () => {
    setAdjustmentRows((rows) => [
      ...rows,
      { id: Date.now(), time: formatTimeNow(), adjustmentType: "addition", reason: "", items: createEmptyItems() },
    ]);
  };

  const updateAdjustmentRowField = (rowId, field, value) => {
    setAdjustmentRows((rows) => rows.map((r) => (r.id === rowId ? { ...r, [field]: value } : r)));
  };

  const updateAdjustmentRowItem = (rowId, sweetName, qty) => {
    setAdjustmentRows((rows) =>
      rows.map((r) => (r.id === rowId ? { ...r, items: { ...r.items, [sweetName]: Math.max(0, Number(qty) || 0) } } : r))
    );
  };

  const discardAdjustmentRow = (rowId) => { setAdjustmentRows((rows) => rows.filter((r) => r.id !== rowId)); };

  const saveAdjustmentRow = async (rowId) => { const row = adjustmentRows.find((r) => r.id === rowId);
    if (!row) return;
    const nonZeroItems = Object.entries(row.items).filter(([, qty]) => qty > 0);
    if (nonZeroItems.length === 0) {
      alert("Enter a quantity for at least one sweet before saving.");
      return;
    }
    if (!row.reason.trim()) { alert("Please enter a reason for this adjustment."); return; }
    try {
      assertAllSweetIdsResolved(row.items);
    } catch (e) {
      alert(`⚠️ ${e.message}`);
      return;
    }

    const now = new Date();
    const adjustmentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const sign = row.adjustmentType === "addition" ? 1 : -1;
    const insertRows = nonZeroItems.map(([name, qty]) => ({
      adjustment_date: adjustmentDate, sweet_id: sweetIdByName[name], adjustment_type: row.adjustmentType,
      quantity: qty, // always positive — direction comes from adjustment_type
      reason: row.reason.trim(),
    }));

    try {
      const { error } = await sb.from("stock_adjustments").insert(insertRows);
      if (error) throw error;
    } catch (e) {
      console.error("Stock adjustment save error:", e);
      alert(`❌ Could not save this adjustment to Supabase (${e.message || "unknown error"}). Nothing was recorded — please try again.`);
      return;
    }

    // Apply the signed effect locally right away; refreshDailyStockAndTotals() will re-confirm the authoritative total from Supabase moments later.
    setAdjustmentEffects((prev) => {
      const updated = { ...prev };
      nonZeroItems.forEach(([name, qty]) => { updated[name] = (updated[name] || 0) + sign * qty; });
      return updated;
    });

    discardAdjustmentRow(rowId); alert("✅ Stock adjustment saved."); refreshDailyStockAndTotals();
  };

  // CASH
  const [cashSale, setCashSale] = useState(createEmptyItems());
  const [cashTotal, setCashTotal] = usePersistentState("sweet-cash-total", 0);
  const [cashRecords, setCashRecords] = usePersistentState("sweet-cash-records", []);
  const [cashSoldStock, setCashSoldStock] = usePersistentState("sweet-cash-stock", createEmptyItems());

  // PAYTM
  const [paytmSale, setPaytmSale] = useState(createEmptyItems());
  const [paytmTotal, setPaytmTotal] = usePersistentState("sweet-paytm-total", 0);
  const [paytmRecords, setPaytmRecords] = usePersistentState("sweet-paytm-records", []);
  const [paytmSoldStock, setPaytmSoldStock] = usePersistentState("sweet-paytm-stock", createEmptyItems());
  const [paytmChannel, setPaytmChannel] = useState("Paytm"); // "Paytm" | "UPI" — which digital channel this sale used

  // Department credit
  const [departmentCreditStock, setDepartmentCreditStock] = usePersistentState("sweet-credit-stock", createEmptyItems());
  const [creditRecords, setCreditRecords] = usePersistentState("sweet-credit-records", []);
  // Authoritative Supabase-synced totals for the Dashboard's Credit Sales card — same treatment as cashTotal/paytmTotal
  // above, refreshed by refreshDailyStockAndTotals(). Kept separate from creditRecords/individualCreditRecords, which
  // remain this device's local list of transactions (used for report generation and the recent-transactions display).
  const [departmentCreditTotal, setDepartmentCreditTotal] = usePersistentState("sweet-department-credit-total", 0);
  const [individualCreditTotal, setIndividualCreditTotal] = usePersistentState("sweet-individual-credit-total", 0);
  const [departmentPayments, setDepartmentPayments] = usePersistentState("sweet-department-payments", []);
  
  
  // Permanent department ledger: survives day closing and keeps each department's full due history.
  const [departmentLedger, setDepartmentLedger] = usePersistentState("sweet-department-ledger", []);
  const [paymentDepartment, setPaymentDepartment] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState("Cash");
  const [payerType, setPayerType] = useState("Department");
  const [payerName, setPayerName] = useState("");
  const [payerMobile, setPayerMobile] = useState("");
  const [dailyReports, setDailyReports] = usePersistentState("sweet-daily-reports", []);

  // ── Reports > Daily Report data for whichever `selectedDate` is picked, sourced straight from
  // Supabase (see refreshDailyStockAndTotals) rather than this device's local, today-only record
  // arrays — so the report is correct for any date, on any device, including bulk-imported dates. ──
  const [reportReceivedStockValue, setReportReceivedStockValue] = useState(0);
  const [reportDepartmentRecovery, setReportDepartmentRecovery] = useState({ Cash: 0, Paytm: 0, "T.R.": 0 });
  const [reportIndividualRecovery, setReportIndividualRecovery] = useState({ Cash: 0, Paytm: 0, "T.R.": 0 });
  const [openingStock, setOpeningStock] = usePersistentState("sweet-opening-stock", createEmptyItems());
  const [openingStockValue, setOpeningStockValue] = usePersistentState("sweet-opening-stock-value", 0);

  const handleEnterWithin = (event, selector) => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    const fields = Array.from(document.querySelectorAll(selector));
    const currentIndex = fields.indexOf(event.target);

    if (currentIndex !== -1 && currentIndex < fields.length - 1) {
      fields[currentIndex + 1].focus();
    }
  };

  // Other data-entry pages use the same keyboard shortcut, limited to the
  // currently rendered app content and to editable fields only.
  const handlePageEnter = (event) => {
    if (event.defaultPrevented || event.key !== "Enter") return;

    handleEnterWithin(
      event,
      ".enter-next-page select:not(:disabled), .enter-next-page input:not([readonly]):not([type='checkbox']):not(:disabled)"
    );
  };

  const [expandedCard, setExpandedCard] = useState(null);

  // Which credit-report page (if any) is open, and which period (Daily/Monthly) it opens on by default —
  // the period itself is now switched from inside the report page, not from the dashboard card.
  const [creditReportPeriod, setCreditReportPeriod] = useState("daily");
  // Which view is shown inside the Reports section: the Daily Report, or
  // one of the two Credit Reports (moved here from the Dashboard so all
  // reports live in one place).
  const [reportsView, setReportsView] = useState("daily");
  const [individualCreditRecords, setIndividualCreditRecords] = usePersistentState("sweet-individual-credit-records", []);
  const [individualCreditStock, setIndividualCreditStock] = usePersistentState("sweet-individual-credit-stock", createEmptyItems());
  const [individualLedger, setIndividualLedger] = usePersistentState("sweet-individual-ledger", []);

  // Populated by refreshDues() from Supabase — the authoritative source
  // of what's actually owed, not a per-device local accumulation.
  const [departmentDues, setDepartmentDues] = useState({});
  const [individualDues, setIndividualDues] = useState({});
  const [recoveryType, setRecoveryType] = useState("Department");
  const [paymentIndividual, setPaymentIndividual] = useState("");
  
  // Legacy T.R. Sale data is intentionally retired: T.R. is now only a Department Recovery mode.

  useEffect(() => {
    localStorage.removeItem("sweet-tr-stock"); localStorage.removeItem("sweet-tr-records");
  }, []);

  // =========================
  // RECEIVE FUNCTIONS
  // =========================

  // NOTE: The six scheduled batches used to be auto-received here client-side (a 30s-polling
  // useEffect calling a local markReceived()). That only worked while some device had the app
  // open. It has been replaced by Supabase pg_cron jobs (see auto_scheduled_receipts_and_credits.sql
  // → process_scheduled_receipt), which create the exact same stock_receipts row — same notes
  // marker (`Scheduled batch — ${time}`) — directly in the database on schedule, whether or not
  // the app is open anywhere. refreshScheduleReceivedStatus() below still re-derives "received"
  // straight from Supabase, so the Receive page and its correction table need no other changes.

  // ── Receive correction table ─────────────────────────────────────
  // Lets an already-auto-received batch be recalled and fixed (miscount at the door, etc.) without touching the
  // one-way received flag itself — only the item quantities on that batch's stock_receipt_items are replaced.
  const [editingReceiptIndex, setEditingReceiptIndex] = useState(null);
  const [editDraftItems, setEditDraftItems] = useState(null);

  const startEditReceipt = (index) => {
    setEditingReceiptIndex(index);
    setEditDraftItems({ ...schedule[index].items });
  };

  const updateEditDraftItem = (name, value) => {
    setEditDraftItems((draft) => ({ ...draft, [name]: Math.max(0, Number(value) || 0) }));
  };

  const cancelEditReceipt = () => { setEditingReceiptIndex(null); setEditDraftItems(null); };

  const saveReceiptCorrection = async (index) => {
    const batch = schedule[index];
    if (!batch.receiptId) { alert("This batch hasn't been received yet — nothing to correct."); return; }

    try {
      assertAllSweetIdsResolved(editDraftItems);
    } catch (e) {
      alert(`⚠️ ${e.message}`);
      return;
    }

    const nonZeroItems = Object.entries(editDraftItems).filter(([, qty]) => qty > 0);
    if (nonZeroItems.length === 0) {
      alert("Enter a quantity for at least one sweet before saving.");
      return;
    }

    try {
      // Replace every item row for this receipt — delete then reinsert — so a repeated correction never leaves stale
      // duplicate line items behind, and the receipt total always matches exactly what's on screen.
      const { error: delError } = await sb.from("stock_receipt_items").delete("receipt_id", batch.receiptId);
      if (delError) throw delError;
      const newItemRows = nonZeroItems.map(([name, qty]) => ({
        receipt_id: batch.receiptId, sweet_id: sweetIdByName[name], quantity: qty, rate: prices[name] || 0,
      }));
      const { error: insError } = await sb.from("stock_receipt_items").insert(newItemRows);
      if (insError) throw insError;
    } catch (e) {
      console.error("Receipt correction save error:", e);
      alert(`❌ Could not save this correction to Supabase (${e.message || "unknown error"}). Please try again.`);
      return;
    }

    setSchedule((currentSchedule) =>
      currentSchedule.map((b, i) => (i !== index ? b : { ...b, items: { ...editDraftItems } }))
    );
    setEditingReceiptIndex(null); setEditDraftItems(null);
    alert("✅ Receive transaction corrected.");
  };

  // =========================
  // CALCULATIONS
  // =========================

  const calculateBatchTotal = (items) => { return Object.entries(items).reduce( (total, [item, quantity]) => total + quantity * prices[item], 0 ); };

  const receivedTotal = schedule.reduce(
    (total, batch) => { if (!batch.received) return total; return ( total + calculateBatchTotal(batch.items) ); },
    0
  );

  // =========================
  // RECEIVED STOCK
  // =========================

  const receivedStock = Object.keys(prices).reduce(
      (stock, item) => {
        stock[item] = schedule.reduce(
          (total, batch) => {
            if (!batch.received) return total;
            return ( total + (batch.items[item] || 0) );
          },
          0
        );
        return stock;
      },
      {}
    );

  // =========================
  // AVAILABLE STOCK
  // =========================
  // Department/individual dues are now sourced from Supabase (via refreshDues(), called on every page change and after every credit
  // sale/recovery save) instead of being derived from this device's own local ledger — that was the reason mobile and laptop could disagree
  // on what's actually owed.

  // Today's recovery totals now come from Supabase (reportDepartmentRecovery / reportIndividualRecovery,
  // fetched by refreshDailyStockAndTotals for `selectedDate` — which is always today's date here, since
  // navigateTo() resets selectedDate back to today on every page except Reports). This is what fixes
  // recoveries recorded on another device, or inserted directly by an import script, from being invisible
  // on these cards — they were previously computed purely from `departmentPayments`, a per-browser-only
  // array that only ever grew when a recovery was saved through THIS device's own Credit Recovery form.
  //
  // Local unsynced entries (a save that succeeded locally but failed to reach Supabase) are added on top,
  // same reasoning as the Cash/Paytm sale sections — money that's genuinely been received shouldn't vanish
  // from these totals just because the network call failed.
  const sumUnsyncedRecoveries = (isIndividual, mode) =>
    departmentPayments
      .filter((p) => p.synced === false && (p.recoveryType === "Individual") === isIndividual && (p.mode || "Cash") === mode)
      .reduce((total, p) => total + (p.amount || 0), 0);

  const departmentCashReceivedToday = (reportDepartmentRecovery.Cash || 0) + sumUnsyncedRecoveries(false, "Cash");
  const departmentPaytmReceivedToday = (reportDepartmentRecovery.Paytm || 0) + sumUnsyncedRecoveries(false, "Paytm");
  const departmentTrReceivedToday = (reportDepartmentRecovery["T.R."] || 0) + sumUnsyncedRecoveries(false, "T.R.");
  const individualCashReceivedToday = (reportIndividualRecovery.Cash || 0) + sumUnsyncedRecoveries(true, "Cash");
  const individualPaytmReceivedToday = (reportIndividualRecovery.Paytm || 0) + sumUnsyncedRecoveries(true, "Paytm");
  const individualTrReceivedToday = (reportIndividualRecovery["T.R."] || 0) + sumUnsyncedRecoveries(true, "T.R.");

  // Today's Recoveries list (Credit Recovery page) — merges the Supabase-sourced rows above with
  // any still-unsynced local entries, so it shows recoveries from every device/import, not just
  // ones saved through this browser.
  const recoveriesToday = [...cloudRecoveriesToday, ...departmentPayments.filter((p) => p.synced === false)]
    .sort((a, b) => new Date(b.timestamp || b.date || 0) - new Date(a.timestamp || a.date || 0));

  const cashToDeposit = cashTotal + departmentCashReceivedToday + individualCashReceivedToday;
  const totalPaytmCollection = paytmTotal + departmentPaytmReceivedToday + individualPaytmReceivedToday;
  const totalTrCollection = departmentTrReceivedToday + individualTrReceivedToday;

  // Per-table column config — departments only has id/name (no mobile column at all), while account_holders/carriers also have mobile.
  // Selecting a nonexistent column throws a Postgres error, so this must match each table's real schema.
  const MASTER_TABLE_CONFIG = {
    departments: { select: "id,name", supportsMobile: false },
    account_holders: { select: "id,name,mobile", supportsMobile: true },
    carriers: { select: "id,name,mobile", supportsMobile: true },
  };

  // Look up a master-data row by NORMALIZED name (departments / account_holders / carriers) — case/whitespace-insensitive, so "TEMPLE" and "Temple" resolve
  // to the same row instead of creating a duplicate. Creates the row on first use since these currently have no fixed seed list beyond what's hardcoded
  // in the UI. If the row already exists but the mobile number given is new/ different, updates it — so master data doesn't go stale after first entry.
  const getOrCreateMasterId = async (table, name, extraFields = {}) => {
    if (!name) return null;
    const normalizedName = name.trim();
    if (!normalizedName) return null;
    const config = MASTER_TABLE_CONFIG[table] || { select: "id,name", supportsMobile: false };

    try {
      const { data: existing, error: lookupError } = await sb.from(table).selectIlike(config.select, "name", normalizedName);
      if (lookupError) throw lookupError;
      if (Array.isArray(existing) && existing.length > 0) {
        const row = existing[0];
        // Keep the mobile number current if a new one was provided and differs
        // — only for tables that actually have a mobile column.
        if (config.supportsMobile && extraFields.mobile && extraFields.mobile !== row.mobile) {
          const { error: updateError } = await sb.from(table).update({ mobile: extraFields.mobile }, "id", row.id);
          if (updateError) console.error(`getOrCreateMasterId(${table}) mobile update error:`, updateError);
        }
        return row.id;
      }
      const insertPayload = { name: normalizedName };
      if (config.supportsMobile && extraFields.mobile) insertPayload.mobile = extraFields.mobile;

      const { data: created, error: insertError } = await sb.from(table).insert(insertPayload);
      if (insertError) throw insertError;
      return Array.isArray(created) && created[0] ? created[0].id : null;
    } catch (e) {
      console.error(`getOrCreateMasterId(${table}) error:`, e);
      throw e; // don't let a master-data failure silently proceed as if it worked
    }
  };

  // Insert a `sales` header row + its `sale_items` + its ledger entry, for Department/Individual Credit sales — atomically via RPC.
  // NOTE: Department Credit's own "Account Holder" field is a pickup/contact person for the department — NOT a debtor. Only the department itself
  // owes the money. It must never be sent as account_holder_id (that column means "the individual who owes this", enforced by the RPC's exactly-
  // one-debtor rule) — it's stored as free text instead (customer_name).
  const saveCreditSaleToSupabase = async ({ saleType, departmentName, contactName, contactMobile, carrierName, carrierMobile, debtorName, debtorMobile, referenceType, referenceName, items, totalAmount, notes }) => {
    const now = new Date();
    const saleDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    try {
      assertAllSweetIdsResolved(Object.fromEntries(items.map((it) => [it.sweet, it.quantity])));

      const isDepartment = saleType === "department_credit";
      const departmentId = isDepartment && departmentName ? await getOrCreateMasterId("departments", departmentName) : null;
      // Only Individual Credit's debtor becomes account_holder_id.
      const accountHolderId = !isDepartment && debtorName ? await getOrCreateMasterId("account_holders", debtorName, { mobile: debtorMobile }) : null;
      const carrierId = isDepartment && carrierName ? await getOrCreateMasterId("carriers", carrierName, { mobile: carrierMobile }) : null;

      // Department Credit's contact person/mobile has nowhere dedicated to
      // live, so it's folded into customer_name / notes as plain text.
      const combinedNotes = isDepartment && contactMobile
        ? `${notes ? notes + " — " : ""}Contact mobile: ${contactMobile}`
        : (notes || null);

      const itemRows = items.map((it) => ({
        sweet_id: sweetIdByName[it.sweet], quantity: it.quantity, rate: prices[it.sweet] || 0,
        total_amount: it.quantity * (prices[it.sweet] || 0),
      }));

      const ledgerTable = isDepartment ? "department_ledger_entries" : "account_ledger_entries";
      const ledgerPayload = isDepartment
        ? { department_id: departmentId, entry_type: "credit_sale", amount: totalAmount, description: notes || null }
        : { account_holder_id: accountHolderId, entry_type: "credit_sale", amount: totalAmount, description: notes || null };

      const { data: saleId, error } = await sb.rpc("create_credit_sale_with_ledger", {
        p_sale: {
          sale_date: saleDate, sale_type: saleType, department_id: departmentId, account_holder_id: accountHolderId,
          carrier_id: carrierId, customer_name: isDepartment ? (contactName || null) : null,
          reference_type: referenceType || null, reference_name: referenceName || null, subtotal: totalAmount, discount: 0,
          total_amount: totalAmount, amount_paid: 0, balance_amount: totalAmount, notes: combinedNotes,
        },
        p_items: itemRows, p_ledger_table: ledgerTable, p_ledger: ledgerPayload,
      });
      if (error) throw error;
      if (!saleId) throw new Error("No sale id returned");

      return { ok: true };
    } catch (e) {
      console.error("Credit sale save error:", e);
      return { ok: false, error: e };
    }
  };

  // Insert a `credit_payments` row + its ledger entry — atomically via RPC. sale_id is left null since recoveries are usually a round figure against
  // the overall running balance, not tied to one specific original sale. Shared save path for a Department Credit transaction — used by the manual
  // Department Credit page AND by the automatic Bhoga-schedule credits below, so both stay in perfect sync (same ledger updates, same rollback-on-
  // failure behaviour, same refreshes).
  const performDepartmentCreditSave = async (transaction, { silent = false } = {}) => {
    const ledgerEntry = { ...transaction, id: transaction.id || Date.now(), department: transaction.department, amount: transaction.totalAmount || transaction.amount || 0, kind: "credit" };
    setCreditRecords((records) => [...records, transaction]);
    setDepartmentLedger((ledger) => [...ledger, ledgerEntry]);

    const result = await saveCreditSaleToSupabase({
      saleType: "department_credit", departmentName: transaction.department, contactName: transaction.accountHolder,
      contactMobile: transaction.accountHolderMobile, carrierName: transaction.carrier, carrierMobile: transaction.carrierMobile,
      items: transaction.items, totalAmount: transaction.totalAmount, notes: transaction.purpose,
    });

    if (!result.ok) {
      // Roll back — the credit sale did NOT actually reach Supabase, so it must not silently look "saved" in the local records either.
      setCreditRecords((records) => records.filter((r) => r !== transaction));
      setDepartmentLedger((ledger) => ledger.filter((l) => l !== ledgerEntry));
      if (silent) {
        console.error(`Auto Bhoga credit save failed for ${transaction.carrier}:`, result.error);
      } else {
        alert(`❌ Could not save this Department Credit to Supabase (${result.error?.message || "unknown error"}). Nothing was recorded — please try again.`);
      }
    } else {
      refreshDailyStockAndTotals();
      refreshDues();
    }
    return result;
  };

  // NOTE: The "Auto Bhoga Credits" (6 donation-triggered Department Credits) and "Auto Daily
  // Department Credits" (Temple / Vraja Sundari Mataji) client-side polling effects that used to
  // live here have been replaced by Supabase pg_cron jobs — see auto_scheduled_receipts_and_credits.sql
  // (process_auto_bhoga_credits / process_auto_daily_department_credit). They write through the same
  // create_credit_sale_with_ledger RPC and the same carrier+date duplicate-guard, so ledgers/dues are
  // unaffected. performDepartmentCreditSave() below is kept — it's still used by the manual
  // Department Credit page.

  const saveRecoveryToSupabase = async ({ recoveryType, targetName, amount, mode }) => {
    const paymentMethod = mode === "Cash" ? "cash" : mode === "Paytm" ? "paytm" : mode === "T.R." ? "tr" : "other";
    // Set the local calendar date explicitly (matching saveSaleToSupabase / markReceived) instead
    // of relying on the RPC's own default — a client just past local midnight but before the
    // server's UTC day rolls over (or vice versa) would otherwise get recorded against the wrong day.
    const now = new Date();
    const paymentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    try {
      let departmentId = null;
      let accountHolderId = null;
      if (recoveryType === "Department") departmentId = await getOrCreateMasterId("departments", targetName);
      else accountHolderId = await getOrCreateMasterId("account_holders", targetName);

      const ledgerTable = recoveryType === "Department" ? "department_ledger_entries" : "account_ledger_entries";
      const ledgerPayload =
        recoveryType === "Department"
          ? { department_id: departmentId, entry_type: "payment", amount: -amount, description: `Recovery — ${mode}` }
          : { account_holder_id: accountHolderId, entry_type: "payment", amount: -amount, description: `Recovery — ${mode}` };

      const { data: paymentId, error } = await sb.rpc("create_recovery_payment", {
        p_payment: {
          department_id: departmentId,
          account_holder_id: accountHolderId,
          amount,
          payment_method: paymentMethod,
          payment_date: paymentDate,
        },
        p_ledger_table: ledgerTable,
        p_ledger: ledgerPayload,
      });
      if (error) throw error;
      if (!paymentId) throw new Error("No payment id returned");

      return { ok: true };
    } catch (e) {
      console.error("Recovery save error:", e);
      return { ok: false, error: e };
    }
  };

  // ── Clear-all-data tool, for trial/testing resets ───────────────────
  // Deletion order respects foreign-key dependencies: child rows before parents (sale_items before sales, etc.), and — when master data is
  // included — only after every table that RESTRICTs deleting a sweet (sale_items, stock_receipt_items, inventory_*, stock_adjustments)
  // has already been cleared.
  const TRANSACTION_TABLES_IN_DELETE_ORDER = [
    "sale_items", "stock_receipt_items", "department_ledger_entries", "account_ledger_entries", "credit_payments", "sales",
    "stock_receipts", "inventory_openings", "inventory_closings", "stock_adjustments", "daily_reports", "donations",
  ];
  const MASTER_TABLES_IN_DELETE_ORDER = [
    "departments", "account_holders", "carriers", "sweets", "bhoga_types", "preachers",
  ];

  const handleResetAllData = async (includeMasterData) => {
    const confirmWord = includeMasterData ? "RESET EVERYTHING" : "RESET";
    const typed = window.prompt(
      `This will permanently delete ${includeMasterData
        ? "ALL data including master records (sweets, departments, account holders, carriers, bhoga types, preachers)"
        : "all transactional data (sales, credit, donations, reports, inventory) but KEEP master data"
      } from Supabase, and clear this device's local cache.\n\nType "${confirmWord}" to confirm:`
    );
    if (typed !== confirmWord) { alert("Cancelled — confirmation text didn't match."); return; }

    const tables = includeMasterData
      ? [...TRANSACTION_TABLES_IN_DELETE_ORDER, ...MASTER_TABLES_IN_DELETE_ORDER]
      : TRANSACTION_TABLES_IN_DELETE_ORDER;

    const errors = [];
    for (const table of tables) {
      const { error } = await sb.from(table).deleteAll();
      if (error) errors.push(`${table}: ${error.message || error.status || "unknown error"}`);
    }

    // Clear every sweet-* local cache key on this device too
    Object.keys(localStorage).filter((k) => k.startsWith("sweet-")).forEach((k) => localStorage.removeItem(k));

    if (errors.length > 0) {
      alert(`⚠️ Cleared with some errors — you may need to re-run this:\n${errors.join("\n")}`);
    } else {
      alert("✅ All data cleared. The app will now reload with a clean slate.");
    }
    window.location.reload();
  };

  const saveDepartmentPayment = async () => {
    const amount = Number(paymentAmount);
    const target = recoveryType === "Individual" ? paymentIndividual : paymentDepartment;
    const due = recoveryType === "Individual" ? (individualDues[target] || 0) : (departmentDues[target] || 0);
    if (!target || !amount || amount <= 0 || !payerName.trim()) { alert("Select due account, enter payer name and a valid recovery amount."); return; }
    if (amount > due) { alert(`Recovery cannot exceed outstanding due of ₹ ${due}.`); return; }

    const result = await saveRecoveryToSupabase({ recoveryType, targetName: target, amount, mode: paymentMode });

    // Recovery is also money already physically/digitally received — flag
    // as unsynced rather than rolling back, same reasoning as Cash/Paytm.
    const record = { id: Date.now(), recoveryType, department: recoveryType === "Department" ? target : undefined, individualName: recoveryType === "Individual" ? target : undefined, amount, mode: paymentMode, payerType, payerName: payerName.trim(), kind: "recovery", timestamp: new Date().toISOString(), date: new Date().toISOString(), type: `${recoveryType} Recovery — ${paymentMode}`, synced: result.ok };
    setDepartmentPayments((payments) => [...payments, record]);
    if (recoveryType === "Individual") setIndividualLedger((ledger) => [...ledger, record]);
    else setDepartmentLedger((ledger) => [...ledger, record]);

    setPaymentDepartment(""); setPaymentIndividual(""); setPaymentAmount(""); setPaymentMode("Cash"); setPayerType("Department"); setPayerName(""); setPayerMobile("");
    if (!result.ok) {
      alert(`${recoveryType} recovery saved locally as ${paymentMode}, but could NOT sync to Supabase (${result.error?.message || "unknown error"}). This entry is marked unsynced — please reconcile manually if needed.`);
    } else {
      alert(`${recoveryType} recovery saved as ${paymentMode}. The due has been reduced without changing stock.`);
      refreshDues(); // pull the authoritative post-recovery balance right away
      refreshDailyStockAndTotals(); // also refresh this recovery into the Daily Report totals right away
    }
  };
  const outgoingValue = cashTotal + paytmTotal + departmentCreditTotal + individualCreditTotal;


  // Manual stock adjustments (additions/losses) change quantities but were previously left out of this rupee total, causing it to drift from the per-item breakdown below
  // (which is built straight from availableStock, and does include adjustments).
  const adjustmentValue = Object.keys(prices).reduce((total, item) => total + (adjustmentEffects[item] || 0) * (prices[item] || 0), 0);
  const closingStockValue = openingStockValue + receivedTotal - outgoingValue + adjustmentValue;

  // Closing stock value for the Reports > Daily Report page specifically — same formula as above,
  // but built entirely from the per-selectedDate Supabase-sourced numbers (reportReceivedStockValue
  // instead of the today-only, schedule-based receivedTotal), so it's correct for any date.
  const reportClosingStockValue = openingStockValue + reportReceivedStockValue - outgoingValue + adjustmentValue;
  const closeAvailable = new Date().getHours() > 20 || (new Date().getHours() === 20 && new Date().getMinutes() >= 30);

  const closeDay = async () => {
    // if (!closeAvailable) { alert("Close Day is available only at or after 8:30 PM."); return; }

    // Block the entire close-day process if any sweet's Supabase id hasn't resolved yet — otherwise inventory_closings/inventory_openings would
    // silently drop that sweet, corrupting today's closing AND tomorrow's opening stock with no visible error.
    const missingSweets = Object.keys(prices).filter((name) => !sweetIdByName[name]);
    if (missingSweets.length > 0) {
      alert(`❌ Cannot close the day.\n\nThe following sweet names are missing from Supabase master data:\n\n- ${missingSweets.join("\n- ")}\n\nPlease wait for sync to finish (or check your connection), then try Close Day again.`);
      return;
    }

    const report = { id: Date.now(), date: new Date().toISOString(), openingStock, openingStockValue, receivedTotal, issuedValue: outgoingValue, cashTotal, paytmTotal, creditRecords, individualCreditRecords, cashRecords, paytmRecords, departmentPayments, departmentCashReceivedToday, departmentPaytmReceivedToday, departmentTrReceivedToday, individualCashReceivedToday, individualPaytmReceivedToday, individualTrReceivedToday, cashToDeposit, totalPaytmCollection, totalTrCollection, closingStock: availableStock, closingStockValue };
    if (!window.confirm(`Close this business day? Closing stock value: ₹ ${closingStockValue}`)) return;

    // ── Save the same summary to Supabase's daily_reports table
    //    (one row per calendar date, upserted by report_date) ──────────
    const now = new Date();
    const reportDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const departmentCreditTotalForReport = departmentCreditTotal;
    const individualCreditTotalForReport = individualCreditTotal;
    const creditPaymentsReceived =
      departmentCashReceivedToday + departmentPaytmReceivedToday + departmentTrReceivedToday +
      individualCashReceivedToday + individualPaytmReceivedToday + individualTrReceivedToday;

    const reportPayload = {
      opening_stock_value: openingStockValue, received_stock_value: receivedTotal, cash_sales: cashTotal, paytm_sales: paytmTotal,
      upi_sales: 0, // reserved for a future dedicated UPI channel, distinct from Paytm
      department_credit_sales: departmentCreditTotalForReport, individual_credit_sales: individualCreditTotalForReport,
      credit_payments_received: creditPaymentsReceived, closing_stock_value: closingStockValue, total_sales: outgoingValue,
    };

    try {
      const { error } = await sb.from("daily_reports").upsert({ report_date: reportDate, ...reportPayload }, "report_date");
      if (error) throw error;
    } catch (e) {
      console.error("Daily report save error:", e);
      alert("⚠️ Could not save today's report to Supabase (it's still saved locally in this app). Check your connection — you can retry by closing the day again if needed.");
    }

    // ── Per-sweet closing stock for today, and opening stock for the
    //    next business day (tomorrow's opening == today's closing) ────
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    try {
      const closingRows = Object.keys(prices)
        .map((name) => ({ stock_date: reportDate, sweet_id: sweetIdByName[name] || null, quantity: availableStock[name] || 0 }))
        .filter((r) => r.sweet_id);
      const openingRows = Object.keys(prices)
        .map((name) => ({ stock_date: tomorrowDate, sweet_id: sweetIdByName[name] || null, quantity: availableStock[name] || 0 }))
        .filter((r) => r.sweet_id);

      if (closingRows.length > 0) {
        const { error } = await sb.from("inventory_closings").upsert(closingRows, "stock_date,sweet_id");
        if (error) console.error("Inventory closing save error:", error);
      }
      if (openingRows.length > 0) {
        const { error } = await sb.from("inventory_openings").upsert(openingRows, "stock_date,sweet_id");
        if (error) console.error("Inventory opening save error:", error);
      }
    } catch (e) {
      console.error("Inventory save error:", e);
    }

    setDailyReports((x)=>[...x, report]);
    setOpeningStock(availableStock); setOpeningStockValue(closingStockValue);
    setSchedule(initialSchedule.map(b=>({...b, received:false})));
    setCashTotal(0); setCashRecords([]); setCashSoldStock(createEmptyItems()); setPaytmTotal(0); setPaytmRecords([]); setPaytmSoldStock(createEmptyItems()); setDepartmentCreditStock(createEmptyItems()); setIndividualCreditStock(createEmptyItems()); setCreditRecords([]); setIndividualCreditRecords([]); setDepartmentPayments([]); setDepartmentCreditTotal(0); setIndividualCreditTotal(0);
    setAdjustmentEffects(createEmptyItems()); // today's adjustments are already baked into the new opening stock snapshot above
    alert("Day closed successfully. Closing stock has been carried forward as the next opening stock."); navigateTo("dashboard");
  };

  const availableStock =
    Object.keys(prices).reduce(
      (stock, item) => {
        stock[item] = (openingStock[item] || 0) + receivedStock[item] - cashSoldStock[item] - paytmSoldStock[item] - departmentCreditStock[item] - individualCreditStock[item] + (adjustmentEffects[item] || 0);
        return stock;
      },
      {}
    );


  // =========================
  //       CASH SALE
  // =========================

  const changeCashQuantity = ( item, change ) => {
    setCashSale((current) => ({ ...current, [item]: Math.max( 0, Math.min( availableStock[item], current[item] + change ) ), }));
  };

  const setCashQuantity = ( item, value ) => {
    let quantity = Math.max(0, Number(value) || 0);
    if (quantity > availableStock[item]) { quantity = availableStock[item]; }
    setCashSale((current) => ({ ...current, [item]: quantity, }));
  };

  const currentCashSaleTotal = Object.entries(cashSale).reduce( (total, [item, quantity]) => total + quantity * prices[item], 0 );

  const saveCashSale = async () => {
    if (currentCashSaleTotal === 0) {
      alert("Please enter at least one item.");
      return;
    }
    setCashSoldStock((currentSold) => {
      const updated = { ...currentSold };
      Object.keys(cashSale).forEach( (item) => { updated[item] = currentSold[item] + cashSale[item]; } );
      return updated;
    });

    setCashTotal((total) => total + currentCashSaleTotal);

    const result = await saveSaleToSupabase("cash", "cash", cashSale, currentCashSaleTotal);

    // Cash was physically received already — we never roll back the local total/stock for a Supabase failure, since the sale genuinely happened.
    // Instead flag it as unsynced so it can be reconciled/retried later.
    setCashRecords((records) => [...records, { id: Date.now(), date: new Date().toISOString(), items: { ...cashSale }, total: currentCashSaleTotal, synced: result.ok }]);

    if (!result.ok) {
      alert(`Cash Sale Saved locally: ₹${currentCashSaleTotal}\n⚠️ Could NOT sync to Supabase (${result.error?.message || "unknown error"}). This entry is marked unsynced — please check your connection and try re-entering it once online, or note it down for manual reconciliation.`);
    } else {
      alert(`Cash Sale Saved: ₹${currentCashSaleTotal}`);
    }

    if (result.ok) refreshDailyStockAndTotals(); // pull the authoritative post-save totals right away

    setCashSale(createEmptyItems());
  };

  // =========================
  //        PAYTM SALE
  // =========================

  const changePaytmQuantity = ( item, change ) => {
    setPaytmSale((current) => ({ ...current, [item]: Math.max( 0, Math.min( availableStock[item], current[item] + change ) ), }));
  };

  const setPaytmQuantity = ( item, value ) => {
    let quantity = Math.max(0, Number(value) || 0);
    if (quantity > availableStock[item]) { quantity = availableStock[item]; }
    setPaytmSale((current) => ({ ...current, [item]: quantity, }));
  };

  const currentPaytmSaleTotal = Object.entries(paytmSale).reduce( (total, [item, quantity]) => total + quantity * prices[item], 0 );
  
  const savePaytmSale = async () => {
    if (currentPaytmSaleTotal === 0) {
      alert("Please enter at least one item.");
      return;
    }
    setPaytmSoldStock((currentSold) => {
      const updated = { ...currentSold };
      Object.keys(paytmSale).forEach( (item) => { updated[item] = currentSold[item] + paytmSale[item]; } );
      return updated;
    });

    setPaytmTotal((total) => total + currentPaytmSaleTotal);

    const result = await saveSaleToSupabase("upi", paytmChannel === "UPI" ? "upi" : "paytm", paytmSale, currentPaytmSaleTotal);

    // Same reasoning as Cash Sale — payment was already received digitally,
    // so we flag as unsynced rather than rolling back.
    setPaytmRecords((records) => [...records, { id: Date.now(), date: new Date().toISOString(), items: { ...paytmSale }, total: currentPaytmSaleTotal, channel: paytmChannel, synced: result.ok }]);

    if (!result.ok) {
      alert(`${paytmChannel} Sale Saved locally: ₹${currentPaytmSaleTotal}\n⚠️ Could NOT sync to Supabase (${result.error?.message || "unknown error"}). This entry is marked unsynced — please check your connection and reconcile manually if needed.`);
    } else {
      alert(`${paytmChannel} Sale Saved: ₹${currentPaytmSaleTotal}`);
    }

    if (result.ok) refreshDailyStockAndTotals();

    setPaytmSale(createEmptyItems());
  };




  const [customerSession, setCustomerSession] = useState(undefined); // undefined = still checking
  const [showCustomerPortal, setShowCustomerPortal] = useState(false);

  // Whether THIS browser/device is logged in as staff. Persisted so staff don't have to
  // log in again every time they reopen the app on their own device — but a brand-new
  // device (any customer's phone) always starts as `false` and lands on Book Order.
  const [isStaff, setIsStaff] = usePersistentState("sweet-is-staff", false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);

  useEffect(() => {
    supabaseAuth.auth.getSession().then(({ data }) => setCustomerSession(data.session));
    const { data: listener } = supabaseAuth.auth.onAuthStateChange((_event, session) => {
      setCustomerSession(session);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Book Order is the app's public landing page — anyone opening the app for the first
  // time (or any customer's own device) lands here. Staff only see the admin dashboard
  // after logging in via the Staff Login link below, and that login is remembered on
  // their device from then on (see `isStaff` above). Staff can also jump back into this
  // view on purpose (to preview it, or book on behalf of a walk-in) via `showCustomerPortal`.
  if (!isStaff || showCustomerPortal) {
    return (
      <>
        <CustomerPortal
          session={customerSession}
          onExit={isStaff && !customerSession ? () => setShowCustomerPortal(false) : undefined}
          onStaffLoginClick={() => setShowAdminLogin(true)}
        />
        {showAdminLogin && (
          <AdminLogin
            onCancel={() => setShowAdminLogin(false)}
            onSuccess={() => { setIsStaff(true); setShowCustomerPortal(false); setShowAdminLogin(false); }}
          />
        )}
      </>
    );
  }


  // =========================
  //             APP
  // =========================

  return (
    <div className="app" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} >
      <button className="mobile-menu-button" onClick={() => setMobileMenuOpen(true)} aria-label="Open navigation menu" aria-expanded={mobileMenuOpen} >
        ☰
      </button>
      <button
        className={`sidebar-overlay ${mobileMenuOpen ? "show" : ""}`}
        onClick={() => setMobileMenuOpen(false)}
        aria-label="Close navigation menu"
        tabIndex={mobileMenuOpen ? 0 : -1}
      />

      <aside className={`sidebar ${mobileMenuOpen ? "mobile-open" : ""}`} aria-label="Main navigation" >
        <button className="mobile-close-button" onClick={() => setMobileMenuOpen(false)} aria-label="Close navigation menu" >
          ×
        </button>
        <div className="logo">
          <h2>🍬 Sweet Accounts</h2>
        </div>

        <nav>
          <button className={page === "dashboard" ? "active" : ""} onClick={() => navigateTo("dashboard")}>📊 Dashboard</button>
          <button className={ page === "receive" ? "active" : "" } onClick={() => navigateTo("receive") } >
            📦 Receive
          </button>

          <button className={ page === "cash" ? "active" : "" } onClick={() => navigateTo("cash") } >
            💵 Cash Sale
          </button>

          <button className={ page === "paytm" ? "active" : "" } onClick={() => navigateTo("paytm") } >
            📱 Paytm Sale
          </button>
  
          <button
            className={ (page === "credit" || page === "individual-credit") ? "active" : "" }
            onClick={() => navigateTo("credit")}
          >
            📋 Credit Sale
          </button>

          <button className={page === "payment" ? "active" : ""} onClick={() => navigateTo("payment")}>💰 Credit Recovery</button>
          <button className={page === "donations" ? "active" : ""} onClick={() => navigateTo("donations")}>🙏 Donations</button>
          <button className={page === "orders" ? "active" : ""} onClick={() => navigateTo("orders")}>📦 Book Orders</button>
          <button className={page === "reports" ? "active" : ""} onClick={() => navigateTo("reports")}>📄 Reports</button>
          <button className={page === "close" ? "active" : ""} onClick={() => navigateTo("close")}>🔒 Close Day</button>
          <button className={page === "reset" ? "active" : ""} onClick={() => navigateTo("reset")}>🧹 Reset Data</button>
          <button className={page === "export" ? "active" : ""} onClick={handleGoogleSheetExport} disabled={exporting} > 📊 {exporting ? "Exporting..." : "Export to Google Sheet"} </button>
          <button className="customer-portal-link" onClick={() => setShowCustomerPortal(true)}>🛒 Preview Customer Book Order</button>
          <button className="customer-portal-link" onClick={() => setIsStaff(false)}>🔒 Staff Logout</button>

        </nav>
      </aside>

      <main className="main-content enter-next-page" onKeyDown={handlePageEnter}>

        {page === "dashboard" && (<>
          <header className="page-header"><div><h1>📊 Dashboard</h1><p>--------------------------</p></div><div className="today-date">📅 {today}</div></header>
          <section className="report-grid">
            <div
              className={`report-card opening-stock-card ${ expandedCard === "opening" ? "expanded" : "" }`}
              onClick={() => setExpandedCard( expandedCard === "opening" ? null : "opening" ) }
              style={{ cursor: "pointer" }}
            >
              <span> Opening Stock Value{" "} {expandedCard === "opening" ? "▲" : "▼"} </span>
              <strong>₹ {openingStockValue}</strong>
              {expandedCard === "opening" && (
                <div
                  className="opening-stock-details"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="opening-stock-header">
                    <strong>Sweet</strong> <strong>Qty</strong> <strong>Rate</strong> <strong>Amount</strong>
                  </div>

                  {Object.keys(prices)
                    .filter((item) => Number(openingStock[item] || 0) > 0)
                    .map((item) => { const quantity = Number(openingStock[item] || 0); const rate = Number(prices[item] || 0); const amount = quantity * rate;
                    return (
                      <div className="opening-stock-row" key={item} >
                        <span>{item}</span> <span>{quantity}</span> <span>₹ {rate}</span>
                        <strong>₹ {amount}</strong>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div
              className={`report-card received-stock-card ${ expandedCard === "received" ? "expanded" : "" }`}
              onClick={() => setExpandedCard( expandedCard === "received" ? null : "received" ) }
              style={{ cursor: "pointer" }}
            >
              <span> Received Stock Value{" "} {expandedCard === "received" ? "▲" : "▼"} </span>
              <strong> ₹ {receivedTotal} </strong>
              {expandedCard === "received" && (
                <div
                  className="received-stock-details"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="received-stock-header">
                    <strong>Sweet</strong> <strong>Qty</strong> <strong>Rate</strong> <strong>Amount</strong>
                  </div>
                  {Object.keys(prices)
                    .filter( (item) => Number(receivedStock[item] || 0) > 0 )
                    .map((item) => { const quantity = Number( receivedStock[item] || 0 ); const rate = Number(prices[item] || 0);
                      const amount = quantity * rate;
                      return (
                        <div className="received-stock-row" key={item} >
                          <span>{item}</span> <span>{quantity}</span> <span>₹ {rate}</span>
                          <strong>₹ {amount}</strong>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
            <div
              className={`report-card cash-sales-card ${ expandedCard === "cash" ? "expanded" : "" }`}
              onClick={() => setExpandedCard( expandedCard === "cash" ? null : "cash" ) }
              style={{ cursor: "pointer" }}
            >
              <span> Cash Sales{" "} {expandedCard === "cash" ? "▲" : "▼"} </span>
              <strong> ₹ {cashTotal} </strong>
              {expandedCard === "cash" && (
                <div
                  className="cash-sales-details"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="cash-sales-header">
                    <strong>Sweet</strong> <strong>Qty</strong> <strong>Rate</strong> <strong>Amount</strong>
                  </div>
                  {Object.keys(prices)
                    .filter( (item) => Number(cashSoldStock[item] || 0) > 0 )
                    .map((item) => { const quantity = Number( cashSoldStock[item] || 0 ); const rate = Number( prices[item] || 0 );
                      const amount = quantity * rate;
                      return (
                        <div
                          className="cash-sales-row"
                          key={item}
                        >
                          <span>{item}</span> <span>{quantity}</span> <span>₹ {rate}</span>
                          <strong>₹ {amount}</strong>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
            <div
              className={`report-card paytm-sales-card ${ expandedCard === "paytm" ? "expanded" : "" }`}
              onClick={() => setExpandedCard( expandedCard === "paytm" ? null : "paytm" ) }
              style={{ cursor: "pointer" }}
            >
              <span> Paytm Sales{" "} {expandedCard === "paytm" ? "▲" : "▼"} </span>
              <strong> ₹ {paytmTotal} </strong>
              {expandedCard === "paytm" && (
                <div
                  className="paytm-sales-details"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="paytm-sales-header">
                    <strong>Sweet</strong> <strong>Qty</strong> <strong>Rate</strong> <strong>Amount</strong>
                  </div>
                  {Object.keys(prices)
                    .filter( (item) => Number(paytmSoldStock[item] || 0) > 0 )
                    .map((item) => { const quantity = Number( paytmSoldStock[item] || 0 ); const rate = Number( prices[item] || 0 );
                      const amount = quantity * rate;
                      return (
                        <div
                          className="paytm-sales-row"
                          key={item}
                        >
                          <span>{item}</span> <span>{quantity}</span> <span>₹ {rate}</span>
                          <strong>₹ {amount}</strong>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            <div
              className={`report-card credit-period-card ${ expandedCard === "credit-sales-menu" ? "expanded" : "" }`}
              onClick={() => setExpandedCard( expandedCard === "credit-sales-menu" ? null : "credit-sales-menu" ) }
              style={{ cursor: "pointer" }}
            >
              <span> Credit Sales{" "} {expandedCard === "credit-sales-menu" ? "▲" : "▼"} </span>
              <strong>
                ₹ {departmentCreditTotal + individualCreditTotal}
              </strong>
              {expandedCard === "credit-sales-menu" && (
                <div
                  className="credit-sales-details"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="credit-sales-header">
                    <strong>Sweet</strong> <strong>Qty</strong> <strong>Rate</strong> <strong>Amount</strong>
                  </div>
                  {Object.keys(prices)
                    .filter((item) => Number(departmentCreditStock[item] || 0) + Number(individualCreditStock[item] || 0) > 0)
                    .map((item) => {
                      const quantity = Number(departmentCreditStock[item] || 0) + Number(individualCreditStock[item] || 0);
                      const rate = Number(prices[item] || 0);
                      const amount = quantity * rate;
                      return (
                        <div className="credit-sales-row" key={item}>
                          <span>{item}</span> <span>{quantity}</span> <span>₹ {rate}</span>
                          <strong>₹ {amount}</strong>
                        </div>
                      );
                    })}
                  {Object.keys(prices).every((item) => Number(departmentCreditStock[item] || 0) + Number(individualCreditStock[item] || 0) === 0) && (
                    <p>No credit sales recorded yet today.</p>
                  )}
                  <p className="credit-sales-details-footnote">
                    See the Department Credit and Individual Credit reports under 📄 Reports for full details.
                  </p>
                </div>
              )}
            </div>

            <div className="report-card">
              <span>Dept Cash Recovery</span>
              <strong>₹ {departmentCashReceivedToday}</strong>
            </div>

            <div className="report-card">
              <span>Individual Cash Recovery</span>
              <strong>₹ {individualCashReceivedToday}</strong>
            </div>

            <div className="report-card">
              <span>Dept Paytm Recovery</span>
              <strong>₹ {departmentPaytmReceivedToday}</strong>
            </div>

            <div className="report-card">
              <span>Individual Paytm Recovery</span>
              <strong>₹ {individualPaytmReceivedToday}</strong>
            </div>

            <div className="report-card">
              <span>Dept T.R. Recovery</span>
              <strong>₹ {departmentTrReceivedToday}</strong>
            </div>

            <div className="report-card">
              <span>Individual T.R. Recovery</span>
              <strong>₹ {individualTrReceivedToday}</strong>
            </div>

            <div className="report-card">
              <span>Cash to Deposit</span>
              <strong>₹ {cashToDeposit}</strong>
            </div>

            <div className="report-card">
              <span>Total Paytm Collection</span>
              <strong>₹ {totalPaytmCollection}</strong>
            </div>

            <div className="report-card">
              <span>Total T.R. Collection</span>
              <strong>₹ {totalTrCollection}</strong>
            </div>

            <div
              className={`report-card closing-stock-card ${ expandedCard === "closing" ? "expanded" : "" }`}
              onClick={() => setExpandedCard( expandedCard === "closing" ? null : "closing" ) }
              style={{ cursor: "pointer" }}
            >
              <span> Expected Closing Stock Value{" "} {expandedCard === "closing" ? "▲" : "▼"} </span>
              <strong>₹ {closingStockValue}</strong>
              {expandedCard === "closing" && (
                <div
                  className="closing-stock-details"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="closing-stock-header">
                    <strong>Sweet</strong> <strong>Qty</strong> <strong>Rate</strong> <strong>Amount</strong>
                  </div>

                  {Object.keys(prices)
                    .filter((item) => Number(availableStock[item] || 0) > 0)
                    .map((item) => { const quantity = Number(availableStock[item] || 0); const rate = Number(prices[item] || 0);
                    const amount = quantity * rate;
                    return (
                      <div
                        className="closing-stock-row"
                        key={item}
                      >
                        <span>{item}</span> <span>{quantity}</span> <span>₹ {rate}</span>
                        <strong>₹ {amount}</strong>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </section>
          <section className="batch-card">
            <h2>🙏 Today's Bhoga Donations ({todaysBhogaDonations.length})</h2>

            {todaysBhogaDonations.length === 0 && <p>No Bhoga donations recorded for today yet.</p>}

            {todaysBhogaDonations.map((d) => (
              <div className="item-row bhoga-donation-row" key={d.id}>
                <div className="item-name">
                  <strong>{d.donorName} — {d.bhogeType}</strong>
                  <span>TR: {d.trNo} · Preacher: {d.preacherName} · {d.verifiedByAsst ? "✓ Verified" : "Pending verification"}</span>
                  <div className="bhoga-proof-row">
                    <span className={`bhoga-proof-badge ${todaysAutoSweetIssueByBhoga[d.bhogeType] ? "green" : "amber"}`}>
                      {todaysAutoSweetIssueByBhoga[d.bhogeType]
                        ? `🏭 Sweet issue auto-recorded — ₹ ${todaysAutoSweetIssueByBhoga[d.bhogeType].amount}`
                        : "🏭 Sweet issue not yet auto-recorded"}
                    </span>
                    <button
                      type="button"
                      className={`bhoga-proof-badge bhoga-proof-btn ${d.deliveredToDonor ? "green" : "amber"}`}
                      onClick={() => handleToggleDeliveredToDonor(d.id, d.deliveredToDonor)}
                      title={d.deliveredToDonor ? "Click to mark as not yet delivered" : "Click to mark as delivered to donor"}
                    >
                      {d.deliveredToDonor ? `📦 Delivered to donor — ₹ ${d.amount}` : "📦 Not yet delivered — click at counter"}
                    </button>
                  </div>
                </div>
                <strong className="amount">₹ {d.amount}</strong>
              </div>
            ))}

            {todaysBhogaDonations.length > 0 && (
              <div className="daily-credit-total" style={{ marginTop: 12 }}>
                <h2>Today's Bhoga Total: ₹ {todaysBhogaDonations.reduce((a, d) => a + (+d.amount || 0), 0)}</h2>
              </div>
            )}
          </section>

          <section className="batch-card">
            <h2>Recent Transactions</h2>
            <p style={{ fontSize: 12, color: "var(--muted)", marginTop: -8 }}>Synced from Supabase — visible on every device</p>

            {[...cloudRecentTransactions,
              ...cashRecords.filter(r => r.synced === false).map(r=>({...r,type:"💵 Cash Sale (⚠️ unsynced)",amount:r.total||r.amount||0})),
              ...paytmRecords.filter(r => r.synced === false).map(r=>({...r,type:`${r.channel||"Paytm"} Sale (⚠️ unsynced)`,amount:r.total||r.amount||0})),
              ...departmentPayments.filter(r => r.synced === false).map(r=>({...r,type:`💰 Recovery — ${r.mode||"Cash"} (⚠️ unsynced)`,amount:r.amount||0})),
            ].sort((a,b)=>new Date(b.timestamp||b.date||0)-new Date(a.timestamp||a.date||0)).slice(0,8).map((r,i)=><div className="item-row" key={r.id||i}><div className="item-name"><strong>{r.type}</strong><span>{(() => { const dateValue = r.timestamp || r.date; if (!dateValue) return "Current day"; const date = new Date(dateValue); if (Number.isNaN(date.getTime())) return String(dateValue); return date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); })()}</span></div><strong className="amount">₹ {r.amount}</strong></div>)}
            {cloudRecentTransactions.length===0 && cashRecords.filter(r=>r.synced===false).length===0 && paytmRecords.filter(r=>r.synced===false).length===0 && departmentPayments.filter(r=>r.synced===false).length===0 && <p>No transactions recorded yet today.</p>}
          </section></>)}


        {page === "close" && (
          <>
            <header className="page-header">
              <div>
                <h1>🔒 Close Day</h1>
                <p>Archive the complete business day and carry stock forward</p>
              </div>
            </header>

            <section className="batch-card receive-correction-form">
              <h2>Closing Summary</h2>

              <div className="item-row">
                <span>Opening + Received</span>
                <strong>
                  ₹ {openingStockValue + receivedTotal}
                </strong>
              </div>

              <div className="item-row">
                <span>Total Outgoing</span>
                <strong>
                  ₹ {outgoingValue}
                </strong>
              </div>

              <div className="item-row">
                <span>Closing Stock Value</span>
                <strong>
                  ₹ {closingStockValue}
                </strong>
              </div>

              <button className="save-sale-button" onClick={closeDay} >
                🔒 Close Business Day
              </button>

              <p>
                Review the figures before closing. Closing archives all current-day data.
              </p>
            </section>
          </>
        )}

        {/* *******************************  RESET DATA — for trials/testing  *************************************** */}

        {page === "reset" && (
          <>
            <header className="page-header">
              <div>
                <h1>🧹 Reset Data</h1>
                <p>For trials and testing — wipe data and start with a clean slate</p>
              </div>
            </header>

            <section className="batch-card">
              <h2>⚠️ Clear Transactional Data</h2>
              <p>
                Deletes all sales, donations, credit sales, recovery payments, ledger entries,
                daily reports, and inventory records from Supabase — but keeps master data
                (sweets, departments, account holders, carriers, Bhoga types, preachers) intact.
                Also clears this device's local cache.
              </p>
              <button className="save-sale-button" style={{ background: "linear-gradient(135deg, #e05555, #ff6b00)" }} onClick={() => handleResetAllData(false)}>
                🧹 Clear Transactional Data Only
              </button>
            </section>

            <section className="batch-card">
              <h2>☢️ Clear Everything (Including Master Data)</h2>
              <p>
                Deletes everything above, PLUS all master data — sweets, departments, account
                holders, carriers, Bhoga types, and preachers. Use this for a fully clean slate
                between test data sets. Master data will be re-seeded from the app's built-in
                defaults the next time you use each page.
              </p>
              <button className="save-sale-button" style={{ background: "linear-gradient(135deg, #7a0000, #e05555)" }} onClick={() => handleResetAllData(true)}>
                ☢️ Clear Everything Including Master Data
              </button>
            </section>
          </>
        )}

       {/* ******************************************* RECEIVE **************************************** */}

        {page === "receive" && (
          <>
            <header className="page-header">
              <div> <h1>Receive Sweets</h1> <p> Mahaprasad Sweets received & auto recorded at set times </p> </div>
              <div className="today-date"> 📅 Today: {today} </div>
            </header>

            {/* ---------- (a) RECEIVE CORRECTION TABLE ---------- */}
            <section className="grand-total" style={{ marginBottom: 12 }}>
              <span> Received Total </span>
              <strong> ₹ {receivedTotal} </strong>
            </section>

            <section className="batch-card">
              <div className="batch-header">
                <h2>🧾 Receive Transactions </h2>
              </div>
              <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -8 }}>
                Each scheduled batch is added automatically the moment its time arrives. If a count was wrong, tap Edit on that row, fix the quantities, and Save.
              </p>

              <div className="adjust-table-wrap">
                <table className="adjust-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Status</th>
                      {Object.keys(prices).map((name) => <th key={name}>{name}</th>)}
                      <th>Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((batch, scheduleIndex) => {
                      const isEditing = editingReceiptIndex === scheduleIndex;
                      const rowItems = isEditing ? editDraftItems : batch.items;
                      const rowTotal = calculateBatchTotal(rowItems);
                      return (
                        <tr key={batch.time}>
                          <td style={{ whiteSpace: "nowrap", color: "var(--gold-light)" }}>{batch.time}</td>
                          <td>{batch.received ? "✓ Received" : "⏳ Pending"}</td>
                          {Object.keys(prices).map((name) => (
                            <td key={name}>
                              {isEditing ? (
                                <input
                                  type="number" min="0" style={{ width: 60 }}
                                  value={rowItems[name] || ""}
                                  onChange={(e) => updateEditDraftItem(name, e.target.value)}
                                  onKeyDown={(event) => handleEnterWithin(event, ".receive-correction-form input[type='number']:not(:disabled)")}
                                />
                              ) : (
                                rowItems[name] || 0
                              )}
                            </td>
                          ))}
                          <td><strong>₹ {rowTotal}</strong></td>
                          <td>
                            {!batch.received ? null : isEditing ? (
                              <div className="adjust-actions">
                                <button className="adjust-btn-primary" onClick={() => saveReceiptCorrection(scheduleIndex)}>💾 Save</button>
                                <button className="adjust-btn-discard" onClick={cancelEditReceipt}>Cancel</button>
                              </div>
                            ) : (
                              <button className="adjust-btn-ghost" onClick={() => startEditReceipt(scheduleIndex)}>✏️ Edit</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ---------- (b) ADJUST STOCK ---------- */}
            <button
              className="save-sale-button"
              style={{ background: "linear-gradient(135deg, var(--surface), var(--border))", marginTop: 20 }}
              onClick={() => { setShowAdjustBox((v) => !v); if (!showAdjustBox && adjustmentRows.length === 0) addAdjustmentRow(); }}
            >
              🛠️ Adjust Stock
            </button>

            {showAdjustBox && (
              <section className="batch-card stock-adjustment-form" style={{ marginTop: 15 }}>
                <div className="batch-header">
                  <h2>🛠️ Stock Adjustment</h2>
                </div>
                <p style={{ color: "var(--muted)", fontSize: 13, marginTop: -8 }}>
                  Use this for corrections after receiving — miscounts, damage, or wastage. Each row is saved as its own permanent record; there's no undo, so double-check before saving.
                </p>

                <div className="adjust-table-wrap">
                  <table className="adjust-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Type</th>
                        {Object.keys(prices).map((name) => <th key={name}>{name}</th>)}
                        <th>Reason</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {adjustmentRows.map((row) => (
                        <tr key={row.id}>
                          <td style={{ whiteSpace: "nowrap", color: "var(--gold-light)" }}>{row.time}</td>
                          <td>
                            <select value={row.adjustmentType} onChange={(e) => updateAdjustmentRowField(row.id, "adjustmentType", e.target.value)}>
                              <option value="addition">➕ Addition</option>
                              <option value="reduction">➖ Reduction</option>
                              <option value="damage">🗑️ Damage</option>
                              <option value="wastage">♻️ Wastage</option>
                            </select>
                          </td>
                          {Object.keys(prices).map((name) => (
                            <td key={name}>
                              <input
                                type="number"
                                style={{ width: 60 }}
                                value={row.items[name] || ""}
                                onChange={(e) => updateAdjustmentRowItem(row.id, name, e.target.value)}
                                onKeyDown={(event) => handleEnterWithin(event, ".stock-adjustment-form input[type='number']:not(:disabled)")}
                              />
                            </td>
                          ))}
                          <td>
                            <input
                              type="text"
                              style={{ width: 140 }}
                              placeholder="Reason..."
                              value={row.reason}
                              onChange={(e) => updateAdjustmentRowField(row.id, "reason", e.target.value)}
                            />
                          </td>
                          <td>
                            <div className="adjust-actions">
                              <button className="adjust-btn-primary" onClick={() => saveAdjustmentRow(row.id)}>💾 Save</button>
                              <button className="adjust-btn-discard" onClick={() => discardAdjustmentRow(row.id)}>Discard</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <button type="button" className="adjust-btn-ghost" onClick={addAdjustmentRow}>
                  + Add Another Row
                </button>
              </section>
            )}

            {/* ---------- (c) RECENT RECEIVE TRANSACTIONS ---------- */}
            <section className="batch-card" style={{ marginTop: 15 }}>
              <div className="batch-header">
                <h2>🕘 Recent Receive Transactions</h2>
              </div>

              {schedule.filter((b) => b.received).length === 0 && (
                <p style={{ color: "var(--muted)", fontSize: 13 }}>No batches received yet today.</p>
              )}

              {[...schedule]
                .map((batch, originalIndex) => ({ batch, originalIndex }))
                .filter(({ batch }) => batch.received)
                .reverse()
                .map(({ batch, originalIndex }) => (
                  <div className="item-row" key={batch.time + "-" + originalIndex}>
                    <div className="item-name">
                      <strong>{batch.time}</strong>
                      <span>
                        {Object.entries(batch.items)
                          .filter(([, qty]) => qty > 0)
                          .map(([name, qty]) => `${qty} ${name}`)
                          .join(", ") || "No items"}
                      </span>
                    </div>
                    <strong className="amount"> ₹ {calculateBatchTotal(batch.items)} </strong>
                  </div>
                ))}
            </section>
          </>
        )}

        {/* *************************************   CASH   ****************************************** */}

        {page === "cash" && (
          <>
            <header className="page-header">
              <div> <h1>💵 Cash Sale</h1> <p>Sell sweets for cash</p> </div>
              <div className="today-date"> 📅 Today: {today} </div>
            </header>

            <section className="batch-card cash-sale-form">
              {Object.keys(prices).map( (item) => ( <div className="item-row" key={item} >
                    <div className="item-name">
                      <strong>{item}</strong>
                      <span> Available:{" "} {availableStock[item]} {" | "}₹ {prices[item]} each </span>
                    </div>
                    <div className="quantity-control">
                      <button onClick={() => changeCashQuantity( item, -1 ) } >
                        −
                      </button>

                      <input
                        type="number" min="0" max={availableStock[item]} value={cashSale[item]}
                        onChange={(event) => setCashQuantity( item, event.target.value ) }
                        onKeyDown={(event) => handleEnterWithin(event, ".cash-sale-form input[type='number']:not(:disabled)")}
                      />
                      <button onClick={() => changeCashQuantity( item, 1 ) } >
                        +
                      </button>
                    </div>
                    <strong className="amount"> ₹{" "} {cashSale[item] * prices[item]} </strong>
                  </div>
                )
              )}

            </section>
            <section className="grand-total">
              <span>Current Cash Sale</span>
              <strong> ₹ {currentCashSaleTotal} </strong>
            </section>

            <button className="save-sale-button" onClick={saveCashSale} > 💾 Save Cash Sale </button>
            <section className="cash-summary">
              <span> Today's Cash Sales Saved </span>
              <strong> ₹ {cashTotal} </strong>
            </section>
          </>
        )}

        {/* ************************************* PAYTM *********************************************** */}

        {page === "paytm" && (
          <>
            <header className="page-header">
              <div> <h1>📱 Paytm Sale</h1> <p>Sell sweets through Paytm</p> </div>
              <div className="today-date"> 📅 Today: {today} </div>
            </header>
            <section className="batch-card paytm-card paytm-sale-form">
              {Object.keys(prices).map(
                (item) => (
                  <div
                    className="item-row"
                    key={item}
                  >
                    <div className="item-name">
                      <strong>{item}</strong>
                      <span> Available:{" "} {availableStock[item]} {" | "}₹ {prices[item]} each </span>
                    </div>
                    <div className="quantity-control">
                      <button onClick={() => changePaytmQuantity( item, -1 ) } >
                        −
                      </button>

                      <input
                        type="number" min="0" max={availableStock[item]} value={paytmSale[item]}
                        onChange={(event) => setPaytmQuantity( item, event.target.value ) }
                        onKeyDown={(event) => handleEnterWithin(event, ".paytm-sale-form input[type='number']:not(:disabled)")}
                      />
                      <button onClick={() => changePaytmQuantity( item, 1 ) } >
                        +
                      </button>
                    </div>
                    <strong className="amount"> ₹{" "} {paytmSale[item] * prices[item]} </strong>
                  </div>
                )
              )}
            </section>

            <section className="paytm-current-total">
              <span>Current Paytm Sale</span>
              <strong> ₹ {currentPaytmSaleTotal} </strong>
            </section>

            <div className="paytm-channel-toggle">
              <span>Payment Channel:</span>
              <div className="paytm-channel-buttons">
                {["Paytm", "UPI"].map((ch) => (
                  <button key={ch} type="button" className={paytmChannel === ch ? "active" : ""} onClick={() => setPaytmChannel(ch)} >
                    {ch}
                  </button>
                ))}
              </div>
            </div>
            <button className="save-sale-button paytm-button" onClick={savePaytmSale} >
              💾 Save {paytmChannel} Sale
            </button>

            <section className="cash-summary paytm-summary">
              <span> Today's Paytm Sales Saved </span>
              <strong> ₹ {paytmTotal} </strong>
            </section>
          </>
        )}

        {page === "credit" && (
          <DepartmentCredit
            availableStock={availableStock}
            setDepartmentCreditStock={setDepartmentCreditStock}
            onSave={performDepartmentCreditSave}
            onGoToIndividualCredit={() => navigateTo("individual-credit")}
          />
        )}

        {page === "individual-credit" && (
          <IndividualCredit
            availableStock={availableStock}
            setIndividualCreditStock={setIndividualCreditStock}
            onGoToDepartmentCredit={() => navigateTo("credit")}
            onSave={async (transaction) => {
              const ledgerEntry = { ...transaction, amount: transaction.totalAmount || 0, kind: "credit" };
              setIndividualCreditRecords((records) => [...records, transaction]);
              setIndividualLedger((ledger) => [...ledger, ledgerEntry]);

              const result = await saveCreditSaleToSupabase({
                saleType: "individual_credit", debtorName: transaction.individualName, debtorMobile: transaction.mobile,
                referenceType: transaction.referenceType, referenceName: transaction.referenceName,
                items: transaction.items, totalAmount: transaction.totalAmount, notes: transaction.purpose,
              });

              if (!result.ok) {
                setIndividualCreditRecords((records) => records.filter((r) => r !== transaction));
                setIndividualLedger((ledger) => ledger.filter((l) => l !== ledgerEntry));
                alert(`❌ Could not save this Individual Credit to Supabase (${result.error?.message || "unknown error"}). Nothing was recorded — please try again.`);
              } else {
                refreshDailyStockAndTotals();
                refreshDues();
              }
              return result;
            }}
          />
        )}

        {page === "donations" && <Donations />}

        {page === "orders" && <Orders />}

        {page === "payment" && (
          <>
            <header className="page-header">
              <div>
                <h1>💰 Credit Recovery</h1>
                <p> Recover a department or individual due by Cash, Paytm or T.R. This never changes stock. </p>
              </div>
              <div className="today-date"> Cash to deposit: ₹ {cashToDeposit} </div>
            </header>

            <section className="batch-card recovery-form">
              <h2>Record Recovery</h2>

              <div className="item-row"><div className="item-name"><strong>Recovery For</strong><span>Select whose credit due is being recovered</span></div><select value={recoveryType} onChange={(e)=>{setRecoveryType(e.target.value);setPaymentDepartment("");setPaymentIndividual("");}}><option>Department</option><option>Individual</option></select></div>
              <div className="item-row"><div className="item-name"><strong>{recoveryType}</strong><span>Choose the {recoveryType.toLowerCase()} whose due will be reduced</span></div><select value={recoveryType === "Individual" ? paymentIndividual : paymentDepartment} onChange={(e)=> recoveryType === "Individual" ? setPaymentIndividual(e.target.value) : setPaymentDepartment(e.target.value)}><option value="">Select {recoveryType.toLowerCase()}</option>{Object.entries(recoveryType === "Individual" ? individualDues : departmentDues).filter(([,due])=>due>0).map(([name,due])=><option key={name} value={name}>{name} — Due ₹ {due}</option>)}</select></div>

              <div className="item-row">
                <div className="item-name">
                  <strong>Recovery Mode</strong>
                  <span> Collection stays separate by mode </span>
                </div>
                <select
                  value={paymentMode}
                  onChange={(e) => setPaymentMode(e.target.value) }
                >
                  <option>Cash</option> <option>Paytm</option> <option>T.R.</option>
                </select>
              </div>
              <div className="item-row">
                <div className="item-name">
                  <strong>Received From</strong>
                  <span> Identify who actually paid </span>
                </div>

                <select
                  value={payerType}
                  onChange={(e) => setPayerType(e.target.value) }
                >
                  <option>Department</option> <option>Account Holder</option> <option>Carrier</option>
                </select>
              </div>
            <div className="item-row">
              <div className="item-name">
                <strong>Payer Name</strong>
                <span>Select the person who actually paid</span>
              </div>

              {payerType === "Department" ? (
                <>
                  <input
                    list="department-payer-list"
                    value={payerName}
                    onChange={(e) => { setPayerName(e.target.value); setPayerMobile(""); }}
                    placeholder="Type department name"
                  />

                  <datalist id="department-payer-list">
                    {Object.keys(departmentDues)
                      .filter((department) => department .toLowerCase() .includes(payerName.toLowerCase()) )
                      .map((department) => (
                        <option key={department} value={department} />
                      ))}
                  </datalist>
                </>
              ) : (
                <>
                  <input
                    list="payer-name-list"
                    value={payerName}
                    onChange={(e) => {
                      const selectedName = e.target.value;
                      setPayerName(selectedName);
                      const selectedPerson = payers.find(
                        (person) => person.name === selectedName
                      );
                      setPayerMobile(selectedPerson?.mobile || "");
                    }}
                    placeholder={`Type ${payerType} name`}
                  />

                  <datalist id="payer-name-list">
                    {payers
                      .filter((person) => person.name .toLowerCase() .includes(payerName.toLowerCase()) )
                      .map((person, index) => (
                        <option key={`${person.name}-${person.mobile}-${index}`} value={person.name} />
                      ))}
                  </datalist>
                </>
              )}
            </div>

            <div className="item-row">
              <div className="item-name">
                <strong>Payer Mobile</strong>
                <span>Optional — enter or correct mobile number if needed</span>
              </div>

              <input
                type="tel"
                value={payerMobile}
                onChange={(e) => setPayerMobile(e.target.value)}
                placeholder="Mobile Number (Optional)"
              />
            </div>

            <div className="item-row"><div className="item-name"><strong>Amount Received</strong><span>Automatically reduces the selected department's due</span></div><input type="number" min="1" value={paymentAmount} onChange={(e)=>setPaymentAmount(e.target.value)} onKeyDown={(event) => handleEnterWithin(event, ".recovery-form input[type='number']:not(:disabled)")} placeholder="Amount" /></div>
            <button className="save-sale-button" onClick={saveDepartmentPayment}>💾 Save Department Recovery</button>
          </section>
          <section className="report-grid"><div className="report-card"><span>Cash Recovery Today</span><strong>₹ {departmentCashReceivedToday}</strong></div><div className="report-card"><span>Paytm Recovery Today</span><strong>₹ {departmentPaytmReceivedToday}</strong></div><div className="report-card"><span>T.R. Recovery Today</span><strong>₹ {departmentTrReceivedToday}</strong></div></section>
          <section className="batch-card"><h2>Department Ledgers</h2>{Object.entries(departmentDues).map(([department,due])=><div className="item-row" key={department}><div className="item-name"><strong>{department}</strong><span>Net due after all Cash, Paytm and T.R. recoveries</span></div><strong className="amount">₹ {due}</strong></div>)}{Object.keys(departmentDues).length===0 && <p>No department credit recorded yet.</p>}</section>
          <section className="batch-card">
            <h2>Today's Recoveries</h2>
            <p style={{ fontSize: 12, color: "var(--muted)", marginTop: -8 }}>Synced from Supabase — visible on every device</p>
            {recoveriesToday.map((p) => (
              <div className="item-row" key={p.id}>
                <div className="item-name">
                  <strong>
                    {(p.recoveryType === "Individual" ? p.individualName : p.department) || "—"} — {p.mode}
                    {p.synced === false ? " (⚠️ unsynced)" : ""}
                  </strong>
                  <span>
                    {p.payerName ? `${p.payerType || "Paid by"}: ${p.payerName} · ` : ""}
                    {(() => {
                      const d = p.date ? new Date(p.date) : null;
                      return d && !Number.isNaN(d.getTime())
                        ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
                        : (p.date || "");
                    })()}
                  </span>
                </div>
                <strong className="amount">₹ {p.amount}</strong>
              </div>
            ))}
            {recoveriesToday.length === 0 && <p>No recoveries recorded today.</p>}
          </section>
        </>)}     

        {page === "reports" && (
          <>
            <div className="reports-subnav">
              <button className={reportsView === "daily" ? "active" : ""} onClick={() => setReportsView("daily")}>🧾 Daily Report</button>
              <button className={reportsView === "cash-sale" ? "active" : ""} onClick={() => setReportsView("cash-sale")}>💵 Cash Sale</button>
              <button className={reportsView === "paytm-sale" ? "active" : ""} onClick={() => setReportsView("paytm-sale")}>📱 Paytm Sale</button>
              <button className={reportsView === "department-credit" ? "active" : ""} onClick={() => setReportsView("department-credit")}>🏢 Department Credit</button>
              <button className={reportsView === "individual-credit" ? "active" : ""} onClick={() => setReportsView("individual-credit")}>👤 Individual Credit</button>
            </div>

            {reportsView === "daily" && (
              <DailyReport
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                openingStockValue={openingStockValue}
                receivedTotal={reportReceivedStockValue}
                issuedValue={outgoingValue}
                closingStockValue={reportClosingStockValue}
                cashTotal={cashTotal}
                paytmTotal={paytmTotal}
                departmentCreditTotal={departmentCreditTotal}
                individualCreditTotal={individualCreditTotal}
                departmentRecovery={reportDepartmentRecovery}
                individualRecovery={reportIndividualRecovery}
              />
            )}

            {reportsView === "cash-sale" && (
              <SaleReport
                saleType="cash"
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                onCorrected={refreshDailyStockAndTotals}
              />
            )}

            {reportsView === "paytm-sale" && (
              <SaleReport
                saleType="upi"
                selectedDate={selectedDate}
                setSelectedDate={setSelectedDate}
                onCorrected={refreshDailyStockAndTotals}
              />
            )}

            {reportsView === "department-credit" && (
              <CreditReport
                creditType="department"
                initialPeriod={creditReportPeriod}
                backLabel="← Back to Reports"
                onBack={() => setReportsView("daily")}
                onCorrected={() => { refreshDailyStockAndTotals(); refreshDues(); }}
              />
            )}

            {reportsView === "individual-credit" && (
              <CreditReport
                creditType="individual"
                initialPeriod={creditReportPeriod}
                backLabel="← Back to Reports"
                onBack={() => setReportsView("daily")}
                onCorrected={() => { refreshDailyStockAndTotals(); refreshDues(); }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );



}

export default App;
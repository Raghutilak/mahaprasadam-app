import { Fragment, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import "./CreditReport.css";
import sb from "./supabaseClient";
import { departments } from "./DepartmentCredit";
import { getBusinessDate, getBusinessMonth } from "./dateUtils";

const sweetOrder = ["Peda", "Sandesh", "Rasagulla", "Rasamalai", "Sweet Samosa", "Cake", "Ladoo"];

// Print-only shorthand for sweet columns — keeps the printed table's sweet
// columns narrow. The on-screen table always shows the full name; this is
// swapped in only when building the print document, with a legend printed
// under the totals row so the abbreviations are never ambiguous on paper.
const sweetAbbreviations = {
  Peda: "PD",
  Sandesh: "SD",
  Rasagulla: "RG",
  Rasamalai: "RM",
  "Sweet Samosa": "SS",
  Cake: "C",
  Ladoo: "L",
};

const prices = {
  Peda: 15,
  Sandesh: 15,
  Rasagulla: 25,
  Rasamalai: 25,
  "Sweet Samosa": 150,
  Cake: 60,
  Ladoo: 60,
};

const todayISO = getBusinessDate;
const currentMonthStr = getBusinessMonth;

const formatDateForDisplay = (isoDate) => {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// DD/MM/YYYY — used specifically for the Recovery Mode column, e.g. "Cash
// 14/09/2026" wrapping onto its own line under the mode.
const formatDateCompact = (isoDate) => {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
};

// Title Case for print only — e.g. "ANAND GOVIND PRABHU" -> "Anand Govind
// Prabhu". The on-screen table keeps names exactly as stored; this is
// purely a print-readability preference.
const toTitleCase = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/(^|\s|["'(])\p{L}/gu, (c) => c.toUpperCase());

// Converts a rupee amount to words using the Indian numbering system
// (thousand / lakh / crore) — used to print the Balance Amount in words
// under the totals row, e.g. "Rupees Two Lakh Thirty Four Thousand Five
// Hundred Only".
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const twoDigitWords = (n) => {
  if (n === 0) return "";
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
};
const threeDigitWords = (n) => {
  if (n < 100) return twoDigitWords(n);
  return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + twoDigitWords(n % 100) : "");
};

const numberToWordsIndian = (amount) => {
  let num = Math.round(Math.abs(Number(amount) || 0));
  if (num === 0) return "Zero";

  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = num;

  return [
    crore ? `${threeDigitWords(crore)} Crore` : "",
    lakh ? `${threeDigitWords(lakh)} Lakh` : "",
    thousand ? `${threeDigitWords(thousand)} Thousand` : "",
    hundred ? threeDigitWords(hundred) : "",
  ]
    .filter(Boolean)
    .join(" ");
};

// creditType: "department" | "individual"
function CreditReport({ creditType, initialPeriod = "daily", onBack, backLabel = "← Back to Dashboard", onCorrected, dateLocked = false, lockedDepartment = "" }) {
  const [period, setPeriod] = useState(initialPeriod);

  const [fromDate, setFromDate] = useState(todayISO());
  const [toDate, setToDate] = useState(todayISO());
  const [month, setMonth] = useState(currentMonthStr());

  const [selectedDepartment, setSelectedDepartmentRaw] = useState(lockedDepartment || "");
  // A department-restricted staff member (see staff_department_restriction_id()
  // in Supabase) can't change this away from their locked department — the
  // dropdown itself is hidden below, but this is the actual guard: even a
  // stray setSelectedDepartment call elsewhere can't override it. This is a
  // convenience/UX lock, not the real security boundary — that's enforced
  // server-side by RLS regardless of what this component does.
  const setSelectedDepartment = (value) => {
    if (lockedDepartment) return;
    setSelectedDepartmentRaw(value);
  };
  const [selectedIndividual, setSelectedIndividual] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [sales, setSales] = useState([]); // sales header rows in range
  const [payments, setPayments] = useState([]); // credit_payments (recoveries) rows in range
  const [itemsBySaleId, setItemsBySaleId] = useState({}); // sale_id -> { sweetName: qty }
  const [sweetIdToName, setSweetIdToName] = useState({});
  const [carrierIdToName, setCarrierIdToName] = useState({});
  const [carrierIdToMobile, setCarrierIdToMobile] = useState({});
  const [accountHolderIdToName, setAccountHolderIdToName] = useState({});
  const [accountHolderIdToMobile, setAccountHolderIdToMobile] = useState({});
  const [individualOptions, setIndividualOptions] = useState([]);

  // Bump this to force the sales/sale_items fetch below to re-run after a
  // correction (edit or delete) has been saved, so the report reflects it
  // immediately instead of only on the next filter change.
  const [reloadKey, setReloadKey] = useState(0);

  // ── Correction (edit/delete) state ─────────────────────────────────
  const [editingSale, setEditingSale] = useState(null); // raw `sales` row being corrected
  const [editForm, setEditForm] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState(null);
  const [actionError, setActionError] = useState("");
  const [actionMsg, setActionMsg] = useState("");

  const saleType = creditType === "department" ? "department_credit" : "individual_credit";

  // Corrections only make sense against individual saved entries, which is
  // what the Daily view shows. Monthly view aggregates many entries into
  // one summary row, so there's nothing single to correct there.
  const canCorrect = period === "daily";

  const nameToSweetId = useMemo(() => {
    const map = {};
    Object.entries(sweetIdToName).forEach(([id, name]) => { map[name] = id; });
    return map;
  }, [sweetIdToName]);

  // Finds an existing master-data row by (case/whitespace-insensitive) name,
  // or creates one — same approach App.jsx uses when saving a fresh entry,
  // so a corrected name lands on the same row instead of creating a duplicate.
  const getOrCreateMasterId = async (table, name, extra = {}) => {
    if (!name) return null;
    const { data: existing, error: findErr } = await sb.from(table).selectIlike("id", "name", name);
    if (findErr) throw findErr;
    if (Array.isArray(existing) && existing.length > 0) return existing[0].id;
    const { data: created, error: insertErr } = await sb.from(table).insert({ name, ...extra });
    if (insertErr) throw insertErr;
    return Array.isArray(created) && created[0] ? created[0].id : null;
  };

  // ── Load small master-data lookups once ───────────────────────────
  useEffect(() => {
    const loadLookups = async () => {
      try {
        const { data: sweetRows, error: sweetErr } = await sb.from("sweets").select("id,name");
        if (!sweetErr && Array.isArray(sweetRows)) {
          const map = {};
          sweetRows.forEach((r) => { map[r.id] = r.name; });
          setSweetIdToName(map);
        }

        const { data: carrierRows, error: carrierErr } = await sb.from("carriers").select("id,name,mobile");
        if (!carrierErr && Array.isArray(carrierRows)) {
          const nameMap = {};
          const mobileMap = {};
          carrierRows.forEach((r) => { nameMap[r.id] = r.name; mobileMap[r.id] = r.mobile || ""; });
          setCarrierIdToName(nameMap);
          setCarrierIdToMobile(mobileMap);
        }

        const { data: holderRows, error: holderErr } = await sb.from("account_holders").select("id,name,mobile");
        if (!holderErr && Array.isArray(holderRows)) {
          const nameMap = {};
          const mobileMap = {};
          holderRows.forEach((r) => { nameMap[r.id] = r.name; mobileMap[r.id] = r.mobile || ""; });
          setAccountHolderIdToName(nameMap);
          setAccountHolderIdToMobile(mobileMap);
        }
      } catch (e) {
        console.error("Credit report lookup load error:", e);
      }
    };
    loadLookups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditType]);

  // ── Individual dropdown options — only people who actually have at least
  // one Individual Credit entry (not the full account_holders master list,
  // which also includes department contact people, carriers-as-holders, etc).
  useEffect(() => {
    if (creditType !== "individual") return;
    if (Object.keys(accountHolderIdToName).length === 0) return;

    const loadIndividualCreditDebtors = async () => {
      try {
        const { data, error } = await sb
          .from("sales")
          .selectFilter("account_holder_id", "sale_type=eq.individual_credit&account_holder_id=not.is.null");
        if (error) throw error;

        const ids = new Set((Array.isArray(data) ? data : []).map((r) => r.account_holder_id));
        const names = [...ids]
          .map((id) => accountHolderIdToName[id])
          .filter(Boolean);
        setIndividualOptions([...new Set(names)].sort((a, b) => a.localeCompare(b)));
      } catch (e) {
        console.error("Individual credit debtor list load error:", e);
      }
    };
    loadIndividualCreditDebtors();
  }, [creditType, accountHolderIdToName]);

  // ── Resolve the effective date range for the current period ───────
  const effectiveRange = useMemo(() => {
    if (period === "daily") {
      return { from: fromDate, to: toDate };
    }
    // monthly — whole calendar month
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return { from: null, to: null };
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to };
  }, [period, fromDate, toDate, month]);

  // ── Fetch sales + sale_items for the current filters ───────────────
  useEffect(() => {
    const load = async () => {
      if (!effectiveRange.from || !effectiveRange.to) return;
      setLoading(true);
      setLoadError("");
      try {
        const filter = `sale_date=gte.${effectiveRange.from}&sale_date=lte.${effectiveRange.to}&sale_type=eq.${saleType}&order=sale_date.asc`;
        console.log("CREDIT REPORT FILTER:", filter);

        const { data: saleRows, error: saleErr } = await sb.from("sales").selectFilter("*", filter);
        if (saleErr) throw saleErr;

        const rows = Array.isArray(saleRows) ? saleRows : [];
        setSales(rows);

        if (rows.length === 0) {
          setItemsBySaleId({});
          setLoading(false);
          return;
        }

        // const ids = rows.map((r) => r.id).join(",");
        // const { data: itemRows, error: itemErr } = await sb
        //   .from("sale_items")
        //   .selectFilter("*", `sale_id=in.(${ids})`);
        // if (itemErr) throw itemErr;


        // Batch the sale_id lookup instead of one giant `in.(...)` list — a
        // full month can produce hundreds of ids, and cramming them all into
        // one URL can exceed the request-URI length limit, failing the whole
        // request. Chunking keeps every request small regardless of range size.
        const CHUNK_SIZE = 100;
        const idChunks = [];
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
          idChunks.push(rows.slice(i, i + CHUNK_SIZE).map((r) => r.id));
        }
        const chunkResults = await Promise.all(
          idChunks.map((chunk) =>
            sb.from("sale_items").selectFilter("*", `sale_id=in.(${chunk.join(",")})`)
          )
        );
        const itemRows = [];
        for (const { data, error } of chunkResults) {
          if (error) throw error;
          if (Array.isArray(data)) itemRows.push(...data);
        }




        const grouped = {};
        (Array.isArray(itemRows) ? itemRows : []).forEach((it) => {
          if (!grouped[it.sale_id]) grouped[it.sale_id] = {};
          const name = sweetIdToName[it.sweet_id];
          if (!name) return;
          grouped[it.sale_id][name] = (grouped[it.sale_id][name] || 0) + (Number(it.quantity) || 0);
        });
        setItemsBySaleId(grouped);
      } catch (e) {
        console.error("Credit report load error:", e);
        setLoadError(e?.message || "Could not load credit report data.");
      } finally {
        setLoading(false);
      }
    };
    // Wait until sweet names are known so sale_items can be labeled correctly.
    if (Object.keys(sweetIdToName).length > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveRange.from, effectiveRange.to, saleType, sweetIdToName, reloadKey]);

  // ── Fetch recovery payments (credit_payments) for the same range, so the
  // report can show a "Recovery Amt" / "Balance Amt" alongside each credit
  // line. Department credit is recovered against the department as a whole
  // (department_id), Individual credit against the person (account_holder_id).
  useEffect(() => {
    const loadPayments = async () => {
      if (!effectiveRange.from || !effectiveRange.to) return;
      try {
        const entityCol = creditType === "department" ? "department_id" : "account_holder_id";
        const filter = `payment_date=gte.${effectiveRange.from}&payment_date=lte.${effectiveRange.to}&${entityCol}=not.is.null`;
        const { data, error } = await sb.from("credit_payments").selectFilter("*", filter);
        if (error) throw error;
        setPayments(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error("Credit report recovery load error:", e);
        setPayments([]);
      }
    };
    loadPayments();
  }, [effectiveRange.from, effectiveRange.to, creditType, reloadKey]);

  // Maps the raw payment_method stored in Supabase to the same display
  // labels used on the Credit Recovery form ("Cash" / "Paytm" / "T.R.").
  const paymentMethodLabel = (m) => (m === "cash" ? "Cash" : m === "paytm" ? "Paytm" : m === "tr" ? "T.R." : m ? "Other" : "");

  // The Recovery Mode column shows the mode plus whatever identifies that
  // specific payment, on its own line underneath: for Cash/Paytm that's
  // the date it was actually received (payment_date); for T.R./Other,
  // it's the T.R. No. / reference number entered on the form
  // (credit_payments.reference_number). This keeps that identifying
  // detail visible even on a monthly-grouped row, which otherwise
  // wouldn't show each individual payment's own date. The on-screen table
  // renders the "\n" as a real line break (white-space: pre-line); the
  // print document swaps it for <br>.
  const formatModeWithReference = (p) => {
    const mode = paymentMethodLabel(p.payment_method);
    if (!mode) return "";
    if (p.payment_method === "cash" || p.payment_method === "paytm") {
      return p.payment_date ? `${mode}\n${formatDateCompact(p.payment_date)}` : mode;
    }
    return p.reference_number ? `${mode}\n${p.reference_number}` : mode;
  };

  // The Credit Recovery form writes "Received From" info into
  // credit_payments.notes as "Type: Name (mobile)" (see saveRecoveryToSupabase
  // in App.jsx) — pull just the name back out for display here. Falls back to
  // showing the raw note if it isn't in that shape (e.g. older/manual data).
  const extractPayerFromNotes = (notes) => {
    if (!notes) return "";
    const match = String(notes).match(/^[^:]+:\s*(.+?)(\s*\([^)]*\))?$/);
    return match ? match[1].trim() : String(notes).trim();
  };

  // Folds a list of credit_payments rows into { amount, mode, payer }: the
  // summed amount, plus the payment mode(s)+reference and payer name(s)
  // involved, joined together if more than one payment is being combined.
  const summarizePayments = (rows) => {
    const amount = rows.reduce((t, p) => t + (Number(p.amount) || 0), 0);
    const modes = [...new Set(rows.map(formatModeWithReference).filter(Boolean))];
    const payers = [...new Set(rows.map((p) => extractPayerFromNotes(p.notes)).filter(Boolean))];
    return { amount, mode: modes.join("\n"), payer: payers.join(", ") };
  };

  // Department credit recoveries are matched by NAME, not lumped into a
  // department-wide total — see attachDepartmentRecoveries below.

  // Recovery received from an individual, keyed by person + exact date —
  // Individual Credit rows (daily AND monthly, see below) are always grouped
  // per date, so this one map covers both.
  const recoveryByIndivDate = useMemo(() => {
    const groups = {};
    payments.forEach((p) => {
      if (!p.account_holder_id) return;
      const key = `${p.account_holder_id}__${p.payment_date}`;
      (groups[key] = groups[key] || []).push(p);
    });
    const map = {};
    Object.keys(groups).forEach((key) => { map[key] = summarizePayments(groups[key]); });
    return map;
  }, [payments]);

  // Department filtering (and displaying a Department name on each row) needs
  // department NAME resolved from department_id — loaded once here, ahead of
  // `rows`, which now also uses it to label recovery-only rows.
  const [departmentIdToName, setDepartmentIdToName] = useState({});
  useEffect(() => {
    if (creditType !== "department") return;
    const loadDepartments = async () => {
      const { data, error } = await sb.from("departments").select("id,name");
      if (!error && Array.isArray(data)) {
        const map = {};
        data.forEach((r) => { map[r.id] = r.name; });
        setDepartmentIdToName(map);
      }
    };
    loadDepartments();
  }, [creditType]);

  // Attaches department recovery payments to credit rows by matching the
  // payer's name (see extractPayerFromNotes) against the Account Holder
  // already on a row for the same department (and, for daily rows, the
  // same date) — merging into it when found, or creating a new row with
  // the payer's name written directly into Account Holder when it isn't.
  // This is why there's no separate "Received From" column: the name goes
  // straight into the column that's already there.
  //
  // `matchByDate`: true for daily rows (each has its own .date, so a match
  // must land on the same date); false for monthly rows (grouped by
  // Account Holder + Carrier across the whole month — no per-row date).
  const attachDepartmentRecoveries = (saleRows, paymentsForScope, matchByDate) => {
    const withDefaults = saleRows.map((r) => ({ ...r, recoveryAmt: 0, recoveryModes: [] }));
    const extraByKey = {};
    const extraRows = [];

    paymentsForScope.forEach((p) => {
      const payerName = extractPayerFromNotes(p.notes).trim();
      const modeText = formatModeWithReference(p);
      const amt = Number(p.amount) || 0;

      const match = payerName
        ? withDefaults.find(
            (r) =>
              r.departmentId === p.department_id &&
              (!matchByDate || r.date === p.payment_date) &&
              (r.accountHolder || "").trim().toUpperCase() === payerName.toUpperCase()
          )
        : null;

      if (match) {
        match.recoveryAmt += amt;
        match.recoveryModes.push(modeText);
        return;
      }

      // No matching Account Holder row for this payer — create one, or add
      // to it if another payment already created it (same payer, same
      // department, same date for daily).
      const key = `${p.department_id}__${matchByDate ? p.payment_date : ""}__${payerName.toUpperCase()}`;
      if (!extraByKey[key]) {
        extraByKey[key] = {
          id: `recovery-${p.id}`,
          date: matchByDate ? p.payment_date : undefined,
          departmentId: p.department_id,
          department: departmentIdToName[p.department_id] || "—",
          // A plain placeholder only for the rare older/imported entry that
          // predates the Recovery form's "Received From" field.
          accountHolder: payerName || "— (Recovery only)",
          carrier: "—",
          sweetQtys: {},
          amount: 0,
          recoveryAmt: 0,
          recoveryModes: [],
          isRecoveryOnly: true,
        };
        extraRows.push(extraByKey[key]);
      }
      extraByKey[key].recoveryAmt += amt;
      extraByKey[key].recoveryModes.push(modeText);
    });

    return [...withDefaults, ...extraRows].map((r) => ({
      ...r,
      recoveryMode: [...new Set(r.recoveryModes)].join("\n"),
      balanceAmt: r.amount - r.recoveryAmt,
    }));
  };

  // Deity hides the Carrier column (see showCarrierColumn below), so it must
  // not be part of the grouping key either — otherwise one Account Holder
  // delivered by several carriers splits into multiple rows that look
  // completely identical on screen, with nothing to explain why. Rows are
  // always grouped by exactly the columns the reader can actually see.
  const carrierHidden = creditType === "department" && (selectedDepartment || "").toUpperCase() === "DEITY";
  const groupKeyFor = (r, includeDate) =>
    [
      includeDate ? r.date : "",
      (r.accountHolder || "").trim().toUpperCase(),
      carrierHidden ? "" : (r.carrier || "").trim().toUpperCase(),
    ].join("__");

  // Account holders / individuals are listed alphabetically by name so a
  // report reads in a predictable order rather than "whatever order the
  // sales happened to come back in". Where a row has a date (Daily views),
  // that still comes first — each day's own entries stay together and are
  // then alphabetical within that day; Monthly rows (no per-row date) sort
  // purely alphabetically.
  const sortReportRows = (rowsToSort) =>
    [...rowsToSort].sort((a, b) => {
      if (a.date !== b.date) return (a.date || "") > (b.date || "") ? 1 : -1;
      const nameA = (a.accountHolder || a.individualName || "").trim().toUpperCase();
      const nameB = (b.accountHolder || b.individualName || "").trim().toUpperCase();
      return nameA.localeCompare(nameB);
    });

  // ── Build display rows ─────────────────────────────────────────────
  const rows = useMemo(() => {
    const enriched = sales.map((s) => {
      const sweetQtys = itemsBySaleId[s.id] || {};
      return {
        id: s.id,
        date: s.sale_date,
        accountHolder: s.customer_name || "—",
        carrier: carrierIdToName[s.carrier_id] || "—",
        individualName: accountHolderIdToName[s.account_holder_id] || "—",
        individualId: s.account_holder_id,
        department: departmentIdToName[s.department_id] || "—",
        departmentId: s.department_id,
        sweetQtys,
        amount: Number(s.total_amount) || 0,
      };
    });

    if (creditType === "department") {
      // Note: when a department filter is selected, `finalRows` (below) takes
      // over with a department_id-based filter and supersedes this branch.
      const deptPayments = payments.filter((p) => p.department_id);
      if (period === "daily") {
        // Group by date + Account Holder + Carrier, so a name that bought
        // several times in one day (e.g. "Donors" under Deity) is ONE row
        // with its quantities summed — rather than a separate row per sale.
        // Names are matched case/whitespace-insensitively so "Donors",
        // "DONORS" and "Donors " don't split into separate rows, while the
        // first spelling seen is what's displayed.
        const groups = {};
        enriched.forEach((r) => {
          const key = groupKeyFor(r, true);
          if (!groups[key]) {
            groups[key] = {
              id: key,
              date: r.date,
              accountHolder: r.accountHolder,
              carrier: carrierHidden ? "—" : r.carrier,
              departmentId: r.departmentId,
              department: r.department,
              sweetQtys: {},
              amount: 0,
              // The underlying sale rows behind this group — needed because
              // a grouped row no longer maps 1:1 to a single sale, so
              // Correct/Delete has to expand to the individual entries.
              saleIds: [],
            };
          }
          sweetOrder.forEach((sw) => {
            groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
          });
          groups[key].amount += r.amount;
          groups[key].saleIds.push(r.id);
        });
        return sortReportRows(attachDepartmentRecoveries(Object.values(groups), deptPayments, true));
      }
      // Monthly — group by Account Holder + Carrier, summing across the month
      const groups = {};
      enriched.forEach((r) => {
        const key = groupKeyFor(r, false);
        if (!groups[key]) {
          groups[key] = {
            id: key,
            accountHolder: r.accountHolder,
            carrier: carrierHidden ? "—" : r.carrier,
            // A group is keyed by Account Holder + Carrier, which in
            // practice belongs to one department — take the first sale's,
            // used to match this group against a recovery payment below.
            departmentId: r.departmentId,
            department: r.department,
            sweetQtys: {},
            amount: 0,
            saleIds: [],
          };
        }
        sweetOrder.forEach((sw) => {
          groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
        });
        groups[key].amount += r.amount;
        groups[key].saleIds.push(r.id);
      });
      return sortReportRows(attachDepartmentRecoveries(Object.values(groups), deptPayments, false));
    }

    // ── Individual credit ──
    if (period === "daily") {
      // group by date + individual
      const groups = {};
      enriched.forEach((r) => {
        const key = `${r.date}__${r.individualId}`;
        if (!groups[key]) {
          groups[key] = {
            id: key,
            date: r.date,
            individualId: r.individualId,
            individualName: r.individualName,
            sweetQtys: {},
            amount: 0,
            saleIds: [],
          };
        }
        sweetOrder.forEach((sw) => {
          groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
        });
        groups[key].amount += r.amount;
        groups[key].saleIds.push(r.id);
      });
      const withRecovery = Object.values(groups).map((g) => {
        const recovery = recoveryByIndivDate[`${g.individualId}__${g.date}`] || { amount: 0, mode: "", payer: "" };
        return {
          ...g,
          recoveryAmt: recovery.amount,
          recoveryMode: recovery.mode,
          recoveryPayer: recovery.payer,
          balanceAmt: g.amount - recovery.amount,
        };
      });
      const usedKeys = new Set(Object.keys(groups).map((k) => {
        const g = groups[k];
        return `${g.individualId}__${g.date}`;
      }));
      // Fill in a row for any person who received a recovery on a date with
      // no individual-credit purchase at all that day.
      const gapRows = Object.keys(recoveryByIndivDate)
        .filter((key) => !usedKeys.has(key))
        .map((key) => {
          const sepIndex = key.indexOf("__");
          const individualId = key.slice(0, sepIndex);
          const date = key.slice(sepIndex + 2);
          const recovery = recoveryByIndivDate[key];
          return {
            id: `recovery-${key}`,
            date,
            individualId,
            individualName: accountHolderIdToName[individualId] || "—",
            sweetQtys: {},
            amount: 0,
            recoveryAmt: recovery.amount,
            recoveryMode: recovery.mode,
            recoveryPayer: recovery.payer,
            balanceAmt: -recovery.amount,
            isRecoveryOnly: true,
          };
        });
      return sortReportRows([...withRecovery, ...gapRows]);
    }

    // Individual monthly — grouped by date for the selected individual, so
    // the monthly report reads as a proper day-by-day statement (with its
    // own Date column) instead of a single row merged across the month.
    if (!selectedIndividual) return [];
    const matching = enriched.filter((r) => r.individualName === selectedIndividual);
    const groups = {};
    matching.forEach((r) => {
      const key = r.date;
      if (!groups[key]) {
        groups[key] = {
          id: `${r.date}__${r.individualId}`,
          date: r.date,
          individualId: r.individualId,
          individualName: r.individualName,
          sweetQtys: {},
          amount: 0,
          saleIds: [],
        };
      }
      sweetOrder.forEach((sw) => {
        groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
      });
      groups[key].amount += r.amount;
      groups[key].saleIds.push(r.id);
    });
    const withRecovery = Object.values(groups).map((g) => {
      const recovery = recoveryByIndivDate[`${g.individualId}__${g.date}`] || { amount: 0, mode: "", payer: "" };
      return {
        ...g,
        recoveryAmt: recovery.amount,
        recoveryMode: recovery.mode,
        recoveryPayer: recovery.payer,
        balanceAmt: g.amount - recovery.amount,
      };
    });

    // This individual might have recoveries recorded on dates with no
    // purchase in range at all — find their account_holder id (from a
    // matching sale if there is one, else from the recovery data itself)
    // so those dates can still be filled in rather than silently dropped.
    const knownIndividualId =
      matching[0]?.individualId ||
      Object.keys(recoveryByIndivDate)
        .map((k) => k.slice(0, k.indexOf("__")))
        .find((id) => (accountHolderIdToName[id] || "") === selectedIndividual);

    const usedDates = new Set(Object.keys(groups));
    const gapRows = knownIndividualId
      ? Object.keys(recoveryByIndivDate)
          .filter((key) => key.startsWith(`${knownIndividualId}__`))
          .map((key) => key.slice(key.indexOf("__") + 2))
          .filter((date) => !usedDates.has(date))
          .map((date) => {
            const recovery = recoveryByIndivDate[`${knownIndividualId}__${date}`];
            return {
              id: `recovery-${knownIndividualId}__${date}`,
              date,
              individualId: knownIndividualId,
              individualName: selectedIndividual,
              sweetQtys: {},
              amount: 0,
              recoveryAmt: recovery.amount,
              recoveryMode: recovery.mode,
              recoveryPayer: recovery.payer,
              balanceAmt: -recovery.amount,
              isRecoveryOnly: true,
            };
          })
      : [];

    return sortReportRows([...withRecovery, ...gapRows]);
  }, [
    sales,
    itemsBySaleId,
    carrierIdToName,
    accountHolderIdToName,
    departmentIdToName,
    creditType,
    period,
    selectedIndividual,
    payments,
    recoveryByIndivDate,
    attachDepartmentRecoveries,
    groupKeyFor,
    carrierHidden,
  ]);

  // Department filtering needs department NAME on each sale row — since sales
  // only carries department_id, resolve that separately and re-filter here.
  const departmentFilteredSales = useMemo(() => {
    if (creditType !== "department" || !selectedDepartment) return sales;
    return sales.filter((s) => (departmentIdToName[s.department_id] || "").toUpperCase() === selectedDepartment.toUpperCase());
  }, [sales, creditType, selectedDepartment, departmentIdToName]);

  // Recompute rows using the department-filtered sales set when a department is selected.
  const finalRows = useMemo(() => {
    if (creditType !== "department") return rows;
    if (!selectedDepartment) return rows;

    const enriched = departmentFilteredSales.map((s) => {
      const sweetQtys = itemsBySaleId[s.id] || {};
      return {
        id: s.id,
        date: s.sale_date,
        accountHolder: s.customer_name || "—",
        carrier: carrierIdToName[s.carrier_id] || "—",
        department: departmentIdToName[s.department_id] || selectedDepartment,
        departmentId: s.department_id,
        sweetQtys,
        amount: Number(s.total_amount) || 0,
      };
    });

    const deptIdForSelected = Object.keys(departmentIdToName).find(
      (id) => (departmentIdToName[id] || "").toUpperCase() === selectedDepartment.toUpperCase()
    );
    const deptPayments = payments.filter((p) => p.department_id === deptIdForSelected);

    if (period === "daily") {
      // Same per-day grouping as the all-departments branch above: one row
      // per Account Holder + Carrier per date, not one row per sale.
      const dailyGroups = {};
      enriched.forEach((r) => {
        const key = groupKeyFor(r, true);
        if (!dailyGroups[key]) {
          dailyGroups[key] = {
            id: key,
            date: r.date,
            accountHolder: r.accountHolder,
            carrier: carrierHidden ? "—" : r.carrier,
            department: r.department,
            departmentId: r.departmentId,
            sweetQtys: {},
            amount: 0,
            saleIds: [],
          };
        }
        sweetOrder.forEach((sw) => {
          dailyGroups[key].sweetQtys[sw] = (dailyGroups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
        });
        dailyGroups[key].amount += r.amount;
        dailyGroups[key].saleIds.push(r.id);
      });
      return sortReportRows(attachDepartmentRecoveries(Object.values(dailyGroups), deptPayments, true));
    }

    const groups = {};
    enriched.forEach((r) => {
      const key = groupKeyFor(r, false);
      if (!groups[key]) {
        groups[key] = { id: key, accountHolder: r.accountHolder, carrier: carrierHidden ? "—" : r.carrier, department: r.department, departmentId: r.departmentId, sweetQtys: {}, amount: 0, saleIds: [] };
      }
      sweetOrder.forEach((sw) => {
        groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
      });
      groups[key].amount += r.amount;
      groups[key].saleIds.push(r.id);
    });
    return sortReportRows(attachDepartmentRecoveries(Object.values(groups), deptPayments, false));
  }, [
    creditType,
    selectedDepartment,
    departmentFilteredSales,
    itemsBySaleId,
    carrierIdToName,
    departmentIdToName,
    period,
    rows,
    payments,
    attachDepartmentRecoveries,
    groupKeyFor,
    carrierHidden,
  ]);

  const displayRows = creditType === "department" ? finalRows : rows;

  const grandTotal = displayRows.reduce((t, r) => t + (r.amount || 0), 0);
  const grandRecoveryTotal = displayRows.reduce((t, r) => t + (r.recoveryAmt || 0), 0);
  const grandBalanceTotal = displayRows.reduce((t, r) => t + (r.balanceAmt || 0), 0);
  const sweetTotals = sweetOrder.reduce((acc, sw) => {
    acc[sw] = displayRows.reduce((t, r) => t + (r.sweetQtys?.[sw] || 0), 0);
    return acc;
  }, {});

  // Individual Credit's monthly view is now a day-by-day statement (one row
  // per date within the month), so it needs its own Date column too — not
  // just the plain Daily view.
  const showDateColumn = period === "daily" || (creditType === "individual" && period === "monthly");
  const showNameColumn = !(creditType === "individual" && period === "monthly");
  const showAccountHolderCarrier = creditType === "department";
  // Only useful when browsing across every department at once — once a
  // specific one is selected, every row already has the same name, so the
  // column would just repeat it.
  const showDepartmentColumn = showAccountHolderCarrier && !selectedDepartment;
  // Deity's department credit doesn't use a Carrier at all — dropping the
  // column here (rather than just leaving it blank) keeps the remaining
  // columns wider and cuts down on wrapping.
  const showCarrierColumn = showAccountHolderCarrier && (selectedDepartment || "").toUpperCase() !== "DEITY";
  // Department credit now writes the recovery payer's name directly into
  // Account Holder (see attachDepartmentRecoveries) instead of a separate
  // column; Individual credit still has its own dedicated "Received From"
  // since its Name-of-Individual column identifies the debtor, not
  // necessarily who physically paid.
  const showReceivedFromColumn = creditType === "individual";
  const leadingColumnCount =
    (showDateColumn ? 1 : 0) +
    (showAccountHolderCarrier ? 1 : 0) +
    (showCarrierColumn ? 1 : 0) +
    (showDepartmentColumn ? 1 : 0) +
    (creditType === "individual" && showNameColumn ? 1 : 0);

  const title = creditType === "department" ? "🏢 Department Credit" : "👤 Individual Credit";

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Printing straight from the app's own page is unreliable here: the
  // sidebar/main-content layout uses flex + sticky table headers + (on
  // mobile) fixed-position panels, all of which browsers are notorious for
  // rendering as a blank page in print preview. Instead, build a small,
  // self-contained HTML document with just the report in it and print
  // *that*.
  //
  // It's printed via a hidden same-tab <iframe> rather than window.open(): a
  // new popup window is where mobile Safari/Chrome most often fail to reach
  // the OS print sheet at all (so a WiFi/AirPrint printer never even gets a
  // chance to show up), whereas printing an iframe in the current tab is the
  // long-standing reliable cross-browser technique — same OS print dialog
  // and printer list either way, just a more dependable path to it.
  const handlePrint = async () => {
    const scopeLine = [
      period === "daily"
        ? `Daily Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`
        : `Monthly Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`,
      creditType === "department" ? (selectedDepartment ? `Department: ${selectedDepartment}` : "All Departments") : "",
      creditType === "individual" && selectedIndividual ? `Individual: ${selectedIndividual}` : "",
    ]
      .filter(Boolean)
      .map(escapeHtml)
      .join(" — ");

    // Branded header with a QR code linking to the live app — every
    // Department Credit report ("All Departments" and any specific
    // department) EXCEPT DEITY. Generated locally with the qrcode library
    // (no external image request needed at print time), embedded as a
    // data: URI so the printed/PDF'd page is fully self-contained.
    const showAppQr = creditType === "department" && (selectedDepartment || "").toUpperCase() !== "DEITY";
    let appQrDataUrl = "";
    if (showAppQr) {
      try {
        appQrDataUrl = await QRCode.toDataURL("https://mahaprasadam-app.vercel.app", { margin: 1, width: 160 });
      } catch (e) {
        console.error("QR code generation failed:", e);
      }
    }

    // Print-only: for a specific department other than DEITY, drop any
    // sweet column that's all zero in this report — most departments only
    // ever deal in one or two items, so the rest is wasted column width.
    // DEITY (and "All Departments") always show every column, since a
    // department-agnostic or Deity view can't assume which items matter.
    const isSpecificNonDeityDept = creditType === "department" && selectedDepartment && selectedDepartment.toUpperCase() !== "DEITY";
    const printSweetOrder = isSpecificNonDeityDept ? sweetOrder.filter((sw) => (sweetTotals[sw] || 0) > 0) : sweetOrder;

    const headerCells = [
      showDateColumn ? "<th>Date</th>" : "",
      showDepartmentColumn ? "<th>Department</th>" : "",
      showAccountHolderCarrier ? "<th>Account Holder</th>" : "",
      showCarrierColumn ? "<th>Carrier</th>" : "",
      creditType === "individual" && showNameColumn ? "<th>Name of Individual</th>" : "",
      ...printSweetOrder.map((sw) => `<th>${escapeHtml(sweetAbbreviations[sw] || sw)}</th>`),
      `<th class="col-amount">${creditType === "individual" ? "Amount" : "Total Amount"}</th>`,
      '<th class="col-recovery">Recovery Amt</th>',
      showReceivedFromColumn ? '<th class="col-received-from">Received From</th>' : "",
      '<th class="col-balance">Balance Amt</th>',
    ].join("");

    // No separate Recovery Mode column in print — instead each recovery
    // amount gets a footnote marker (*1, *2, …), and what each one means
    // (Cash/Paytm + date received, or T.R./reference number) is listed
    // once at the end of the report instead of repeated on every row. A
    // row with several merged recovery payments gets one marker per
    // payment (e.g. "*1,*2").
    let recoveryFootnoteCounter = 0;
    const recoveryFootnotes = [];
    const recoveryMarkerFor = (recoveryModeStr) => {
      if (!recoveryModeStr) return "";
      const lines = recoveryModeStr.split("\n");
      const markers = [];
      for (let i = 0; i < lines.length; i += 2) {
        const mode = lines[i] || "";
        const ref = lines[i + 1] || "";
        recoveryFootnoteCounter += 1;
        recoveryFootnotes.push(`*${recoveryFootnoteCounter} ${escapeHtml(ref ? `${mode} – ${ref}` : mode)}`);
        markers.push(`*${recoveryFootnoteCounter}`);
      }
      return markers.join(",");
    };

    // Names print in Title Case ("Anand Govind Prabhu") even though they're
    // stored and shown on-screen in caps — a print-readability preference
    // only; the on-screen table is untouched.
    const bodyRows =
      displayRows
        .map((r) => {
          const marker = recoveryMarkerFor(r.recoveryMode);
          const cells = [
            showDateColumn ? `<td>${escapeHtml(formatDateForDisplay(r.date))}</td>` : "",
            showDepartmentColumn ? `<td>${escapeHtml(toTitleCase(r.department) || "—")}</td>` : "",
            showAccountHolderCarrier ? `<td>${escapeHtml(toTitleCase(r.accountHolder))}</td>` : "",
            showCarrierColumn ? `<td>${escapeHtml(toTitleCase(r.carrier))}</td>` : "",
            creditType === "individual" && showNameColumn ? `<td>${escapeHtml(toTitleCase(r.individualName))}</td>` : "",
            ...printSweetOrder.map((sw) => `<td>${r.sweetQtys?.[sw] || 0}</td>`),
            `<td class="amt col-amount">₹ ${r.amount}</td>`,
            `<td class="amt col-recovery">₹ ${r.recoveryAmt || 0}${marker ? ` <sup>${marker}</sup>` : ""}</td>`,
            showReceivedFromColumn ? `<td class="col-received-from">${escapeHtml(toTitleCase(r.recoveryPayer) || "—")}</td>` : "",
            `<td class="amt col-balance">₹ ${r.balanceAmt ?? r.amount}</td>`,
          ].join("");
          return `<tr>${cells}</tr>`;
        })
        .join("") ||
      `<tr><td colspan="99" style="text-align:center;color:#666;padding:20px;">No entries in this range.</td></tr>`;

    const footerCells = [
      `<td colspan="${leadingColumnCount}"><strong>Total</strong></td>`,
      ...printSweetOrder.map((sw) => `<td><strong>${sweetTotals[sw]}</strong></td>`),
      `<td class="amt"><strong>₹ ${grandTotal}</strong></td>`,
      `<td class="amt"><strong>₹ ${grandRecoveryTotal}</strong></td>`,
      showReceivedFromColumn ? "<td></td>" : "",
      `<td class="amt"><strong>₹ ${grandBalanceTotal}</strong></td>`,
    ].join("");

    // One-page fit for Department Credit is now done for real (see below,
    // after the iframe actually renders this HTML) by measuring the
    // content's true height and scaling accordingly — rather than guessing
    // from the row count, which had no way to know when a long Account
    // Holder / Department name (e.g. "LIFE MEMBERSHIP") wraps onto a
    // second line and makes a row taller than assumed.

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title.replace(/[^\w\s]/g, "").trim())}</title>
<style>
  @page { margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #000; background: #fff; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .scope { font-size: 13px; color: #333; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th { background: #eee; }
  tfoot td { border-top: 2px solid #333; }
  td.amt { text-align: right; white-space: nowrap; }
  tr { break-inside: avoid; }
  .legend { margin-top: 8px; font-size: 10px; color: #444; }
  .balance-words { margin: 8px 0 0; font-size: 12px; }
  sup { font-size: 0.75em; }

  /* Branded QR header — printed at the very top when showAppQr is true. */
  .brand-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 14px; }
  .brand-name { font-size: 30px; font-weight: bold; color: #2952cc; font-family: Arial, sans-serif; line-height: 1; }
  .brand-qr { text-align: center; }
  .brand-qr img { width: 70px; height: 70px; display: block; margin: 0 auto; }
  .brand-status { color: #cc0000; font-size: 11px; font-weight: bold; margin-top: 2px; }

  /* ── Column widths ────────────────────────────────────────────────
     Edit the px values below to make a column narrower or wider. These
     four are the usual ones worth shrinking to give Account Holder (and
     the sweet columns) more room — reduce them and the browser gives the
     freed-up space to whichever columns don't have a fixed width. */
  th.col-amount, td.col-amount { width: 62px; }
  th.col-recovery, td.col-recovery { width: 62px; }
  th.col-received-from, td.col-received-from { width: 90px; }
  th.col-balance, td.col-balance { width: 62px; }
  @media (max-width: 500px) {
    table, thead, tbody, tfoot, th, td, tr { font-size: 11px; }
  }
</style>
</head>
<body>
  ${showAppQr && appQrDataUrl ? `<div class="brand-header">
    <div class="brand-name">mahaprasadam</div>
    <div class="brand-qr">
      <img src="${appQrDataUrl}" alt="Scan to open the app" />
      <div class="brand-status">Account Status Live!</div>
    </div>
  </div>` : ""}
  <h1>${escapeHtml(title)} — ${period === "daily" ? "Daily Report" : "Monthly Report"}</h1>
  <p class="scope">${scopeLine}</p>
  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot><tr>${footerCells}</tr></tfoot>
  </table>
  <p class="balance-words">Balance Amount (in words): <strong>Rupees ${numberToWordsIndian(grandBalanceTotal)} Only${grandBalanceTotal < 0 ? " (Advance)" : ""}</strong></p>
  ${recoveryFootnotes.length > 0 ? `<p class="legend">${recoveryFootnotes.join(" &nbsp;|&nbsp; ")}</p>` : ""}
  <p class="legend">${printSweetOrder.map((sw) => `${escapeHtml(sweetAbbreviations[sw] || sw)} = ${escapeHtml(sw)}`).join(" &nbsp;|&nbsp; ")}</p>
</body>
</html>`;

    // A hidden iframe in the current tab — not a new window — is what
    // actually gets printed. Positioned off-screen rather than display:none,
    // since some browsers refuse to print a display:none element at all.
    const existing = document.getElementById("credit-report-print-frame");
    if (existing) existing.remove();
    const iframe = document.createElement("iframe");
    iframe.id = "credit-report-print-frame";
    // Off-screen, but with a REAL width matching an A4 page's printable
    // area (210mm - 12mm margins each side, at 96 CSS px/inch) — not
    // 0×0. The one-page-fit measurement below only works if content
    // actually wraps the same way it will when printed; a width:0 iframe
    // would collapse everything onto its own line and measure nothing
    // useful.
    iframe.style.position = "fixed";
    iframe.style.top = "0";
    iframe.style.left = "-10000px";
    iframe.style.width = "703px";
    iframe.style.height = "1000px";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const frameDoc = iframe.contentWindow.document;
    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();

    // A4's printable height at the same 96px/inch, 12mm-margin math as
    // the width above (273mm content height).
    const ONE_PAGE_HEIGHT_PX = 1005;
    // Never shrink past this — beyond it the report is genuinely too long
    // for one page at a legible size, and printing at the floor is still
    // more useful than an illegible sliver of text.
    const MIN_ZOOM = 0.5;

    const applyOnePageFitAndPrint = () => {
      try {
        if (creditType === "department") {
          const contentHeight = frameDoc.body.scrollHeight;
          if (contentHeight > ONE_PAGE_HEIGHT_PX) {
            const zoom = Math.max(MIN_ZOOM, ONE_PAGE_HEIGHT_PX / contentHeight);
            frameDoc.body.style.zoom = zoom;
          }
        }
      } catch (e) {
        console.error("One-page print fit error:", e);
      }
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch {
        // Nothing more to do if the browser refuses the print call outright.
      }
    };

    // Trigger once the iframe has actually rendered. onload covers most
    // browsers; the timeout is a fallback for the few that don't fire it
    // reliably for content written via document.write.
    let printed = false;
    const doPrint = () => {
      if (printed) return;
      printed = true;
      applyOnePageFitAndPrint();
    };
    iframe.onload = doPrint;
    setTimeout(doPrint, 400);

    // Clean up well after the print dialog would have appeared — removing
    // it immediately can cancel an in-progress print on some browsers.
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 60000);
  };

  // ── Correction helpers ──────────────────────────────────────────────

  // Individual Credit's daily rows are grouped (one row per person per day,
  // even if they were entered in separate transactions), so a "Correct"
  // click here expands the underlying raw sale rows for that person/date.
  const expandedEntries = useMemo(() => {
    if (!expandedGroupKey) return [];
    // Grouped rows carry the list of sale ids behind them (saleIds), so the
    // expanded view just resolves those directly — this works the same for
    // department and individual rows regardless of how each was grouped.
    const row = displayRows.find((r) => String(r.id) === expandedGroupKey);
    if (!row?.saleIds?.length) return [];
    const idSet = new Set(row.saleIds.map(String));
    return sales
      .filter((s) => idSet.has(String(s.id)))
      .map((s) => ({
        id: s.id,
        date: s.sale_date,
        sweetQtys: itemsBySaleId[s.id] || {},
        amount: Number(s.total_amount) || 0,
      }));
  }, [expandedGroupKey, displayRows, sales, itemsBySaleId]);

  const buildEditItems = (sweetQtys) =>
    sweetOrder
      .filter((sw) => (sweetQtys?.[sw] || 0) > 0)
      .map((sw) => ({ sweet: sw, quantity: sweetQtys[sw] }));

  const openEditForSale = (saleId) => {
    const sale = sales.find((s) => String(s.id) === String(saleId));
    if (!sale) return;

    setActionError("");
    setActionMsg("");

    const rawNotes = sale.notes || "";
    const contactMobileMatch = rawNotes.match(/Contact mobile:\s*(\S+)/);
    const contactMobile = contactMobileMatch ? contactMobileMatch[1] : "";
    const purposeOnly = rawNotes.replace(/\s*—?\s*Contact mobile:\s*\S+/, "").trim();

    setEditingSale(sale);
    setEditForm({
      department: departmentIdToName[sale.department_id] || "",
      contactName: sale.customer_name || "",
      contactMobile,
      carrierName: carrierIdToName[sale.carrier_id] || "",
      carrierMobile: carrierIdToMobile[sale.carrier_id] || "",
      individualName: accountHolderIdToName[sale.account_holder_id] || "",
      individualMobile: accountHolderIdToMobile[sale.account_holder_id] || "",
      referenceType: sale.reference_type || "",
      referenceName: sale.reference_name || "",
      purpose: creditType === "department" ? purposeOnly : rawNotes,
      items: buildEditItems(itemsBySaleId[sale.id] || {}),
    });
  };

  const cancelEdit = () => {
    setEditingSale(null);
    setEditForm(null);
  };

  const updateEditField = (field, value) => setEditForm((f) => ({ ...f, [field]: value }));

  const updateEditItem = (index, field, value) => {
    setEditForm((f) => {
      const items = [...f.items];
      items[index] = { ...items[index], [field]: field === "quantity" ? Math.max(0, Number(value) || 0) : value };
      return { ...f, items };
    });
  };

  const addEditRow = () => setEditForm((f) => ({ ...f, items: [...f.items, { sweet: "", quantity: 0 }] }));

  const removeEditRow = (index) =>
    setEditForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== index) }));

  const editTotal = editForm
    ? editForm.items.reduce((t, it) => t + (prices[it.sweet] || 0) * (Number(it.quantity) || 0), 0)
    : 0;

  const saveEdit = async () => {
    if (!editingSale || !editForm) return;

    const validItems = editForm.items.filter((it) => it.sweet && Number(it.quantity) > 0);
    if (validItems.length === 0) {
      setActionError("Please keep at least one sweet item with a quantity greater than zero.");
      return;
    }

    setSavingEdit(true);
    setActionError("");
    setActionMsg("");

    try {
      const isDepartment = creditType === "department";
      let departmentId = editingSale.department_id;
      let carrierId = editingSale.carrier_id;
      let accountHolderId = editingSale.account_holder_id;

      if (isDepartment) {
        if (editForm.department) departmentId = await getOrCreateMasterId("departments", editForm.department);
        if (editForm.carrierName) {
          carrierId = await getOrCreateMasterId("carriers", editForm.carrierName, { mobile: editForm.carrierMobile || null });
        }
      } else if (editForm.individualName) {
        accountHolderId = await getOrCreateMasterId("account_holders", editForm.individualName, { mobile: editForm.individualMobile || null });
      }

      const combinedNotes = isDepartment
        ? (
            `${editForm.purpose ? editForm.purpose + " — " : ""}${editForm.contactMobile ? `Contact mobile: ${editForm.contactMobile}` : ""}`.trim() || null
          )
        : (editForm.purpose || null);

      const items = validItems.map((it) => ({ sweet_id: nameToSweetId[it.sweet], quantity: Number(it.quantity) }));

      const { error: rpcErr } = await sb.rpc("correct_credit_sale", {
        p_sale_id: editingSale.id,
        p_items: items,
        p_department_id: isDepartment ? departmentId : null,
        p_carrier_id: isDepartment ? carrierId : null,
        p_account_holder_id: isDepartment ? null : accountHolderId,
        p_reference_type: isDepartment ? null : (editForm.referenceType || null),
        p_reference_name: isDepartment ? null : (editForm.referenceName || null),
        p_customer_name: isDepartment ? (editForm.contactName || null) : null,
        p_notes: combinedNotes,
      });
      if (rpcErr) {
        if (/no longer exists/i.test(rpcErr.message || "")) {
          setActionError("This entry no longer exists — it looks like it was already deleted (possibly on another device). Refreshing the list…");
          setEditingSale(null);
          setEditForm(null);
          setExpandedGroupKey(null);
          setReloadKey((k) => k + 1);
          return;
        }
        throw rpcErr;
      }

      setActionMsg("✅ Entry corrected successfully.");
      setEditingSale(null);
      setEditForm(null);
      setExpandedGroupKey(null);
      setReloadKey((k) => k + 1);
      // Without this, the correction is saved to Supabase just fine, but App.jsx's departmentCreditTotal /
      // individualCreditTotal (and the Daily Report / Dashboard cards derived from them) keep showing the
      // pre-correction figures until the person happens to navigate away and back — making the correction
      // look like it "didn't save" even though it did. SaleReport's Cash/Paytm corrections already call this
      // same callback; CreditReport was simply missing the wiring.
      if (onCorrected) onCorrected();
    } catch (e) {
      console.error("Correction save error:", e);
      // A foreign-key violation on sale_items specifically means the parent sales row vanished in the
      // tiny window between the existence check above and this write (another device deleted it at
      // almost the same moment) — same underlying situation as that check, just lost the race. Give the
      // same friendly message instead of the raw Postgres error, and refresh so the phantom row clears.
      if (e?.message?.includes("sale_items_sale_id_fkey")) {
        setActionError("This entry was deleted (on another device) while you were correcting it. Refreshing the list…");
        setEditingSale(null);
        setEditForm(null);
        setExpandedGroupKey(null);
        setReloadKey((k) => k + 1);
      } else {
        setActionError(`❌ Could not save correction (${e?.message || "unknown error"}).`);
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteSale = async (saleId) => {
    const sale = sales.find((s) => String(s.id) === String(saleId));
    if (!sale) return;
    if (!window.confirm("Delete this credit entry? This cannot be undone. The department/individual's dues will be adjusted automatically.")) return;

    setDeletingId(saleId);
    setActionError("");
    setActionMsg("");

    try {
      const { error: rpcErr } = await sb.rpc("delete_sale_entry", { p_sale_id: saleId });
      if (rpcErr) throw rpcErr;

      setActionMsg("🗑️ Entry deleted and dues adjusted.");
      if (editingSale && String(editingSale.id) === String(saleId)) {
        setEditingSale(null);
        setEditForm(null);
      }
      setReloadKey((k) => k + 1);
      // Same reasoning as saveEdit above — keep the Daily Report / Dashboard totals in sync with a deletion too.
      if (onCorrected) onCorrected();
    } catch (e) {
      console.error("Delete correction error:", e);
      setActionError(`❌ Could not delete this entry (${e?.message || "unknown error"}).`);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="credit-report">
      <header className="page-header">
        <div>
          <h1>{title} — {period === "daily" ? "Daily Report" : "Monthly Report"}</h1>
          <p>
            {creditType === "department"
              ? "Itemized department credit transactions with sweet-wise quantities."
              : "Individual credit transactions with sweet-wise quantities."}
          </p>
        </div>
        <div className="credit-report-header-actions">
          <button
            type="button"
            className="credit-report-print"
            onClick={handlePrint}
          >
            🖨️ Print
          </button>
          <button className="credit-report-back" onClick={onBack}>{backLabel}</button>
        </div>
      </header>

      {/* Shown only on the printed page (see @media print) — the on-screen filter
          controls above the table are hidden when printing, so this line carries
          the report's scope (period / department / individual) onto the page. */}
      <p className="credit-report-print-only credit-report-print-scope">
        {period === "daily"
          ? `Daily Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`
          : `Monthly Report: ${formatDateForDisplay(effectiveRange.from)} to ${formatDateForDisplay(effectiveRange.to)}`}
        {creditType === "department" && selectedDepartment ? ` — Department: ${selectedDepartment}` : ""}
        {creditType === "department" && !selectedDepartment ? " — All Departments" : ""}
        {creditType === "individual" && selectedIndividual ? ` — Individual: ${selectedIndividual}` : ""}
      </p>

      <div className="credit-report-controls">
        <div className="credit-report-period-toggle">
          <button
            className={period === "daily" ? "active" : ""}
            onClick={() => setPeriod("daily")}
          >
            📅 Daily
          </button>
          <button
            className={period === "monthly" ? "active" : ""}
            onClick={() => setPeriod("monthly")}
          >
            🗓️ Monthly
          </button>
        </div>

        {period === "daily" ? (
          <div className="credit-report-dates">
            <label>
              From
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
          </div>
        ) : (
          <div className="credit-report-dates">
            <label>
              Month
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </label>
          </div>
        )}

        {creditType === "department" && (
          <div className="credit-report-dropdown">
            <label>
              Department
              {lockedDepartment ? (
                <input className="dept-restricted-input" value={lockedDepartment} disabled title="Your account is restricted to this department" />
              ) : (
                <select value={selectedDepartment} onChange={(e) => setSelectedDepartment(e.target.value)}>
                  <option value="">All Departments</option>
                  {departments.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              )}
            </label>
          </div>
        )}

        {creditType === "individual" && period === "monthly" && (
          <div className="credit-report-dropdown">
            <label>
              Individual
              <select value={selectedIndividual} onChange={(e) => setSelectedIndividual(e.target.value)}>
                <option value="">Select Individual</option>
                {individualOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {loading && <p className="credit-report-status">Loading…</p>}
      {loadError && <p className="credit-report-status credit-report-error">⚠️ {loadError}</p>}
      {actionMsg && <p className="credit-report-status credit-report-success">{actionMsg}</p>}
      {actionError && <p className="credit-report-status credit-report-error">{actionError}</p>}

      {creditType === "individual" && period === "monthly" && !selectedIndividual && !loading && (
        <p className="credit-report-status">Select an individual above to view their monthly credit summary.</p>
      )}

      {canCorrect && editingSale && editForm && (
        <div className="credit-report-edit-panel">
          <h3>✏️ Correct Entry #{editingSale.id}</h3>

          {creditType === "department" ? (
            <div className="credit-report-edit-grid">
              <label>
                Department
                {lockedDepartment ? (
                  <input className="dept-restricted-input" value={lockedDepartment} disabled title="Your account is restricted to this department" />
                ) : (
                  <select value={editForm.department} onChange={(e) => updateEditField("department", e.target.value)}>
                    <option value="">Select Department</option>
                    {departments.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                )}
              </label>
              <label>
                Account Holder
                <input type="text" value={editForm.contactName} onChange={(e) => updateEditField("contactName", e.target.value)} />
              </label>
              <label>
                Account Holder Mobile
                <input type="tel" value={editForm.contactMobile} onChange={(e) => updateEditField("contactMobile", e.target.value)} />
              </label>
              <label>
                Carrier
                <input type="text" value={editForm.carrierName} onChange={(e) => updateEditField("carrierName", e.target.value)} />
              </label>
              <label>
                Carrier Mobile
                <input type="tel" value={editForm.carrierMobile} onChange={(e) => updateEditField("carrierMobile", e.target.value)} />
              </label>
              <label>
                Purpose
                <input type="text" value={editForm.purpose} onChange={(e) => updateEditField("purpose", e.target.value)} />
              </label>
            </div>
          ) : (
            <div className="credit-report-edit-grid">
              <label>
                Individual Name
                <input type="text" value={editForm.individualName} onChange={(e) => updateEditField("individualName", e.target.value)} />
              </label>
              <label>
                Mobile Number
                <input type="tel" value={editForm.individualMobile} onChange={(e) => updateEditField("individualMobile", e.target.value)} />
              </label>
              <label>
                Reference Type
                <select value={editForm.referenceType} onChange={(e) => updateEditField("referenceType", e.target.value)}>
                  <option value="">Select Reference Type</option>
                  <option value="Individual">Individual</option>
                  <option value="Department">Department</option>
                </select>
              </label>
              <label>
                Reference Name
                <input type="text" value={editForm.referenceName} onChange={(e) => updateEditField("referenceName", e.target.value)} />
              </label>
              <label>
                Purpose
                <input type="text" value={editForm.purpose} onChange={(e) => updateEditField("purpose", e.target.value)} />
              </label>
            </div>
          )}

          <h4>🍬 Sweet Items</h4>
          {editForm.items.map((item, index) => {
            const rate = prices[item.sweet] || 0;
            const amount = rate * (Number(item.quantity) || 0);
            return (
              <div className="credit-report-edit-row" key={index}>
                <select value={item.sweet} onChange={(e) => updateEditItem(index, "sweet", e.target.value)}>
                  <option value="">Select Sweet</option>
                  {sweetOrder.map((sw) => (
                    <option key={sw} value={sw}>{sw}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  value={item.quantity}
                  onChange={(e) => updateEditItem(index, "quantity", e.target.value)}
                />
                <span>Rate ₹{rate}</span>
                <span>Amount ₹{amount}</span>
                {editForm.items.length > 1 && (
                  <button type="button" onClick={() => removeEditRow(index)}>❌</button>
                )}
              </div>
            );
          })}
          <button type="button" onClick={addEditRow}>+ Add Sweet</button>

          <h4>Corrected Total: ₹{editTotal}</h4>

          <div className="credit-report-edit-actions">
            <button type="button" className="credit-report-save-correction" onClick={saveEdit} disabled={savingEdit}>
              {savingEdit ? "Saving…" : "💾 Save Correction"}
            </button>
            <button type="button" onClick={cancelEdit} disabled={savingEdit}>Cancel</button>
          </div>
        </div>
      )}

      {!loading && !loadError && (
        (creditType !== "individual" || period !== "monthly" || selectedIndividual) && (
          <div className="credit-report-table-wrap">
            <table className="credit-report-table">
              <thead>
                <tr>
                  {showDateColumn && <th>Date</th>}
                  {showDepartmentColumn && <th>Department</th>}
                  {showAccountHolderCarrier && <th>Account Holder</th>}
                  {showCarrierColumn && <th>Carrier</th>}
                  {creditType === "individual" && showNameColumn && <th>Name of Individual</th>}
                  {sweetOrder.map((sw) => (
                    <th key={sw}>{sw} (₹{prices[sw]})</th>
                  ))}
                  <th>{creditType === "individual" ? "Amount" : "Total Amount"}</th>
                  <th>Recovery Amt</th>
                  <th>Recovery Mode</th>
                  {showReceivedFromColumn && <th>Received From</th>}
                  <th>Balance Amt</th>
                  {canCorrect && <th className="credit-report-actions-col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {displayRows.length === 0 && (
                  <tr>
                    <td colSpan={99} className="credit-report-empty">No credit records found for this selection.</td>
                  </tr>
                )}
                {displayRows.map((r) => (
                  <Fragment key={r.id}>
                    <tr>
                      {showDateColumn && <td>{formatDateForDisplay(r.date)}</td>}
                      {showDepartmentColumn && <td>{r.department || "—"}</td>}
                      {showAccountHolderCarrier && <td>{r.accountHolder}</td>}
                      {showCarrierColumn && <td>{r.carrier}</td>}
                      {creditType === "individual" && showNameColumn && <td>{r.individualName}</td>}
                      {sweetOrder.map((sw) => (
                        <td key={sw}>{r.sweetQtys?.[sw] || 0}</td>
                      ))}
                      <td className="credit-report-amount">₹ {r.amount}</td>
                      <td className="credit-report-recovery">₹ {r.recoveryAmt || 0}</td>
                      <td className="credit-report-recovery-mode">{r.recoveryMode || "—"}</td>
                      {showReceivedFromColumn && <td>{r.recoveryPayer || "—"}</td>}
                      <td className="credit-report-balance">₹ {r.balanceAmt ?? r.amount}</td>
                      {canCorrect && (
                        <td className="credit-report-actions">
                          {r.isRecoveryOnly ? (
                            <span className="credit-report-recovery-only-note" title="This line reflects a recovery payment with no matching credit sale — nothing to edit here.">
                              — recovery only
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setExpandedGroupKey(expandedGroupKey === String(r.id) ? null : String(r.id))}
                            >
                              {expandedGroupKey === String(r.id) ? "▲ Hide entries" : "✏️ Correct"}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {expandedGroupKey === String(r.id) && (
                      <tr className="credit-report-subrow" key={`${r.id}-sub`}>
                        <td colSpan={99}>
                          <div className="credit-report-subentries">
                            {expandedEntries.length === 0 && <p>No underlying entries found for this row.</p>}
                            {expandedEntries.map((entry) => (
                              <div className="credit-report-subentry" key={entry.id}>
                                <span>
                                  {sweetOrder
                                    .filter((sw) => entry.sweetQtys[sw])
                                    .map((sw) => `${sw}: ${entry.sweetQtys[sw]}`)
                                    .join(", ") || "—"}
                                </span>
                                <span>₹ {entry.amount}</span>
                                <button
                                  type="button"
                                  onClick={() => openEditForSale(entry.id)}
                                  disabled={dateLocked && entry.date !== todayISO()}
                                  title={dateLocked && entry.date !== todayISO() ? "Your account can only edit today's entries — this date is view-only" : undefined}
                                >
                                  ✏️ Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteSale(entry.id)}
                                  disabled={deletingId === entry.id || (dateLocked && entry.date !== todayISO())}
                                  title={dateLocked && entry.date !== todayISO() ? "Your account can only edit today's entries — this date is view-only" : undefined}
                                >
                                  {deletingId === entry.id ? "Deleting…" : "🗑️ Delete"}
                                </button>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              {displayRows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={leadingColumnCount}><strong>Total</strong></td>
                    {sweetOrder.map((sw) => (
                      <td key={sw}><strong>{sweetTotals[sw]}</strong></td>
                    ))}
                    <td className="credit-report-amount"><strong>₹ {grandTotal}</strong></td>
                    <td className="credit-report-recovery"><strong>₹ {grandRecoveryTotal}</strong></td>
                    <td />
                    {showReceivedFromColumn && <td />}
                    <td className="credit-report-balance"><strong>₹ {grandBalanceTotal}</strong></td>
                    {canCorrect && <td />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )
      )}
    </div>
  );
}

export default CreditReport;

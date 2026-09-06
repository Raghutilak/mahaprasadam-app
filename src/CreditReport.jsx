import { Fragment, useEffect, useMemo, useState } from "react";
import "./CreditReport.css";
import sb from "./supabaseClient";
import { departments } from "./DepartmentCredit";

const sweetOrder = ["Peda", "Sandesh", "Rasagulla", "Rasamalai", "Sweet Samosa", "Cake", "Ladoo"];

const prices = {
  Peda: 15,
  Sandesh: 15,
  Rasagulla: 25,
  Rasamalai: 25,
  "Sweet Samosa": 150,
  Cake: 60,
  Ladoo: 60,
};

const todayISO = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

const currentMonthStr = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const formatDateForDisplay = (isoDate) => {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// creditType: "department" | "individual"
function CreditReport({ creditType, initialPeriod = "daily", onBack, backLabel = "← Back to Dashboard", onCorrected }) {
  const [period, setPeriod] = useState(initialPeriod);

  const [fromDate, setFromDate] = useState(todayISO());
  const [toDate, setToDate] = useState(todayISO());
  const [month, setMonth] = useState(currentMonthStr());

  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedIndividual, setSelectedIndividual] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [sales, setSales] = useState([]); // sales header rows in range
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
        const { data: saleRows, error: saleErr } = await sb.from("sales").selectFilter("*", filter);
        if (saleErr) throw saleErr;

        const rows = Array.isArray(saleRows) ? saleRows : [];
        setSales(rows);

        if (rows.length === 0) {
          setItemsBySaleId({});
          setLoading(false);
          return;
        }

        const ids = rows.map((r) => r.id).join(",");
        const { data: itemRows, error: itemErr } = await sb
          .from("sale_items")
          .selectFilter("*", `sale_id=in.(${ids})`);
        if (itemErr) throw itemErr;

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
        departmentName: null, // resolved below via department filter, not shown as its own column
        departmentId: s.department_id,
        sweetQtys,
        amount: Number(s.total_amount) || 0,
      };
    });

    if (creditType === "department") {
      // Note: when a department filter is selected, `finalRows` (below) takes
      // over with a department_id-based filter and supersedes this branch.
      if (period === "daily") {
        return enriched;
      }
      // Monthly — group by Account Holder + Carrier, summing across the month
      const groups = {};
      enriched.forEach((r) => {
        const key = `${r.accountHolder}__${r.carrier}`;
        if (!groups[key]) {
          groups[key] = {
            id: key,
            accountHolder: r.accountHolder,
            carrier: r.carrier,
            sweetQtys: {},
            amount: 0,
          };
        }
        sweetOrder.forEach((sw) => {
          groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
        });
        groups[key].amount += r.amount;
      });
      return Object.values(groups);
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
            individualName: r.individualName,
            sweetQtys: {},
            amount: 0,
          };
        }
        sweetOrder.forEach((sw) => {
          groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
        });
        groups[key].amount += r.amount;
      });
      return Object.values(groups).sort((a, b) => (a.date > b.date ? 1 : -1));
    }

    // Individual monthly — single aggregated row for the selected individual
    if (!selectedIndividual) return [];
    const matching = enriched.filter((r) => r.individualName === selectedIndividual);
    const summary = { id: "summary", sweetQtys: {}, amount: 0 };
    matching.forEach((r) => {
      sweetOrder.forEach((sw) => {
        summary.sweetQtys[sw] = (summary.sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
      });
      summary.amount += r.amount;
    });
    return matching.length > 0 ? [summary] : [];
  }, [sales, itemsBySaleId, carrierIdToName, accountHolderIdToName, creditType, period, selectedIndividual]);

  // Department filtering needs department NAME on each sale row — since sales
  // only carries department_id, resolve that separately and re-filter here.
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
        sweetQtys,
        amount: Number(s.total_amount) || 0,
      };
    });

    if (period === "daily") return enriched;

    const groups = {};
    enriched.forEach((r) => {
      const key = `${r.accountHolder}__${r.carrier}`;
      if (!groups[key]) {
        groups[key] = { id: key, accountHolder: r.accountHolder, carrier: r.carrier, sweetQtys: {}, amount: 0 };
      }
      sweetOrder.forEach((sw) => {
        groups[key].sweetQtys[sw] = (groups[key].sweetQtys[sw] || 0) + (r.sweetQtys[sw] || 0);
      });
      groups[key].amount += r.amount;
    });
    return Object.values(groups);
  }, [creditType, selectedDepartment, departmentFilteredSales, itemsBySaleId, carrierIdToName, period, rows]);

  const displayRows = creditType === "department" ? finalRows : rows;

  const grandTotal = displayRows.reduce((t, r) => t + (r.amount || 0), 0);
  const sweetTotals = sweetOrder.reduce((acc, sw) => {
    acc[sw] = displayRows.reduce((t, r) => t + (r.sweetQtys?.[sw] || 0), 0);
    return acc;
  }, {});

  const showDateColumn = period === "daily";
  const showNameColumn = !(creditType === "individual" && period === "monthly");
  const showAccountHolderCarrier = creditType === "department";
  const leadingColumnCount =
    (showDateColumn ? 1 : 0) +
    (showAccountHolderCarrier ? 2 : 0) +
    (creditType === "individual" && showNameColumn ? 1 : 0);

  const title = creditType === "department" ? "🏢 Department Credit" : "👤 Individual Credit";

  // ── Correction helpers ──────────────────────────────────────────────

  // Individual Credit's daily rows are grouped (one row per person per day,
  // even if they were entered in separate transactions), so a "Correct"
  // click here expands the underlying raw sale rows for that person/date.
  const expandedEntries = useMemo(() => {
    if (!expandedGroupKey) return [];
    const sepIndex = expandedGroupKey.indexOf("__");
    const date = expandedGroupKey.slice(0, sepIndex);
    const individualId = expandedGroupKey.slice(sepIndex + 2);
    return sales
      .filter((s) => s.sale_date === date && String(s.account_holder_id || "") === individualId)
      .map((s) => ({
        id: s.id,
        sweetQtys: itemsBySaleId[s.id] || {},
        amount: Number(s.total_amount) || 0,
      }));
  }, [expandedGroupKey, sales, itemsBySaleId]);

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
      // Guard against correcting an entry that's already been deleted elsewhere (another device/tab
      // open on this same report, or the admin Reset tool) since this report's list was loaded. Without
      // this check, the UPDATE and DELETE below would silently affect zero rows — Postgres doesn't error
      // on a WHERE clause that matches nothing — and only the final INSERT into sale_items would fail,
      // with a raw foreign-key-violation message that doesn't explain what actually happened.
      const { data: stillExists, error: existsErr } = await sb
        .from("sales")
        .selectFilter("id", `id=eq.${editingSale.id}`);
      if (existsErr) throw existsErr;
      if (!Array.isArray(stillExists) || stillExists.length === 0) {
        setActionError("This entry no longer exists — it looks like it was already deleted (possibly on another device). Refreshing the list…");
        setEditingSale(null);
        setEditForm(null);
        setExpandedGroupKey(null);
        setReloadKey((k) => k + 1);
        return;
      }

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

      const newTotal = validItems.reduce((t, it) => t + (prices[it.sweet] || 0) * Number(it.quantity), 0);

      const combinedNotes = isDepartment
        ? (
            `${editForm.purpose ? editForm.purpose + " — " : ""}${editForm.contactMobile ? `Contact mobile: ${editForm.contactMobile}` : ""}`.trim() || null
          )
        : (editForm.purpose || null);

      const updates = {
        customer_name: isDepartment ? (editForm.contactName || null) : editingSale.customer_name,
        notes: combinedNotes,
        subtotal: newTotal,
        total_amount: newTotal,
        ...(isDepartment
          ? { department_id: departmentId, carrier_id: carrierId }
          : {
              account_holder_id: accountHolderId,
              reference_type: editForm.referenceType || null,
              reference_name: editForm.referenceName || null,
            }),
      };

      const { error: updateErr } = await sb.from("sales").update(updates, "id", editingSale.id);
      if (updateErr) throw updateErr;

      const { error: delItemsErr } = await sb.from("sale_items").delete("sale_id", editingSale.id);
      if (delItemsErr) throw delItemsErr;

      const newItemRows = validItems.map((it) => ({
        sale_id: editingSale.id,
        sweet_id: nameToSweetId[it.sweet],
        quantity: Number(it.quantity),
        rate: prices[it.sweet] || 0,
        total_amount: Number(it.quantity) * (prices[it.sweet] || 0),
      }));
      const { error: insItemsErr } = await sb.from("sale_items").insert(newItemRows);
      if (insItemsErr) throw insItemsErr;

      // Post the difference as its own ledger line rather than trying to locate
      // and edit the original ledger row — dues are a running sum, so a signed
      // "correction" entry keeps the balance right while leaving a clear audit
      // trail of what changed and why.
      const originalTotal = Number(editingSale.total_amount) || 0;
      const delta = newTotal - originalTotal;
      if (delta !== 0) {
        const ledgerTable = isDepartment ? "department_ledger_entries" : "account_ledger_entries";
        const ledgerPayload = isDepartment
          ? { department_id: departmentId, entry_type: "correction", amount: delta, description: `Correction to entry #${editingSale.id}` }
          : { account_holder_id: accountHolderId, entry_type: "correction", amount: delta, description: `Correction to entry #${editingSale.id}` };
        const { error: ledgerErr } = await sb.from(ledgerTable).insert(ledgerPayload);
        if (ledgerErr) throw ledgerErr;
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
      const { error: delItemsErr } = await sb.from("sale_items").delete("sale_id", saleId);
      if (delItemsErr) throw delItemsErr;

      const { error: delSaleErr } = await sb.from("sales").delete("id", saleId);
      if (delSaleErr) throw delSaleErr;

      const isDepartment = creditType === "department";
      const originalTotal = Number(sale.total_amount) || 0;
      if (originalTotal !== 0) {
        const ledgerTable = isDepartment ? "department_ledger_entries" : "account_ledger_entries";
        const ledgerPayload = isDepartment
          ? { department_id: sale.department_id, entry_type: "correction", amount: -originalTotal, description: `Reversal — deleted entry #${saleId}` }
          : { account_holder_id: sale.account_holder_id, entry_type: "correction", amount: -originalTotal, description: `Reversal — deleted entry #${saleId}` };
        const { error: ledgerErr } = await sb.from(ledgerTable).insert(ledgerPayload);
        if (ledgerErr) throw ledgerErr;
      }

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
        <button className="credit-report-back" onClick={onBack}>{backLabel}</button>
      </header>

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
              <select value={selectedDepartment} onChange={(e) => setSelectedDepartment(e.target.value)}>
                <option value="">All Departments</option>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
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
                <select value={editForm.department} onChange={(e) => updateEditField("department", e.target.value)}>
                  <option value="">Select Department</option>
                  {departments.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
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
                  {showAccountHolderCarrier && <th>Account Holder</th>}
                  {showAccountHolderCarrier && <th>Carrier</th>}
                  {creditType === "individual" && showNameColumn && <th>Name of Individual</th>}
                  {sweetOrder.map((sw) => (
                    <th key={sw}>{sw} (₹{prices[sw]})</th>
                  ))}
                  <th>{creditType === "individual" ? "Amount" : "Total Amount"}</th>
                  {canCorrect && <th>Actions</th>}
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
                      {showAccountHolderCarrier && <td>{r.accountHolder}</td>}
                      {showAccountHolderCarrier && <td>{r.carrier}</td>}
                      {creditType === "individual" && showNameColumn && <td>{r.individualName}</td>}
                      {sweetOrder.map((sw) => (
                        <td key={sw}>{r.sweetQtys?.[sw] || 0}</td>
                      ))}
                      <td className="credit-report-amount">₹ {r.amount}</td>
                      {canCorrect && (
                        <td className="credit-report-actions">
                          {creditType === "department" ? (
                            <>
                              <button type="button" onClick={() => openEditForSale(r.id)}>✏️ Edit</button>
                              <button
                                type="button"
                                onClick={() => deleteSale(r.id)}
                                disabled={deletingId === r.id}
                              >
                                {deletingId === r.id ? "Deleting…" : "🗑️ Delete"}
                              </button>
                            </>
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
                    {creditType === "individual" && expandedGroupKey === String(r.id) && (
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
                                <button type="button" onClick={() => openEditForSale(entry.id)}>✏️ Edit</button>
                                <button
                                  type="button"
                                  onClick={() => deleteSale(entry.id)}
                                  disabled={deletingId === entry.id}
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
              {displayRows.length > 0 && !(creditType === "individual" && period === "monthly") && (
                <tfoot>
                  <tr>
                    <td colSpan={leadingColumnCount}><strong>Total</strong></td>
                    {sweetOrder.map((sw) => (
                      <td key={sw}><strong>{sweetTotals[sw]}</strong></td>
                    ))}
                    <td className="credit-report-amount"><strong>₹ {grandTotal}</strong></td>
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

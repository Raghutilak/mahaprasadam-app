
import { useEffect, useState } from "react";
import sb from "./supabaseClient";
import "./Donations.css";
import DonationLabelPrint from "./DonationLabelPrint";

// Capitalizes just the first character of a name/text field as the person
// types, leaving the rest of what they typed untouched (no full title-casing).
const capitalizeFirst = (str) => (str ? str.charAt(0).toUpperCase() + str.slice(1) : str);

// ── Bhoga schedule names & default amounts (same temple schedule
//    used elsewhere in Sweet Accounts) ───────────────────────────
const BHOGA_NAMES_ALL = [
  "Balya Bhoga", "Sakalika Bhoga", "Raja Bhoga",
  "Vaikalika Bhoga", "Sandhya Bhoga", "Shayana Bhoga", "Udayastama",
];

const DEFAULT_BHOGA_AMOUNTS = {
  "Balya Bhoga": 1501,
  "Sakalika Bhoga": 1001,
  "Raja Bhoga": 3501,
  "Vaikalika Bhoga": 1001,
  "Sandhya Bhoga": 2501,
  "Shayana Bhoga": 2001,
  "Udayastama": 18001,
};

const DEFAULT_PREACHERS = [
  { name: "Ramarupa Prabhu", mobile: "9987786416" },
  { name: "Chakravarti Prabhu", mobile: "9987786434" },
  { name: "Pankajanabha Prabhu", mobile: "7777044463" },
  { name: "Sunder Rasbihari Prabhu", mobile: "8452034547" },
  { name: "Shankar Prabhu", mobile: "9987786425" },
];

const getBhogaDay = (dateString) => {
  if (!dateString) return "";

  const date = new Date(`${dateString}T00:00:00`);

  return date.toLocaleDateString("en-US", {
    weekday: "long",
  });
};

const PAYMENT_MODES = ["Cash", "UPI", "Online Transfer (NEFT/IMPS)", "Cheque", "DD"];

const today = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const fmt = (n) => (n ?? 0).toLocaleString("en-IN");
const fmtDate = (dateStr) => {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  return `${d}-${m}-${y}`;
};

function usePersistentState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }, [key, value]);
  return [value, setValue];
}

// Map a Supabase donations row to the local record shape
const rowToRecord = (d) => ({
  id: String(d.id),
  trNo: d.tr_no,
  donationDate: d.donation_date,
  bhogeDate: d.bhoge_date,
  bhogaDay: d.bhoga_day,
  bhogeType: d.bhoge_type,
  bhogaTypeId: d.bhoga_type_id,
  donorName: d.donor_name,
  donorMobile: d.donor_mobile,
  amount: d.amount,
  preacherName: d.preacher_name,
  preacherMobile: d.preacher_mobile,
  preacherId: d.preacher_id,
  paymentMode: d.payment_mode,
  verifiedByAsst: d.verified_by_asst,
  deliveredToDonor: d.delivered_to_donor,
});

function Donations() {
  const [donations, setDonations] = usePersistentState("sweet-donations", []);

  // ── bhoga_types & preachers are now normalized Supabase tables
  //    (donations.bhoga_type_id / donations.preacher_id reference them),
  //    not app_settings JSON blobs. Cached locally too, for offline use. ──
  const [bhogaTypes, setBhogaTypes] = usePersistentState(
    "sweet-bhoga-types",
    BHOGA_NAMES_ALL.map((name) => ({ id: null, name, amount: DEFAULT_BHOGA_AMOUNTS[name] }))
  );
  const [preachers, setPreachers] = usePersistentState("sweet-preachers-master", DEFAULT_PREACHERS.map((p) => ({ id: null, ...p })));

  // Derived lookup helpers
  const bhogeAmounts = Object.fromEntries(bhogaTypes.map((b) => [b.name, b.amount]));
  const bhogaTypeIdByName = new Map(bhogaTypes.filter((b) => b.id).map((b) => [b.name, b.id]));
  const preacherIdByName = new Map(preachers.filter((p) => p.id).map((p) => [p.name, p.id]));

  // const emptyForm = {
  //   donationDate: today(), bhogeDate: today(), bhogeType: "",
  //   donorName: "", donorMobile: "", amount: "",
  //   preacherName: "", preacherMobile: "",
  //   trNo: "", paymentMode: "Cash", verifiedByAsst: false,
  // };

  const emptyForm = {
    donationDate: today(),
    bhogeDate: "",
    donorName: "",
    donorMobile: "",
    preacherName: "",
    preacherMobile: "",
    trNo: "",
    paymentMode: "Cash",
    verifiedByAsst: false,
  };


  const [form, setForm] = useState(emptyForm);
  const [selectedBhogas, setSelectedBhogas] = useState([]); // [{ type, amount }] — multiple Bhogas under one TR
  const [view, setView] = useState("entry"); // entry | list | amounts | preachers
  const [msg, setMsg] = useState({ text: "", type: "ok" });
  const [search, setSearch] = useState("");
  // ── Label printing — pick up to 9 records for one A4 sheet of equal-size labels
  const [selectedForLabels, setSelectedForLabels] = useState([]);
  const [showLabelPrint, setShowLabelPrint] = useState(false);
  const [editAmounts, setEditAmounts] = useState({ ...bhogeAmounts });
  const [syncNote, setSyncNote] = useState("");

  const [showAddPreacher, setShowAddPreacher] = useState(false);
  const [newPreacher, setNewPreacher] = useState({ name: "", mobile: "" });
  const [lastSaved, setLastSaved] = useState(null); // donor/TR/preacher info to quickly reuse
  const [editingGroup, setEditingGroup] = useState(null); // array of {id, bhogeType} from the original TR group being edited, or null for a new entry

  // Refresh the editable amounts snapshot each time the Amounts tab opens,
  // since bhogaTypes may have just finished loading from Supabase.
  useEffect(() => {
    if (view === "amounts") setEditAmounts({ ...bhogeAmounts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ── Load latest data from Supabase on mount, falling back to
  //    the local cache if offline ─────────────────────────────────
  useEffect(() => {
    const load = async () => {
      setSyncNote("⏳ Syncing donations...");
      let hadError = false;
      try {
        const { data: dons, error: donsError } = await sb.from("donations").select("*");
        if (donsError) {
          console.error("Donations load error:", donsError);
          hadError = true;
        } else if (dons) {
          setDonations(dons.map(rowToRecord).sort((a, b) => b.id - a.id));
        }

        // bhoga_types — seed once from the defaults if the table is empty
        const { data: types, error: typesError } = await sb.from("bhoga_types").select("*");
        if (typesError) {
          console.error("Bhoga types load error:", typesError);
          hadError = true;
        } else if (types && types.length > 0) {
          setBhogaTypes(types.map((t) => ({ id: t.id, name: t.name, amount: +t.amount || 0 })));
        } else if (types && types.length === 0) {
          const seedRows = BHOGA_NAMES_ALL.map((name) => ({ name, amount: DEFAULT_BHOGA_AMOUNTS[name] }));
          const { data: created, error: seedError } = await sb.from("bhoga_types").insert(seedRows);
          if (seedError) { console.error("Bhoga types seed error:", seedError); hadError = true; }
          else if (Array.isArray(created)) {
            setBhogaTypes(created.map((t) => ({ id: t.id, name: t.name, amount: +t.amount || 0 })));
          }
        }

        // preachers — seed once from the defaults if the table is empty
        const { data: prs, error: prsError } = await sb.from("preachers").select("*");
        if (prsError) {
          console.error("Preachers load error:", prsError);
          hadError = true;
        } else if (prs && prs.length > 0) {
          setPreachers(prs.map((p) => ({ id: p.id, name: p.name, mobile: p.mobile })));
        } else if (prs && prs.length === 0) {
          const { data: created, error: seedError } = await sb.from("preachers").insert(DEFAULT_PREACHERS);
          if (seedError) { console.error("Preachers seed error:", seedError); hadError = true; }
          else if (Array.isArray(created)) {
            setPreachers(created.map((p) => ({ id: p.id, name: p.name, mobile: p.mobile })));
          }
        }

        setSyncNote(hadError ? "⚠️ Some data failed to sync — check console for details" : "✅ Synced with Supabase");
      } catch (e) {
        console.error("Donations sync error:", e);
        setSyncNote("⚠️ Offline — showing locally saved data");
      }
      setTimeout(() => setSyncNote(""), 3000);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showMsg = (text, type = "ok") => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: "", type: "ok" }), 3000);
  };

  // ── Bhoga selection: picking a name from the dropdown ADDS it to
  //    the list below (instead of replacing a single field), so the
  //    same TR can carry more than one Bhoga at once. ────────────────
  const addBhoga = (bhogaName) => {
    if (!bhogaName) return;
    setSelectedBhogas((prev) => {
      if (prev.some((b) => b.type === bhogaName)) return prev; // already added
      return [...prev, { type: bhogaName, amount: bhogeAmounts[bhogaName] || 0 }];
    });
  };
  const removeBhoga = (bhogaName) =>
    setSelectedBhogas((prev) => prev.filter((b) => b.type !== bhogaName));
  const updateBhogaAmount = (bhogaName, value) =>
    setSelectedBhogas((prev) =>
      prev.map((b) => (b.type === bhogaName ? { ...b, amount: value === "" ? "" : +value } : b))
    );
  const totalSelectedAmount = selectedBhogas.reduce((a, b) => a + (+b.amount || 0), 0);

  const validate = () => {
    if (!form.donorName.trim()) return "Donor name is required";
    if (!form.donorMobile.trim()) return "Donor mobile is required";
    if (!form.trNo.trim()) return "T.R. No. is required";
    if (!form.bhogeDate) return "Bhoga date is required";
    if (selectedBhogas.length === 0) return "Select at least one Bhoga";
    if (!form.preacherName.trim()) return "Preacher name is required";
    return null;
  };

  const getBhogaDay = (dateString) => {
    if (!dateString) return "";

    // Add T00:00:00 so the date is interpreted in local time
    // and doesn't shift to the previous day due to timezone.
    const date = new Date(`${dateString}T00:00:00`);

    return date.toLocaleDateString("en-IN", {
      weekday: "long",
    });
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) return showMsg("⚠️ " + err, "warn");

    // Automatically calculate Bhoga Day from Bhoga Date
    const bhogaDay = getBhogaDay(form.bhogeDate);

    // ── EDIT MODE: reconcile the whole TR group in one go ──────────
    // The form's chip list may now differ from the original group:
    //  - a chip whose Bhoga name matches an original row  → UPDATE that row
    //  - an original row whose Bhoga name is no longer in the chips → DELETE it
    //  - a chip with a Bhoga name that wasn't in the original group → INSERT it
    if (editingGroup) {
      const originalByType = new Map(editingGroup.map((r) => [r.bhogeType, r.id]));
      const currentTypes = new Set(selectedBhogas.map((b) => b.type));

      const toUpdate = selectedBhogas.filter((b) => originalByType.has(b.type));
      const toInsert = selectedBhogas.filter((b) => !originalByType.has(b.type));
      const toDeleteIds = editingGroup.filter((r) => !currentTypes.has(r.bhogeType)).map((r) => r.id);

      const sharedFieldsForRpc = {
        tr_no: form.trNo,
        donation_date: form.donationDate,
        bhoge_date: form.bhogeDate,
        bhoga_day: bhogaDay,
        donor_name: form.donorName,
        donor_mobile: form.donorMobile,
        preacher_name: form.preacherName,
        preacher_mobile: form.preacherMobile,
        preacher_id: preacherIdByName.get(form.preacherName) || null,
        payment_mode: form.paymentMode,
        verified_by_asst: form.verifiedByAsst,
      };
      const sharedFieldsLocal = {
        trNo: form.trNo,
        donationDate: form.donationDate,
        bhogeDate: form.bhogeDate,
        bhogaDay: bhogaDay,
        donorName: form.donorName,
        donorMobile: form.donorMobile,
        preacherName: form.preacherName,
        preacherMobile: form.preacherMobile,
        preacherId: preacherIdByName.get(form.preacherName) || null,
        paymentMode: form.paymentMode,
        verifiedByAsst: form.verifiedByAsst,
      };

      // One atomic RPC call — update / delete / insert all happen inside a
      // single Postgres transaction, so a failure partway through can never
      // leave the TR half-updated (e.g. an old Bhoga deleted but the new
      // one never actually inserted).
      let rpcResult;
      try {
        const { data, error } = await sb.rpc("update_donation_with_bhogas", {
          p_shared: sharedFieldsForRpc,
          p_updates: toUpdate.map((b) => ({
            id: originalByType.get(b.type),
            bhoge_type: b.type,
            bhoga_type_id: bhogaTypeIdByName.get(b.type) || null,
            amount: +b.amount || 0,
          })),
          p_delete_ids: toDeleteIds,
          p_inserts: toInsert.map((b) => ({
            bhoge_type: b.type,
            bhoga_type_id: bhogaTypeIdByName.get(b.type) || null,
            amount: +b.amount || 0,
          })),
        });
        if (error) throw error;
        rpcResult = data;
      } catch (e) {
        console.error("Donation update error:", e);
        showMsg(`❌ Could not save changes to Supabase (${e.status || ""} ${e.message || "permission denied"}). Nothing was changed — please try again.`, "warn");
        return;
      }

      const insertedIds = (rpcResult && rpcResult.inserted_ids) || [];
      const insertedLocal = toInsert.map((b, i) => ({
        id: insertedIds[i] != null ? String(insertedIds[i]) : Date.now() + i,
        ...sharedFieldsLocal,
        bhogeType: b.type,
        bhogaTypeId: bhogaTypeIdByName.get(b.type) || null,
        amount: +b.amount || 0,
        enteredAt: new Date().toLocaleString("en-IN"),
      }));

      const updatedTypeSet = new Set(toUpdate.map((b) => b.type));
      const deletedIdSet = new Set(toDeleteIds);

      setDonations((prev) => {
        const kept = prev
          .filter((d) => !deletedIdSet.has(d.id))
          .map((d) => {
            if (editingGroup.some((r) => r.id === d.id) && updatedTypeSet.has(d.bhogeType)) {
              const match = toUpdate.find((b) => b.type === d.bhogeType);
              return {
                ...d,
                ...sharedFieldsLocal,
                bhogeType: match.type,
                bhogaTypeId: bhogaTypeIdByName.get(match.type) || null,
                amount: +match.amount || 0,
              };
            }
            return d;
          });
        return [...insertedLocal, ...kept];
      });

      setEditingGroup(null);
      setForm({ ...emptyForm, donationDate: today() });
      setSelectedBhogas([]);
      showMsg(
        `✅ Updated TR ${form.trNo} — ${toUpdate.length} changed, ${toInsert.length} added, ${toDeleteIds.length} removed.`
      );
      return;
    }

    // ── NEW ENTRY MODE ───────────────────────────────────────────────
    // One row per selected Bhoga — all sharing the same TR No, donor,
    // preacher, date and payment mode.
    const preacherId = preacherIdByName.get(form.preacherName) || null;

    const rows = selectedBhogas.map((b) => ({
      tr_no: form.trNo,
      donation_date: form.donationDate,
      bhoge_date: form.bhogeDate,
      bhoga_day: bhogaDay,
      bhoge_type: b.type,
      bhoga_type_id: bhogaTypeIdByName.get(b.type) || null,
      donor_name: form.donorName,
      donor_mobile: form.donorMobile,
      amount: +b.amount || 0,
      preacher_name: form.preacherName,
      preacher_mobile: form.preacherMobile,
      preacher_id: preacherId,
      payment_mode: form.paymentMode,
      verified_by_asst: form.verifiedByAsst,
    }));

    const localRecords = selectedBhogas.map((b, i) => ({
      id: Date.now() + i,
      trNo: form.trNo,
      donationDate: form.donationDate,
      bhogeDate: form.bhogeDate,
      bhogaDay: bhogaDay,
      bhogeType: b.type,
      bhogaTypeId: bhogaTypeIdByName.get(b.type) || null,
      donorName: form.donorName,
      donorMobile: form.donorMobile,
      amount: +b.amount || 0,
      preacherName: form.preacherName,
      preacherMobile: form.preacherMobile,
      preacherId,
      paymentMode: form.paymentMode,
      verifiedByAsst: form.verifiedByAsst,
      enteredAt: new Date().toLocaleString("en-IN"),
    }));

    try {
      const { data: saved, error } = await sb.from("donations").insert(rows);

      if (error) {
        console.error("Donation save error:", error);
        showMsg("❌ Donation could not be saved.", "warn");
        return;
      }

      if (Array.isArray(saved)) {
        saved.forEach((row, i) => {
          if (localRecords[i]) localRecords[i].id = String(row.id);
        });
      }

    } catch (e) {
      console.error("Donation save error:", e);
      showMsg("❌ Donation could not be saved.", "warn");
      return;
    }

    setDonations((prev) => [...localRecords, ...prev]);

    // Remember donor/TR/preacher details so they can be quickly reused
    // for a fresh TR via the "Add another Bhoga" button below.
    setLastSaved({
      trNo: form.trNo,
      donorName: form.donorName,
      donorMobile: form.donorMobile,
      preacherName: form.preacherName,
      preacherMobile: form.preacherMobile,
      paymentMode: form.paymentMode,
    });

    // Fully clear the form after a successful save.
    setForm({ ...emptyForm, donationDate: today() });
    setSelectedBhogas([]);

    showMsg(
      `✅ Saved ${localRecords.length} Bhoga${localRecords.length > 1 ? "s" : ""} under TR ${form.trNo}!`
    );
  };

  // Load an existing record's full details back into the form so it can
  // be corrected and/or verified in one save, instead of only toggling
  // the verified flag blind. If this record was entered together with
  // other Bhogas under the same TR No, bring the WHOLE group back —
  // not just the one row that was clicked.
  const handleEdit = (record) => {
    const group = donations.filter((d) => d.trNo === record.trNo);

    setEditingGroup(group.map((d) => ({ id: d.id, bhogeType: d.bhogeType })));
    setForm({
      donationDate: record.donationDate || today(),
      bhogeDate: record.bhogeDate || "",
      donorName: record.donorName || "",
      donorMobile: record.donorMobile || "",
      preacherName: record.preacherName || "",
      preacherMobile: record.preacherMobile || "",
      trNo: record.trNo || "",
      paymentMode: record.paymentMode || "Cash",
      verifiedByAsst: !!record.verifiedByAsst,
    });
    setSelectedBhogas(group.map((d) => ({ type: d.bhogeType, amount: d.amount })));
    setView("entry");
    showMsg(
      group.length > 1
        ? `✏️ Editing TR ${record.trNo} — all ${group.length} Bhogas loaded. Make your changes and click Update.`
        : "✏️ Editing entry — make your changes and click Update."
    );
  };

  const handleCancelEdit = () => {
    setEditingGroup(null);
    setForm({ ...emptyForm, donationDate: today() });
    setSelectedBhogas([]);
  };

  const handleAddAnotherBhoga = () => {
    if (!lastSaved) return;
    setForm({
      ...emptyForm,
      donationDate: today(),
      trNo: lastSaved.trNo,
      donorName: lastSaved.donorName,
      donorMobile: lastSaved.donorMobile,
      preacherName: lastSaved.preacherName,
      preacherMobile: lastSaved.preacherMobile,
      paymentMode: lastSaved.paymentMode,
    });
  };


  const handleDelete = async (id) => {
    const removed = donations.find((d) => d.id === id);
    setDonations((prev) => prev.filter((d) => d.id !== id));

    try {
      const { data, error } = await sb.from("donations").delete("id", id);

      if (error) {
        console.error("Delete error:", error);
        // Restore the row locally since Supabase rejected the delete
        // (most commonly: no DELETE policy for this key in Row Level Security).
        if (removed) setDonations((prev) => [removed, ...prev]);
        showMsg(
          `❌ Could not delete in Supabase (${error.status || ""} ${error.message || error.hint || "permission denied"}). Row restored.`,
          "warn"
        );
        return;
      }

      if (Array.isArray(data) && data.length === 0) {
        // Delete succeeded but matched no row — id mismatch (e.g. a
        // locally-created record whose real Supabase id never synced back).
        if (removed) setDonations((prev) => [removed, ...prev]);
        showMsg("⚠️ No matching record found in Supabase for this entry. Row restored — try syncing (reload the page) first.", "warn");
        return;
      }
    } catch (e) {
      console.error("Delete error:", e);
      if (removed) setDonations((prev) => [removed, ...prev]);
      showMsg("❌ Network error — could not reach Supabase. Row restored.", "warn");
      return;
    }

    showMsg("🗑️ Donation deleted.");
  };

  const handleToggleVerified = async (id, current) => {
    // Optimistic update
    setDonations((prev) => prev.map((d) => (d.id === id ? { ...d, verifiedByAsst: !current } : d)));

    try {
      const { error } = await sb.from("donations").update({ verified_by_asst: !current }, "id", id);

      if (error) {
        console.error("Verify toggle error:", error);
        // Roll back on failure
        setDonations((prev) => prev.map((d) => (d.id === id ? { ...d, verifiedByAsst: current } : d)));
        showMsg(
          `❌ Could not update verification in Supabase (${error.status || ""} ${error.message || "permission denied"}).`,
          "warn"
        );
        return;
      }
    } catch (e) {
      console.error("Verify toggle error:", e);
      setDonations((prev) => prev.map((d) => (d.id === id ? { ...d, verifiedByAsst: current } : d)));
      showMsg("❌ Network error — could not update verification.", "warn");
      return;
    }

    showMsg(!current ? "✅ Marked as verified." : "↩️ Marked as unverified.");
  };

  const handleSaveAmounts = async () => {
    // Update each bhoga_types row directly (this is now the source of truth
    // for donations.bhoga_type_id lookups — no more app_settings blob).
    const failures = [];
    const updates = BHOGA_NAMES_ALL.map(async (name) => {
      const id = bhogaTypeIdByName.get(name);
      const amount = +editAmounts[name] || 0;
      if (!id) return; // not yet synced with Supabase — will be picked up next load
      const { error } = await sb.from("bhoga_types").update({ amount }, "id", id);
      if (error) {
        console.error(`Bhoga amount update error (${name}):`, error);
        failures.push(name);
      }
    });
    await Promise.all(updates);

    setBhogaTypes((prev) => prev.map((b) => (editAmounts[b.name] !== undefined ? { ...b, amount: +editAmounts[b.name] || 0 } : b)));

    if (failures.length > 0) {
      showMsg(`⚠️ Some amounts could not be saved to Supabase: ${failures.join(", ")}`, "warn");
    } else {
      showMsg("✅ Bhoga amounts updated!");
    }
  };

  const addPreacher = async () => {
    const name = newPreacher.name.trim();
    const mobile = newPreacher.mobile.trim();
    if (!name || !mobile) return;
    if (preachers.find((p) => p.name === name)) return;

    let id = null;
    try {
      const { data: created, error } = await sb.from("preachers").insert({ name, mobile });
      if (error) throw error;
      if (Array.isArray(created) && created[0]) id = created[0].id;
    } catch (e) {
      console.error("Add preacher error:", e);
      showMsg("⚠️ Preacher added locally, but could not save to Supabase.", "warn");
    }

    setPreachers((prev) => [...prev, { id, name, mobile }]);
    setForm((f) => ({ ...f, preacherName: name, preacherMobile: mobile }));
    setNewPreacher({ name: "", mobile: "" });
    setShowAddPreacher(false);
  };

  const removePreacher = async (name) => {
    const target = preachers.find((p) => p.name === name);
    setPreachers((prev) => prev.filter((p) => p.name !== name));
    if (target?.id) {
      const { error } = await sb.from("preachers").delete("id", target.id);
      if (error) {
        console.error("Remove preacher error:", error);
        // Roll back — it wasn't actually removed from Supabase.
        setPreachers((prev) => [...prev, target]);
        showMsg(`⚠️ Could not remove ${name} from Supabase — restored locally.`, "warn");
      }
    }
  };
  const handlePreacherSelect = (name) => {
    if (name === "__add__") { setShowAddPreacher(true); return; }
    const found = preachers.find((p) => p.name === name);
    setForm((f) => ({ ...f, preacherName: name, preacherMobile: found?.mobile || "" }));
    setShowAddPreacher(false);
  };

  const toggleSelectForLabel = (id) => {
    setSelectedForLabels((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 9) {
        alert("You can only select up to 9 entries — one A4 sheet holds 9 equal-size labels.");
        return prev;
      }
      return [...prev, id];
    });
  };

  const filtered = (donations || []).filter(
    (d) =>
      !search ||
      d.donorName?.toLowerCase().includes(search.toLowerCase()) ||
      d.trNo?.includes(search) ||
      d.preacherName?.toLowerCase().includes(search.toLowerCase()) ||
      d.bhogeType?.toLowerCase().includes(search.toLowerCase())
  );

  const byTR = {};
  donations.forEach((d) => {
    if (!byTR[d.trNo]) byTR[d.trNo] = { entries: [], totalAmt: 0 };
    byTR[d.trNo].entries.push(d);
    byTR[d.trNo].totalAmt += +d.amount || 0;
  });

  const totalCollected = donations.reduce((a, d) => a + (+d.amount || 0), 0);
  const verifiedCount = donations.filter((d) => d.verifiedByAsst).length;

  const handleEnter = (event) => {
    if (event.key !== "Enter") return;

    const fields = Array.from(
      document.querySelectorAll(
        ".donation-entry-form select:not(:disabled), .donation-entry-form input:not([readonly]):not([type='checkbox']):not(:disabled)"
      )
    );
    const currentIndex = fields.indexOf(event.target);

    if (currentIndex !== -1 && currentIndex < fields.length - 1) {
      event.preventDefault();
      fields[currentIndex + 1].focus();
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="donation-header">
        <div className="donation-header-title">
          <span className="icon">🙏</span>
          <div>
            <h2>Bhoga Donation Management</h2>
            <p>Donation entry, records & configuration{syncNote ? ` — ${syncNote}` : ""}</p>
          </div>
        </div>
        <div className="donation-subnav">
          {["entry", "list", "amounts", "preachers"].map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {v === "entry" ? "➕ New Entry" : v === "list" ? "📋 All Records" : v === "amounts" ? "💰 Bhoga Amounts" : "🕉️ Preachers"}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="donation-stats">
        {[
          { label: "Total Donations", val: donations.length },
          { label: "Total Amount", val: `₹${fmt(totalCollected)}` },
          { label: "Verified", val: verifiedCount },
          { label: "Pending Verify", val: donations.length - verifiedCount },
        ].map((k) => (
          <div key={k.label} className="donation-stat-box">
            <div className="val">{k.val}</div>
            <div className="label">{k.label}</div>
          </div>
        ))}
      </div>

      {msg.text && <div className={`donation-msg ${msg.type}`}>{msg.text}</div>}

      {view === "entry" && lastSaved && (
        <button className="donation-add-another-btn" onClick={handleAddAnotherBhoga}>
          🔁 Reuse donor details for {lastSaved.donorName} (new TR — last was {lastSaved.trNo})
        </button>
      )}

      {/* ── NEW ENTRY ── */}
      {view === "entry" && (
        <div className="donation-grid">
          <div className="donation-card donation-entry-form" onKeyDown={handleEnter}>
            <div className="donation-card-title">
              {editingGroup ? `✏️ Editing Donation Entry${editingGroup.length > 1 ? ` (TR — ${editingGroup.length} Bhogas)` : ""}` : "📝 Donation Entry Form"}
            </div>

            <div className="donation-tr-box">
              <label>Temporary Receipt No. *</label>
              <input
                placeholder="e.g. TR-2025-001"
                value={form.trNo}
                onChange={(e) => setForm((f) => ({ ...f, trNo: e.target.value }))}
              />
              {form.trNo && byTR[form.trNo] && (
                <div className="donation-tr-warn">
                  ⚠️ TR No. already used for {byTR[form.trNo].entries.length} entry(ies) — same donor, different Bhogas is OK
                </div>
              )}
            </div>

            <div className="donation-row-2">             
              

              {/* Bhoga Date */}
              
              <div className="donation-field">
                <label>Bhoga Date *</label>

                <div className="date-picker-wrap">
                  <input
                    type="date"
                    value={form.bhogeDate || ""}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        bhogeDate: e.target.value,
                      }))
                    }
                    className="date-input"
                  />

                  <span className="date-icon">📅</span>
                </div>
              </div>

              {/* Bhoga Day - Automatic */}
              <div className="donation-field">
                <label>Bhoga Day</label>

                <input type="text" value={ form.bhogeDate ? getBhogaDay(form.bhogeDate)  : "" }
                  readOnly
                  placeholder="Auto-filled"
                />
              </div>

            </div>

            <div className="donation-field">
              <label>Bhoga Name * <span style={{ fontWeight: 400, color: "var(--muted)" }}>(select to add — pick more than one for the same TR)</span></label>
              <select
                value=""
                onChange={(e) => addBhoga(e.target.value)}
              >
                <option value="">— Select Bhoga Name to Add —</option>
                {BHOGA_NAMES_ALL
                  .filter((b) => !selectedBhogas.some((sb) => sb.type === b))
                  .map((b) => <option key={b} value={b}>{b} (₹{fmt(bhogeAmounts[b])})</option>)}
              </select>
            </div>

            {selectedBhogas.length > 0 && (
              <div className="donation-bhoga-list">
                {selectedBhogas.map((b) => (
                  <div key={b.type} className="donation-bhoga-chip">
                    <span className="chip-name">{b.type}</span>
                    <span className="chip-rupee">₹</span>
                    <input
                      type="number"
                      className="chip-amount"
                      value={b.amount}
                      onChange={(e) => updateBhogaAmount(b.type, e.target.value)}
                    />
                    <button type="button" className="chip-remove" onClick={() => removeBhoga(b.type)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <div className="donation-field">
              <div className="donation-amount-display">
                <label style={{ margin: 0 }}>Total Amount (₹)</label>
                <span className="auto">{selectedBhogas.length} Bhoga{selectedBhogas.length === 1 ? "" : "s"} selected</span>
              </div>
              <input
                type="text"
                value={`₹${fmt(totalSelectedAmount)}`}
                readOnly
                style={{ fontWeight: "bold", color: "var(--gold)" }}
              />
            </div>

            <div className="donation-section-label">👤 Donor Details</div>
            <div className="donation-row-2">
              <div className="donation-field">
                <label>Donor Name *</label>
                <input placeholder="Full name" value={form.donorName} onChange={(e) => setForm((f) => ({ ...f, donorName: capitalizeFirst(e.target.value) }))} />
              </div>
              <div className="donation-field">
                <label>Donor Mobile *</label>
                <input type="tel" placeholder="10-digit mobile" value={form.donorMobile} onChange={(e) => setForm((f) => ({ ...f, donorMobile: e.target.value }))} />
              </div>
            </div>

            <div className="donation-section-label">🕉️ Preacher Details</div>
            <div className="donation-field">
              <label>Preacher Name *</label>
              <select value={form.preacherName} onChange={(e) => handlePreacherSelect(e.target.value)}>
                <option value="">— Select Preacher —</option>
                {preachers.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                <option value="__add__">➕ Add New Preacher...</option>
              </select>
            </div>

            {showAddPreacher && (
              <div className="donation-add-preacher-box">
                <div className="title">➕ Add New Preacher</div>
                <div className="donation-field">
                  <input placeholder="Preacher name..." value={newPreacher.name} onChange={(e) => setNewPreacher((p) => ({ ...p, name: e.target.value }))} />
                </div>
                <div className="donation-field">
                  <input type="tel" placeholder="Mobile number..." value={newPreacher.mobile} onChange={(e) => setNewPreacher((p) => ({ ...p, mobile: e.target.value }))} />
                </div>
                <div className="donation-btn-row">
                  <button className="donation-btn-primary" onClick={addPreacher}>✅ Add</button>
                  <button className="donation-btn-ghost" onClick={() => { setShowAddPreacher(false); setNewPreacher({ name: "", mobile: "" }); }}>Cancel</button>
                </div>
              </div>
            )}

            <div className="donation-field" style={{ marginTop: 12 }}>
              <label>Preacher Mobile (auto-filled)</label>
              <input type="tel" placeholder="Auto-fills on selection" value={form.preacherMobile} onChange={(e) => setForm((f) => ({ ...f, preacherMobile: e.target.value }))} />
            </div>

            <div className="donation-row-2">
              <div className="donation-field">
                <label>Mode of Payment *</label>
                <select value={form.paymentMode} onChange={(e) => setForm((f) => ({ ...f, paymentMode: e.target.value }))}>
                  {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="donation-checkbox-row">
                <input
                  type="checkbox" id="donation-verified" checked={form.verifiedByAsst}
                  onChange={(e) => setForm((f) => ({ ...f, verifiedByAsst: e.target.checked }))}
                />
                <label htmlFor="donation-verified">✓ Verified by Admin Asst.</label>
              </div>
            </div>

            <button className="donation-submit-btn" onClick={handleSubmit}>
              {editingGroup ? "💾 Update Donation Entry" : "🙏 Save Donation Entry"}
            </button>
            {editingGroup && (
              <button type="button" className="donation-btn-ghost" style={{ width: "100%", marginTop: 8 }} onClick={handleCancelEdit}>
                Cancel Edit
              </button>
            )}
          </div> 

           {/* Right column */}
          <div>
            <div className="donation-card">
              <div className="donation-card-title">🔁 Same T.R. No. Entries</div>
              {form.trNo && byTR[form.trNo] ? (
                <div>
                  <div className="donation-sync-note" style={{ marginBottom: 10 }}>
                    TR: <b style={{ color: "#d97706" }}>{form.trNo}</b> — {byTR[form.trNo].entries.length} Bhoga(s)
                  </div>
                  {byTR[form.trNo].entries.map((e) => (
                    <div key={e.id} className="donation-mini-entry">
                      <div className="top-row">
                        <span className="bhoga-name">{e.bhogeType}</span>
                        <span className="amount">₹{fmt(e.amount)}</span>
                      </div>
                      <div className="meta">{e.donorName} · {e.bhogeDate}</div>
                    </div>
                  ))}
                  <div className="donation-tr-total-row">
                    <span style={{ color: "#64748b", fontSize: 13 }}>Total Amount</span>
                    <span style={{ color: "#d97706", fontWeight: "bold", fontSize: 16 }}>₹{fmt(byTR[form.trNo].totalAmt)}</span>
                  </div>
                </div>
              ) : (
                <div className="donation-empty">Enter T.R. No. above to see grouped entries</div>
              )}
            </div>

            <div className="donation-card">
              <div className="donation-card-title">⏱ Recent Entries</div>
              {donations.slice(0, 5).map((d) => (
                <div key={d.id} className="donation-mini-entry">
                  <div className="top-row">
                    <div>
                      <div style={{ color: "var(--ivory)", fontSize: 13, fontWeight: "bold" }}>{d.donorName}</div>
                      <div className="meta">{d.bhogeType} · TR: {d.trNo}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="amount">₹{fmt(d.amount)}</div>
                      <button
                        type="button"
                        className={`donation-badge donation-badge-btn ${d.verifiedByAsst ? "green" : "amber"}`}
                        onClick={() => handleToggleVerified(d.id, d.verifiedByAsst)}
                        title={d.verifiedByAsst ? "Click to mark as unverified" : "Click to mark as verified"}
                      >
                        {d.verifiedByAsst ? "✓ Verified" : "Unverified"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {donations.length === 0 && <div className="donation-empty">No entries yet</div>}
            </div>
          </div>
        </div>
      )}



      {/* ── ALL RECORDS ── */}
      {view === "list" && (
        <div className="donation-card">
          <div className="donation-card-title">
            <span>📋 All Donation Records ({filtered.length})</span>
            <input className="donation-search" placeholder="Search donor, TR No, preacher..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <button
              type="button"
              className="donation-print-labels-btn"
              disabled={selectedForLabels.length === 0}
              onClick={() => setShowLabelPrint(true)}
            >
              🏷️ Print Labels ({selectedForLabels.length}/9)
            </button>
          </div>
          <div className="donation-table-wrap">
            <table className="donation-table">
              <thead>
                <tr>
                  <th></th>
                  {["TR No.", "Don. Date", "Bhoga Date", "Bhoga Day", "Bhoga", "Donor", "Amount", "Preacher", "Mode", "Status", ""].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={12} style={{ textAlign: "center", color: "#94a3b8", padding: 30 }}>No records found</td></tr>
                )}
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedForLabels.includes(d.id)}
                        onChange={() => toggleSelectForLabel(d.id)}
                      />
                    </td>
                    <td className="tr-no">{d.trNo}</td>
                    <td>{fmtDate(d.donationDate)}</td>
                    <td>{fmtDate(d.bhogeDate)}</td>
                    <td style={{ color: "#94a3b8", fontSize: 12 }}>{d.bhogaDay || (d.bhogeDate ? getBhogaDay(d.bhogeDate) : "—")}</td>
                    <td style={{ color: "#d97706", fontSize: 12 }}>{d.bhogeType}</td>
                    <td>{d.donorName}<br /><span className="sub">{d.donorMobile}</span></td>
                    <td className="amt">₹{fmt(d.amount)}</td>
                    <td>{d.preacherName}<br /><span className="sub">{d.preacherMobile}</span></td>
                    <td><span className="donation-badge blue">{d.paymentMode}</span></td>
                    <td>
                      <button
                        type="button"
                        className={`donation-badge donation-badge-btn ${d.verifiedByAsst ? "green" : "amber"}`}
                        onClick={() => handleToggleVerified(d.id, d.verifiedByAsst)}
                        title={d.verifiedByAsst ? "Click to mark as unverified" : "Click to mark as verified"}
                      >
                        {d.verifiedByAsst ? "✓ Verified" : "Pending — click to verify"}
                      </button>
                    </td>
                    <td>
                      <div className="donation-actions">
                        <button className="donation-edit-btn" onClick={() => handleEdit(d)}>✏️ Edit</button>
                        <a
                          className="donation-whatsapp-btn"
                          href={"https://wa.me/91" + d.donorMobile + "?text=" + encodeURIComponent(`🙏 Hare Krishna!\n\nDear ${d.donorName} Ji,\n\nYour Prasadam for ${d.bhogeType} on ${d.bhogeDate} is ready for collection at the Mahaprasadam counter.\n\nTR No: ${d.trNo}\n\n🛕 ISKCON Mahaprasadam Seva`)}
                          target="_blank" rel="noopener noreferrer"
                        >
                          📲 WhatsApp
                        </a>
                        <button className="donation-delete-btn" onClick={() => handleDelete(d.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > 0 && (
            <div className="donation-table-total">
              <span style={{ color: "#64748b" }}>Total Shown:</span>
              <span className="amt">₹{fmt(filtered.reduce((a, d) => a + (+d.amount || 0), 0))}</span>
            </div>
          )}
        </div>
      )}

      {/* ── BHOGA AMOUNTS ── */}
      {view === "amounts" && (
        <div className="donation-card">
          <div className="donation-card-title">
            <span>💰 Bhoga Donation Amounts</span>
            <button className="donation-btn-primary" style={{ flex: "unset" }} onClick={handleSaveAmounts}>✓ Save Changes</button>
          </div>
          {BHOGA_NAMES_ALL.map((b) => (
            <div key={b} className="donation-amount-row">
              <div>
                <div className="name">{b}</div>
                {b === "Udayastama" && <div className="hint">Full day — all 6 Bhogas combined</div>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#94a3b8" }}>₹</span>
                <input
                  type="number"
                  value={editAmounts[b] || ""}
                  onChange={(e) => setEditAmounts((a) => ({ ...a, [b]: +e.target.value }))}
                />
              </div>
            </div>
          ))}
          <div className="donation-sync-note">
            💡 Udayastama should equal the sum of all 6 Bhoga amounts. Current sum: ₹
            {fmt(BHOGA_NAMES_ALL.filter((b) => b !== "Udayastama").reduce((a, b) => a + (editAmounts[b] || 0), 0))}
          </div>
        </div>
      )}

      {/* ── PREACHERS ── */}
      {view === "preachers" && (
        <div className="donation-card">
          <div className="donation-card-title">🕉️ Preachers List</div>
          {preachers.map((p) => (
            <div key={p.id || p.name} className="donation-preacher-row">
              <div>
                <div className="name">{p.name}</div>
                <div className="mobile">📱 {p.mobile}</div>
              </div>
              <button className="donation-delete-btn" onClick={() => removePreacher(p.name)}>🗑️ Remove</button>
            </div>
          ))}
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, marginTop: 8 }}>
            <div className="donation-section-label">➕ Add New Preacher</div>
            <div className="donation-field">
              <input placeholder="Preacher name..." value={newPreacher.name} onChange={(e) => setNewPreacher((p) => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="donation-field">
              <input
                type="tel" placeholder="10-digit mobile..." value={newPreacher.mobile}
                onChange={(e) => setNewPreacher((p) => ({ ...p, mobile: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && addPreacher()}
              />
            </div>
            <button className="donation-submit-btn" onClick={addPreacher}>✅ Add Preacher</button>
          </div>
        </div>
      )}

      {showLabelPrint && (
        <DonationLabelPrint
          entries={donations.filter((d) => selectedForLabels.includes(d.id))}
          onClose={() => setShowLabelPrint(false)}
        />
      )}
    </div>
  );
}

export default Donations;

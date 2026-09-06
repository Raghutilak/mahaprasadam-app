import { useEffect, useState } from "react";
import "./DepartmentCredit.css";
import sb from "./supabaseClient";

// Capitalizes just the first character of a name/text field as the person
// types, leaving the rest of what they typed untouched (no full title-casing).
const capitalizeFirst = (str) => (str ? str.charAt(0).toUpperCase() + str.slice(1) : str);

const sweetPrices = {
  Peda: 15,
  Sandesh: 15,
  Rasagulla: 25,
  Rasamalai: 25,
  "Sweet Samosa": 150,
  Cake: 60,
  Ladoo: 60,
};

function IndividualCredit({
  availableStock,
  setIndividualCreditStock,
  onSave,
  onGoToDepartmentCredit,
}) {
  const [individualName, setIndividualName] = useState("");
  const [mobile, setMobile] = useState("");

  const [referenceType, setReferenceType] =
    useState("");

  const [referenceName, setReferenceName] =
    useState("");

  const [purpose, setPurpose] = useState("");

  const [items, setItems] = useState([
    {
      sweet: "",
      quantity: 0,
    },
  ]);

  const [creditTransactions, setCreditTransactions] =
    useState([]);

  // Load today's already-saved Individual Credit total from Supabase, so
  // the running total reflects everything entered today across every
  // device — not just whatever's been entered in this browser tab.
  useEffect(() => {
    const loadTodaysTotal = async () => {
      const now = new Date();
      const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      try {
        const { data, error } = await sb.from("sales").selectEq("*", "sale_date", localToday);
        if (error) { console.error("Individual credit total load error:", error); return; }
        if (data) {
          setCreditTransactions(
            data.filter((s) => s.sale_type === "individual_credit").map((s) => ({ totalAmount: +s.total_amount || 0 }))
          );
        }
      } catch (e) {
        console.error("Individual credit total load error:", e);
      }
    };
    loadTodaysTotal();
  }, []);

  const addSweetRow = () => {
    setItems([
      ...items,
      {
        sweet: "",
        quantity: 0,
      },
    ]);
  };

  /* ENTER KEY → NEXT FIELD */

  const handleEnter = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();

      const formElements = Array.from(
        document.querySelectorAll(
          ".individual-credit select:not(:disabled), .individual-credit input:not(:disabled)"
        )
      );

      const currentIndex = formElements.indexOf(event.target);

      if (currentIndex !== -1 && currentIndex < formElements.length - 1) {
        formElements[currentIndex + 1].focus();
      }
    }
  };

  const updateItem = (
    index,
    field,
    value
  ) => {
    const updatedItems = [...items];

    if (field === "quantity") {
      // Clamp typed/pasted quantities to [0, available] ourselves — the input's min/max attributes only affect the
      // spinner arrows, not direct keyboard entry, so without this a person could still type e.g. "999" or "-1".
      const sweet = updatedItems[index].sweet;
      const available = sweet ? Number(availableStock[sweet] || 0) : 0;
      let qty = Number(value);
      if (Number.isNaN(qty)) qty = 0;
      qty = Math.max(0, qty);
      if (sweet) qty = Math.min(qty, available);
      updatedItems[index].quantity = qty;
    } else {
      updatedItems[index][field] = value;
      // Switching to a different sweet can change the ceiling — re-clamp the existing quantity so it never sits
      // above what's actually available for the newly-selected sweet.
      if (field === "sweet") {
        const available = value ? Number(availableStock[value] || 0) : 0;
        updatedItems[index].quantity = Math.min(Number(updatedItems[index].quantity) || 0, available);
      }
    }

    setItems(updatedItems);
  };

  const removeSweetRow = (index) => {
    setItems(
      items.filter(
        (_, itemIndex) =>
          itemIndex !== index
      )
    );
  };

  const totalAmount = items.reduce(
    (total, item) => {
      const rate =
        sweetPrices[item.sweet] || 0;

      return (
        total +
        rate * item.quantity
      );
    },
    0
  );

  const clearForm = () => {
    setIndividualName("");
    setMobile("");
    setReferenceType("");
    setReferenceName("");
    setPurpose("");

    setItems([
      {
        sweet: "",
        quantity: 0,
      },
    ]);
  };

  const saveIndividualCredit = async () => {
    if (!individualName) {
      alert("Please enter Individual Name.");
      return;
    }

    if (!mobile) {
      alert("Please enter Mobile Number.");
      return;
    }

    if (!referenceType) {
      alert("Please select Reference Type.");
      return;
    }

    if (!referenceName) {
      alert("Please enter Reference Name.");
      return;
    }

    const validItems = items.filter(
      (item) =>
        item.sweet &&
        item.quantity > 0
    );

    if (validItems.length === 0) {
      alert(
        "Please add at least one sweet item."
      );
      return;
    }

    // Final safety net in case available stock shifted since the row was last edited (e.g. another device sold
    // stock in between) — never let a save through with a negative or over-stock quantity.
    const overStockItem = validItems.find(
      (item) => item.quantity < 0 || item.quantity > Number(availableStock[item.sweet] || 0)
    );
    if (overStockItem) {
      alert(`⚠️ ${overStockItem.sweet} quantity (${overStockItem.quantity}) exceeds available stock (${Number(availableStock[overStockItem.sweet] || 0)}). Please correct it before saving.`);
      return;
    }

    const transaction = {
      id: Date.now(),
      date: new Date().toISOString(),

      creditType: "Individual",

      individualName,
      mobile,

      referenceType,
      referenceName,

      purpose,

      items: validItems,

      totalAmount,

      dueAmount: totalAmount,
      status: "Outstanding",
    };

    // Wait for Supabase to actually confirm the sale before touching
    // local credit stock — otherwise stock could reduce even if the
    // save fails, leaving stock figures wrong.
    const result = await onSave?.(transaction);
    if (!result?.ok) {
      return; // onSave already alerts the user with the specific error
    }

    setCreditTransactions(
      (previousTransactions) => [
        ...previousTransactions,
        transaction,
      ]
    );

    setIndividualCreditStock(
      (previousStock) => {
        const updatedStock = {
          ...previousStock,
        };

        validItems.forEach((item) => {
          updatedStock[item.sweet] =
            Number(
              updatedStock[item.sweet] || 0
            ) +
            Number(item.quantity);
        });

        return updatedStock;
      }
    );

    alert(
      "Individual Credit Saved Successfully!"
    );

    clearForm();
  };

  return (
    <div className="department-credit individual-credit">

      <div className="credit-page-top-nav">
        <h1>👤 Individual Credit</h1>
        {onGoToDepartmentCredit && (
          <button
            type="button"
            className="credit-page-switch-button"
            onClick={onGoToDepartmentCredit}
          >
            🏢 Go to Department Credit
          </button>
        )}
      </div>

      <div className="credit-field">
        <label>Individual Name</label>

        <input
          type="text"
          value={individualName}
          onChange={(event) =>
            setIndividualName(
              capitalizeFirst(event.target.value)
            )
          }
          onKeyDown={handleEnter}
          placeholder="Enter Individual Name"
        />
      </div>

      <div className="credit-field">
        <label>Mobile Number</label>

        <input
          type="tel"
          value={mobile}
          onChange={(event) =>
            setMobile(event.target.value)
          }
          onKeyDown={handleEnter}
          placeholder="Enter Mobile Number"
        />
      </div>

      <hr />

      <div className="credit-field">
        <label>Reference Type</label>

        <select
          value={referenceType}
          onChange={(event) => {
            setReferenceType(
              event.target.value
            );

            setReferenceName("");
          }}
          onKeyDown={handleEnter}
        >
          <option value="">
            Select Reference Type
          </option>

          <option value="Individual">
            Individual
          </option>

          <option value="Department">
            Department
          </option>
        </select>
      </div>

      <div className="credit-field">
        <label>Reference Name</label>

        <input
          type="text"
          value={referenceName}
          onChange={(event) =>
            setReferenceName(
              capitalizeFirst(event.target.value)
            )
          }
          onKeyDown={handleEnter}
          placeholder={
            referenceType
              ? `Enter ${referenceType} Name`
              : "Select Reference Type First"
          }
          disabled={!referenceType}
        />
      </div>

      <div className="credit-field">
        <label>Purpose (Optional)</label>

        <input
          type="text"
          value={purpose}
          onChange={(event) =>
            setPurpose(capitalizeFirst(event.target.value))
          }
          onKeyDown={handleEnter}
          placeholder="Enter Purpose"
        />
      </div>

      <hr />

      <h2>🍬 Sweet Items</h2>

      {items.map((item, index) => {
        const rate =
          sweetPrices[item.sweet] || 0;

        const amount =
          rate * item.quantity;

        const available =
          item.sweet
            ? Number(
                availableStock[item.sweet] || 0
              )
            : 0;

        return (
          <div
            className="sweet-row"
            key={index}
          >
            <select
              value={item.sweet}
              onChange={(event) =>
                updateItem(
                  index,
                  "sweet",
                  event.target.value
                )
              }
              onKeyDown={handleEnter}
            >
              <option value="">
                Select Sweet
              </option>

              {Object.keys(sweetPrices).map(
                (sweet) => (
                  <option
                    key={sweet}
                    value={sweet}
                  >
                    {sweet}
                  </option>
                )
              )}
            </select>

            <span>
              Available: {available}
            </span>

            <input
              type="number"
              min="0"
              max={available}
              value={item.quantity}
              onChange={(event) =>
                updateItem(
                  index,
                  "quantity",
                  event.target.value
                )
              }
              onKeyDown={handleEnter}
            />

            <span>
              Rate ₹{rate}
            </span>

            <span>
              Amount ₹{amount}
            </span>

            {items.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  removeSweetRow(index)
                }
              >
                ❌
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addSweetRow}
      >
        + Add Sweet
      </button>

      <hr />

      <h2>
        Individual Credit: ₹{totalAmount}
      </h2>

      <button
        type="button"
        className="save-credit-button"
        onClick={saveIndividualCredit}
      >
        💾 Save Individual Credit
      </button>
    </div>
  );
}

export default IndividualCredit;

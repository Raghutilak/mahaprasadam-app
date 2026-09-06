import { useEffect, useState } from "react";
import "./DepartmentCredit.css";
import { accountHolders, carriers } from "./data/people";
import sb from "./supabaseClient";

export const departments = ["ACCOUNTS", "BHISMA","BHAKTI KALA KSHETRA","BHAKTIVEDANTA INSTITUTE","COMMUNICATION","DEITY","FOOD FOR LIFE","GOVINDAS","INTEGRATED PREACHING PROGRAM", "ISKCON YOUTH FORUM","LIFE MEMBERSHIP", "MAINTENANCE", "PURCHASE","NILACHAL VEDIC VILLAGE","SANKIRTAN","TEMPLE",
  ];

const sweetPrices = {Peda: 15,Sandesh: 15,Rasagulla: 25,Rasamalai: 25, "Sweet Samosa": 150,Cake: 60,Ladoo: 60,
  };

const quickFillTemplates = {
  1: {
    department: "TEMPLE",
    accountHolder: "BHIMA PRABHU (TP)",
    accountHolderMobile: "9867124565",
    carrier: "NALINIKANT PRABHU",
    carrierMobile: "8422886705",
  },

  2: {
    department: "TEMPLE",
    accountHolder: "BRAJA HARI PRABHU",
    accountHolderMobile: "0000000000",
    carrier: "NALINIKANT PRABHU",
    carrierMobile: "8422886705",
  },

  3: {
    department: "BHISMA",
    accountHolder: "MUKUNDA MADHAV PRABHU (VP)",
    accountHolderMobile: "9867124569",
    carrier: "DURGESH PRABHU",
    carrierMobile: "8422886708",
  },

  4: {
    department: "LIFE MEMBERSHIP",
    accountHolder: "DEVAKINANDAN PRABHU",
    accountHolderMobile: "0000000000",
    carrier: "ACHINTYA RUPA PRABHU",
    carrierMobile: "0000000000",
  },

  5: {
    department: "LIFE MEMBERSHIP",
    accountHolder: "RAMARUPA PRABHU(HP)",
    accountHolderMobile: "0000000000",
    carrier: "DONORS",
    carrierMobile: "0000000000",
  },

  6: {
    department: "LIFE MEMBERSHIP",
    accountHolder: "SHANKAR PRABHU",
    accountHolderMobile: "0000000000",
    carrier: "DONORS",
    carrierMobile: "0000000000",
  },

  7: {
    department: "LIFE MEMBERSHIP",
    accountHolder: "RADHA KRISHNA PRABHU",
    accountHolderMobile: "0000000000",
    carrier: "BHUSHAN KRISHNA PRABHU",
    carrierMobile: "0000000000",
  },

  8: {
    department: "BHAKTIVEDANTA INSTITUTE",
    accountHolder: "RASARAJ PRABHU",
    accountHolderMobile: "0000000000",
    carrier: "UJJWAL PRABHU",
    carrierMobile: "0000000000",
  },

};

function DepartmentCredit({
  availableStock,
  setDepartmentCreditStock,
  onSave,
  onGoToIndividualCredit,
}) {  

  const [currentDateTime, setCurrentDateTime] = useState(
    new Date()
  );

  const [department, setDepartment] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [accountHolderMobile, setAccountHolderMobile] = useState("");
  const [showAccountHolderList, setShowAccountHolderList] = useState(false);
  const [carrier, setCarrier] = useState("");
  const [carrierMobile, setCarrierMobile] = useState("");
  const [showCarrierList, setShowCarrierList] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [items, setItems] = useState([
    {
      sweet: "",
      quantity: 0,
    },
  ]);

  const [creditTransactions, setCreditTransactions] = useState([]);

  // Load today's already-saved Department Credit total from Supabase, so
  // the running total reflects everything entered today across every
  // device — not just whatever's been entered in this browser tab.
  useEffect(() => {
    const loadTodaysTotal = async () => {
      const now = new Date();
      const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      try {
        const { data, error } = await sb.from("sales").selectEq("*", "sale_date", localToday);
        if (error) { console.error("Department credit total load error:", error); return; }
        if (data) {
          setCreditTransactions(
            data.filter((s) => s.sale_type === "department_credit").map((s) => ({ totalAmount: +s.total_amount || 0 }))
          );
        }
      } catch (e) {
        console.error("Department credit total load error:", e);
      }
    };
    loadTodaysTotal();
  }, []);

  /* LIVE DATE AND TIME */

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentDateTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  /* ENTER KEY → NEXT FIELD */

  // Shared "move focus to the next field" logic — used directly by plain
  // fields via handleEnter, and also called manually by the Account Holder /
  // Carrier fields below, which need to do their autocomplete-selection work
  // on Enter *and then* still advance focus, instead of Enter being swallowed.
  const focusNextField = (event) => {
    const formElements = Array.from(
      document.querySelectorAll(
        ".department-credit select, .department-credit input"
      )
    );

    const currentIndex = formElements.indexOf(
      event.target
    );

    if (
      currentIndex !== -1 &&
      currentIndex < formElements.length - 1
    ) {
      formElements[currentIndex + 1].focus();
    }
  };

  const handleEnter = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      focusNextField(event);
    }
  };

  /* QUICK FILL */

  const loadQuickFill = (number) => {
    const template = quickFillTemplates[number];

    setDepartment(template.department);
    setAccountHolder(template.accountHolder);
    setAccountHolderMobile(template.accountHolderMobile);
    setCarrier(template.carrier);
    setCarrierMobile(template.carrierMobile);
  };

  /* SWEET FUNCTIONS */

  const addSweetRow = () => {
    setItems([
      ...items,
      {
        sweet: "",
        quantity: 0,
      },
    ]);
  };

  const updateItem = (index, field, value) => {
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
    const updatedItems = items.filter(
      (_, itemIndex) => itemIndex !== index
    );

    setItems(updatedItems);
  };

  /* CURRENT TRANSACTION TOTAL */

  const totalAmount = items.reduce(
    (total, item) => {
      const rate = sweetPrices[item.sweet] || 0;

      return total + rate * item.quantity;
    },
    0
  );

  /* DEPARTMENTAL CREDIT GRAND TOTAL */

  const dailyCreditGrandTotal =
    creditTransactions.reduce(
      (total, transaction) =>
        total + transaction.totalAmount,
      0
    );

  /* CLEAR FORM */

  const clearForm = () => {
    setDepartment("");
    setAccountHolder("");
    setAccountHolderMobile("");
    setCarrier("");
    setCarrierMobile("");

    setItems([
      {
        sweet: "",
        quantity: 0,
      },
    ]);
  };

  /* SAVE DEPARTMENT CREDIT */

  const saveDepartmentCredit = async () => {
    if (!department) {
      alert("Please select Department.");
      return;
    }

    if (!accountHolder) {
      alert("Please enter Account Holder.");
      return;
    }

    if (!accountHolderMobile) {
      alert("Please enter Account Holder Mobile.");
      return;
    }

    if (!carrier) {
      alert("Please enter Carrier.");
      return;
    }

    if (!carrierMobile) {
      alert("Please enter Carrier Mobile.");
      return;
    }

    const validItems = items.filter(
      (item) =>
        item.sweet &&
        item.quantity > 0
    );

    if (validItems.length === 0) {
      alert("Please add at least one sweet item.");
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

    const now = new Date();

    const transaction = {
      date: now.toISOString(),
      time: now.toLocaleTimeString("en-IN"),

      department,
      accountHolder,
      accountHolderMobile,
      carrier,
      carrierMobile,
      purpose,

      items: validItems,

      totalAmount,
    };

    const savedTransaction = { id: Date.now(), ...transaction };

    // Wait for Supabase to actually confirm the sale before touching
    // local credit stock — otherwise stock could reduce even if the
    // save fails, leaving stock figures wrong.
    const result = await onSave?.(savedTransaction);
    if (!result?.ok) {
      return; // onSave already alerts the user with the specific error
    }

    setCreditTransactions((previousTransactions) => [...previousTransactions, savedTransaction]);

    setDepartmentCreditStock(
      (previousStock) => {
        const updatedStock = {
          ...previousStock,
        };

        validItems.forEach((item) => {
          updatedStock[item.sweet] =
            Number(updatedStock[item.sweet] || 0) +
            Number(item.quantity);
        });

        return updatedStock;
      }
    );

    alert("Department Credit Saved Successfully!");

    clearForm();
  };

  return (
    <div className="department-credit">

      {/* DATE AND TIME */}

      <div className="page-date-time">
        <div>
          📅{" "}
          {currentDateTime.toLocaleDateString("en-IN")}
        </div>

        <div>
          🕒{" "}
          {currentDateTime.toLocaleTimeString("en-IN")}
        </div>
      </div>

      <div className="credit-page-top-nav">
        <h1>🏢 Department Credit</h1>
        {onGoToIndividualCredit && (
          <button
            type="button"
            className="credit-page-switch-button"
            onClick={onGoToIndividualCredit}
          >
            👤 Go to Individual Credit
          </button>
        )}
      </div>

      {/* QUICK FILL */}

      <div className="quick-fill-section">
        <h3>⚡ Quick Fill</h3>

        <button
          type="button"
          onClick={() => loadQuickFill(1)}
        >
          1
        </button>

        <button
          type="button"
          onClick={() => loadQuickFill(2)}
        >
          2
        </button>

        <button
          type="button"
          onClick={() => loadQuickFill(3)}
        >
          3
        </button>

        <button
          type="button"
          onClick={() => loadQuickFill(4)}
        >
          4
        </button>

        <button
          type="button"
          onClick={() => loadQuickFill(5)}
        >
          5
        </button>

        <button
          type="button"
          onClick={() => loadQuickFill(6)}
        >
          6
        </button>

        <button
          type="button"
          onClick={() => loadQuickFill(7)}
        >
          7
        </button>


        <button
          type="button"
          onClick={() => loadQuickFill(8)}
        >
          8
        </button>




        <button
          type="button"
          onClick={() => {
            if (window.confirm("Clear all fields?")) clearForm();
          }}
        >
          🧹 Clear
        </button>
      </div>

      <hr />

      {/* DEPARTMENT */}

      <div className="credit-field">
        <label>Department</label>

        <select
          value={department}
          onChange={(event) =>
            setDepartment(event.target.value)
          }
          onKeyDown={handleEnter}
        >
          <option value="">
            Select Department
          </option>

          {departments.map((dept) => (
            <option
              key={dept}
              value={dept}
            >
              {dept}
            </option>
          ))}
        </select>
      </div>

     
      {/* ACCOUNT HOLDER */}

      <div className="credit-field">
        <label>Account Holder</label>

        <input
          type="text"
          value={accountHolder}
          onChange={(event) => {
            setAccountHolder(event.target.value);
            setShowAccountHolderList(true);
          }}
          onFocus={() => setShowAccountHolderList(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();

              const matches = accountHolders.filter((person) =>
                person.name
                  .toLowerCase()
                  .includes(accountHolder.toLowerCase())
              );

              if (matches.length > 0) {
                const selectedPerson = matches[0];

                setAccountHolder(selectedPerson.name);
                setAccountHolderMobile(selectedPerson.mobile || "");
                setShowAccountHolderList(false);
              }

              // Whether or not a match was found/selected, Enter should
              // still move on to the next field instead of doing nothing.
              focusNextField(event);
            }
          }}
          placeholder="Type Account Holder Name"
        />

        {showAccountHolderList && (
          <div className="search-dropdown">
            {accountHolders
              .filter((person) =>
                person.name
                  .toLowerCase()
                  .includes(accountHolder.toLowerCase())
              )
              .map((person) => (
                <div
                  key={`${person.name}-${person.mobile}`}
                  className="search-option"
                  onClick={() => {
                    setAccountHolder(person.name);
                    setAccountHolderMobile(person.mobile || "");
                    setShowAccountHolderList(false);
                  }}
                >
                  {person.name}
                </div>
              ))}
          </div>
        )}
      </div>


      <div className="credit-field">
        <label>Account Holder Mobile</label>

        <input
          type="tel"
          value={accountHolderMobile}
          onChange={(event) =>
            setAccountHolderMobile(event.target.value)
          }
          onKeyDown={handleEnter}
          placeholder="Mobile Number"
        />
      </div>


      {/* CARRIER */}

      <div className="credit-field">
        <label>Carrier</label>

        <input
          type="text"
          value={carrier}
          onChange={(event) => {
            setCarrier(event.target.value);
            setShowCarrierList(true);
          }}
          onFocus={() => setShowCarrierList(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();

              const matches = carriers.filter((person) =>
                person.name
                  .toLowerCase()
                  .includes(carrier.toLowerCase())
              );

              if (matches.length > 0) {
                const selectedPerson = matches[0];

                setCarrier(selectedPerson.name);
                setCarrierMobile(selectedPerson.mobile || "");
                setShowCarrierList(false);
              }

              // Whether or not a match was found/selected, Enter should
              // still move on to the next field instead of doing nothing.
              focusNextField(event);
            }
          }}
          placeholder="Type Carrier Name"
        />

        {showCarrierList && (
          <div className="search-dropdown">
            {carriers
              .filter((person) =>
                person.name
                  .toLowerCase()
                  .includes(carrier.toLowerCase())
              )
              .map((person) => (
                <div
                  key={`${person.name}-${person.mobile}`}
                  className="search-option"
                  onClick={() => {
                    setCarrier(person.name);
                    setCarrierMobile(person.mobile || "");
                    setShowCarrierList(false);
                  }}
                >
                  {person.name}
                </div>
              ))}
          </div>
        )}
      </div>


      <div className="credit-field">
        <label>Carrier Mobile</label>

        <input
          type="tel"
          value={carrierMobile}
          onChange={(event) =>
            setCarrierMobile(event.target.value)
          }
          onKeyDown={handleEnter}
          placeholder="Mobile Number"
        />
      </div>

      <hr />


      {/* PURPOSE */}

      <div className="credit-field">
        <label>Purpose (Optional)</label>

        <select
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
          onKeyDown={handleEnter}
        >
          <option value="">Select Purpose (Optional)</option>

          <option value="Balya Bhog Donor">Balya Bhog Donor</option>
          <option value="Sakalika Donor">Sakalika Donor</option>
          <option value="Rajbhog Donor">Rajbhog Donor</option>
          <option value="Vaikalika Donor">Vaikalika Donor</option>
          <option value="Sandhya Bhog Donor">Sandhya Bhog Donor</option>
          <option value="Shayan Bhog Donor">Shayan Bhog Donor</option>
          <option value="Pujari Seva">Pujari Seva</option>
          <option value="Bed Seva">Bed Seva</option>
          <option value="Flower Seva">Flower Seva</option>
          <option value="Milk Seva">Milk Seva</option>
          <option value="Other Donors">Other Donors</option>
        </select>
      </div>




      {/* SWEET ITEMS */}

      <h2>🍬 Sweet Items</h2>

      {items.map((item, index) => {
        const rate = sweetPrices[item.sweet] || 0;
        const amount = rate * item.quantity;
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

      {/* CURRENT TRANSACTION TOTAL */}

      <h2>
        Department Credit: ₹{totalAmount}
      </h2>

      <button
        type="button"
        className="save-credit-button"
        onClick={saveDepartmentCredit}
      >
        💾 Save Department Credit
      </button>

      <hr />

      {/* DEPARTMENTAL CREDIT TOTAL */}

      <div className="daily-credit-total">
        <h2>
          Department Credit Total: ₹
          {dailyCreditGrandTotal}
        </h2>
      </div>

    </div>
  );
}



export default DepartmentCredit;


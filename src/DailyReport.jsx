
function DailyReport({
  selectedDate,
  setSelectedDate,
  dateLocked = false,
  openingStockValue,
  receivedTotal,
  issuedValue,
  closingStockValue,
  cashTotal = 0,
  paytmTotal = 0,
  departmentCreditTotal = 0,
  individualCreditTotal = 0,
  departmentRecovery = { Cash: 0, Paytm: 0, "T.R.": 0 },
  individualRecovery = { Cash: 0, Paytm: 0, "T.R.": 0 },
}) {

  // All figures below are already scoped to `selectedDate` by the caller (fetched fresh from
  // Supabase whenever the date picker changes — see refreshDailyStockAndTotals in App.jsx), so this
  // component itself does no date filtering. That's deliberate: this report used to be built by
  // filtering this device's local, today-only record arrays, which meant any date other than
  // "today on this exact browser" (including bulk-imported historical dates) showed every field
  // as zero. Sourcing straight from Supabase makes the report correct for any date, on any device.

  const departmentCashRecovery = departmentRecovery.Cash || 0;
  const departmentPaytmRecovery = departmentRecovery.Paytm || 0;
  const departmentTrRecovery = departmentRecovery["T.R."] || 0;

  const individualCashRecovery = individualRecovery.Cash || 0;
  const individualPaytmRecovery = individualRecovery.Paytm || 0;
  const individualTrRecovery = individualRecovery["T.R."] || 0;

  const cashToDeposit = cashTotal + departmentCashRecovery + individualCashRecovery;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>📄 Daily Report</h1>
          <p>Stock distribution and daily collection summary</p>
        </div>


        <div className="today-date">
            📅
            <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                disabled={dateLocked}
                title={dateLocked ? "Your account can only view/edit today's report" : undefined}
            />
        </div>


      </header>

      <section className="batch-card">
        <h2>Stock Summary</h2>

        <div className="item-row">
          <span>Opening Stock Value</span>
          <strong>₹ {openingStockValue}</strong>
        </div>

        <div className="item-row">
          <span>Stock Received Value</span>
          <strong>₹ {receivedTotal}</strong>
        </div>

        <div className="item-row">
          <span>Stock Issued Value</span>
          <strong>₹ {issuedValue}</strong>
        </div>

        <div className="item-row">
          <span>Closing Stock Value</span>
          <strong>₹ {closingStockValue}</strong>
        </div>
      </section>

      <section className="batch-card">
        <h2>Sales & Department Credit</h2>

        <div className="item-row">
          <span>Cash Sales</span>
          <strong>₹ {cashTotal}</strong>
        </div>

        <div className="item-row">
          <span>Paytm Sales</span>
          <strong>₹ {paytmTotal}</strong>
        </div>

        <div className="item-row"><span>Department Credit</span><strong>₹ {departmentCreditTotal}</strong></div>
        <div className="item-row"><span>Individual Credit</span><strong>₹ {individualCreditTotal}</strong></div>
      </section>

      <section className="batch-card">
        <h2>Department Credit Recoveries</h2>

        <div className="item-row">
          <span>Cash Recovery</span>
          <strong>₹ {departmentCashRecovery}</strong>
        </div>

        <div className="item-row">
          <span>Paytm Recovery</span>
          <strong>₹ {departmentPaytmRecovery}</strong>
        </div>

        <div className="item-row">
          <span>T.R. Recovery</span>
          <strong>₹ {departmentTrRecovery}</strong>
        </div>
      </section>

      <section className="batch-card"><h2>Individual Credit Recoveries</h2><div className="item-row"><span>Cash Recovery</span><strong>₹ {individualCashRecovery}</strong></div><div className="item-row"><span>Paytm Recovery</span><strong>₹ {individualPaytmRecovery}</strong></div><div className="item-row"><span>T.R. Recovery</span><strong>₹ {individualTrRecovery}</strong></div></section>

      <section className="batch-card">
        <h2>Cash to be Deposited</h2>

        <div className="item-row">
          <span>Cash Sales</span>
          <strong>₹ {cashTotal}</strong>
        </div>

        <div className="item-row">
          <span>Department + Individual Credit Recovery in Cash</span>
          <strong>₹ {departmentCashRecovery + individualCashRecovery}</strong>
        </div>

        <div className="item-row">
          <div className="item-name">
            <strong>Total Cash to Deposit</strong>
            <span>Cash Sales + All Cash Recoveries</span>
          </div>

          <strong className="amount">₹ {cashToDeposit}</strong>
        </div>
      </section>
    </>
  );
}

export default DailyReport;

import { useState } from "react";
import "./DonationLabelPrint.css";

const fmtDate = (dateStr) => {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-");
  return `${d}-${m}-${y}`;
};

const fmt = (n) => (n ?? 0).toLocaleString("en-IN");

const donorWhatsAppLink = (d) => {
  const message = `🙏 Hare Krishna!\n\nDear ${d.donorName} Ji,\n\nYour Prasadam for ${d.bhogeType} on ${fmtDate(d.bhogeDate)} is ready for collection at the Mahaprasadam counter.\n\nTR No: ${d.trNo}\nAmount: ₹${fmt(d.amount)}\n\n🛕 ISKCON Mahaprasadam Seva`;
  return `https://wa.me/91${d.donorMobile}?text=${encodeURIComponent(message)}`;
};

const preacherWhatsAppLink = (d) => {
  const message = `🙏 Hare Krishna Prabhuji,\n\nA Bhoga donation you referred has been recorded:\n\nDonor: ${d.donorName}\nBhoga: ${d.bhogeType} on ${fmtDate(d.bhogeDate)}\nAmount: ₹${fmt(d.amount)}\nTR No: ${d.trNo}\n\n🛕 ISKCON Mahaprasadam Seva`;
  return `https://wa.me/91${d.preacherMobile}?text=${encodeURIComponent(message)}`;
};

// entries: up to 9 donation records (same shape as Donations.jsx's `rowToRecord`)
function DonationLabelPrint({ entries, onClose }) {
  const [fontSize, setFontSize] = useState(12);

  const slots = Array.from({ length: 9 }, (_, i) => entries[i] || null);

  const bumpFont = (delta) => {
    setFontSize((size) => Math.min(20, Math.max(8, size + delta)));
  };

  return (
    <div className="label-print-overlay">
      <div className="label-print-controls">
        <h3>🏷️ Print Donation Labels ({entries.length}/9)</h3>

        <div className="label-print-font-control">
          <span>Font size</span>
          <button type="button" onClick={() => bumpFont(-1)}>A−</button>
          <span className="label-print-font-value">{fontSize}px</span>
          <button type="button" onClick={() => bumpFont(1)}>A+</button>
        </div>

        <div className="label-print-actions">
          <button type="button" className="label-print-close" onClick={onClose}>Close</button>
          <button type="button" className="label-print-go" onClick={() => window.print()}>🖨️ Print</button>
        </div>
      </div>

      <div className="label-print-page-wrap">
        <div className="label-print-page" style={{ fontSize: `${fontSize}px` }}>
          {slots.map((d, i) => (
            <div className={`label-box ${d ? "" : "label-box-empty"}`} key={d?.id || `empty-${i}`}>
              {d && (
                <>
                  <div className="label-temple">🛕 ISKCON Mahaprasadam</div>
                  <div className="label-row label-tr">TR No: <strong>{d.trNo}</strong></div>
                  <div className="label-row label-bhoga">{d.bhogeType}</div>
                  <div className="label-row">Bhoga Date: {fmtDate(d.bhogeDate)}</div>
                  <div className="label-row label-donor">Donor: <strong>{d.donorName}</strong></div>
                  {d.donorMobile && <div className="label-row label-sub">📞 {d.donorMobile}</div>}
                  <div className="label-row label-amount">₹ {fmt(d.amount)}</div>
                  {d.preacherName && (
                    <div className="label-row label-sub">
                      Preacher: {d.preacherName}
                      {d.preacherMobile && ` · 📞 ${d.preacherMobile}`}
                    </div>
                  )}

                  <div className="label-whatsapp-actions">
                    {d.donorMobile && (
                      <a
                        className="label-whatsapp-btn"
                        href={donorWhatsAppLink(d)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        📲 Donor
                      </a>
                    )}
                    {d.preacherMobile && (
                      <a
                        className="label-whatsapp-btn"
                        href={preacherWhatsAppLink(d)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        📲 Preacher
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default DonationLabelPrint;

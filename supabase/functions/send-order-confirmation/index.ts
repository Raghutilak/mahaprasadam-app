import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_ADDRESS = "orders@yourdomain.com"; // must be a verified sender/domain in Resend

// Escapes anything customer-controlled before it goes into the email HTML —
// an order's mobile field (or any other free-text field added here later)
// could otherwise carry HTML/script content that renders in whoever reads
// this email (staff, or the customer's own client), or break the layout.
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Basic shape check — mainly to stop an obviously-malformed value (e.g.
// containing a newline, which could enable header injection in some email
// APIs) from ever reaching the `to` field, not a full RFC 5322 validator.
function looksLikeEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/[\r\n]/.test(value);
}

serve(async (req) => {
  try {
    const payload = await req.json(); // Supabase DB Webhook payload: { type, table, record, old_record }
    const record = payload.record;

    if (!looksLikeEmail(record?.customer_email)) {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid customer_email on record." }), { status: 400 });
    }

    const safeMobile = record.customer_mobile ? escapeHtml(record.customer_mobile) : "your registered mobile number";

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: record.customer_email,
        subject: "We received your sweet order 🍬",
        html: `<p>Thank you! We've received your order and it's currently <strong>pending</strong>.</p>
               <p>We'll be in touch shortly — either by email or at ${safeMobile} —
               with the total amount to pay, how to pay it, and where to collect or receive your order.</p>`,
      }),
    });

    return new Response(JSON.stringify({ ok: res.ok }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});

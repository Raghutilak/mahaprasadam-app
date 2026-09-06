import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_ADDRESS = "orders@yourdomain.com"; // must be a verified sender/domain in Resend

serve(async (req) => {
  try {
    const payload = await req.json(); // Supabase DB Webhook payload: { type, table, record, old_record }
    const record = payload.record;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: record.customer_email,
        subject: "We received your sweet order 🍬",
        html: `<p>Thank you! We've received your order and it's currently <strong>pending</strong>.</p>
               <p>We'll be in touch shortly — either by email or at ${record.customer_mobile || "your registered mobile number"} —
               with the total amount to pay, how to pay it, and where to collect or receive your order.</p>`,
      }),
    });

    return new Response(JSON.stringify({ ok: res.ok }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
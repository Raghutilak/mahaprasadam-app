# Sweet Accounts

> **Status:** Work in progress (~50% complete). Features and structure below reflect the current state of the codebase and are subject to change.

**Deposit Register — Production Accounting** for a temple sweet/prasadam kitchen. Sweet Accounts tracks daily sweet inventory (production, stock, and issues) alongside every sale, credit, donation, and payment recovery, then rolls it all up into a daily closing report.

It's a single-page React app backed directly by Supabase (via REST, no SDK), deployed on Vercel.

## Features

- **Dashboard** — at-a-glance view of opening stock, receipts, issues, and closing stock for the sweets on hand (Peda, Sandesh, Rasagulla, Rasamalai, Sweet Samosa, Cake, Ladoo).
- **Receive** — log incoming stock from production.
- **Cash Sale / Paytm Sale** — record walk-up sales paid by cash or Paytm.
- **Credit Sale** — issue sweets on credit to a department or an individual account holder, with quick-fill templates for repeat transactions.
- **Credit Recovery** — record payments against outstanding department or individual credit.
- **Credit Reports** — department-credit and individual-credit ledgers/reports.
- **Donations** — track Bhoga donations (Balya, Sakalika, Raja, Vaikalika, Sandhya, Shayana Bhoga, and Udayastama) with preacher/donor details, and print donation labels.
- **Auto Bhoga Credits** — once a Bhoga donation of a given type is logged for the day and its scheduled offering time has passed, the app automatically posts the corresponding Department Credit transaction (to the DEITY department) — no manual entry needed. This only runs while the app is open in a browser tab; if no device has it open at the scheduled time, the entry fires the next time the app is opened that day (never early, never twice).
- **Daily Reports** — full end-of-day summary across all sale types and payments.
- **Close Day** — finalize and lock a day's figures.
- **Reset Data** — admin tool to clear records (used sparingly; wipes table data).

## Tech Stack

- **React 19** + **Vite 8** — UI and dev/build tooling
- **Tailwind CSS 4** (via `@tailwindcss/vite`) — styling
- **lucide-react** — icons
- **Supabase** — Postgres database, accessed through a hand-rolled REST client (`src/supabaseClient.js`) rather than the official SDK
- **oxlint** — linting

## Project Structure

```
sweet-accounts/
├── index.html                  # Page shell, fonts, app title
├── public/
│   ├── favicon.svg / stamp.svg / icons.svg
├── src/
│   ├── main.jsx                 # React entry point
│   ├── App.jsx                  # Main app shell, navigation, dashboard, sales flows
│   ├── supabaseClient.js        # Lightweight fetch-based Supabase REST client
│   ├── autoBhogaCredits.js       # Scheduled auto-credit rules for Bhoga offerings
│   ├── data/people.js           # Account holders & carriers master data
│   ├── DepartmentCredit.jsx/.css # Credit sales to departments
│   ├── IndividualCredit.jsx     # Credit sales to individuals
│   ├── CreditReport.jsx/.css    # Credit ledger/report views
│   ├── Donations.jsx/.css       # Bhoga donation tracking
│   ├── DonationLabelPrint.jsx/.css # Printable donation labels
│   ├── DailyReport.jsx          # Daily summary report
│   └── index.css                # Global styles
├── package.json
└── vite.config.js
```

## Getting Started

### Prerequisites

- Node.js (18+ recommended)
- npm

### Install

```bash
npm install
```

### Configure Supabase

The Supabase project URL and public (anon/publishable) key are currently hard-coded in `src/supabaseClient.js`. To point the app at a different Supabase project, update `SUPABASE_URL` and `SUPABASE_KEY` there. The app expects tables such as `department_ledger_entries`, `account_ledger_entries`, and others matching the sale/credit/donation flows, plus RPC functions for atomic multi-row writes (e.g. a sale header + line items + ledger entry in one transaction).

### Run in development

```bash
npm run dev

npm run dev -- --host 0.0.0.0
```

This starts the Vite dev server on `http://localhost:5173`, listening on all network interfaces so it can also be reached from another device (e.g. a phone) on the same Wi-Fi network, using the laptop's LAN IP.

### Lint

```bash
npm run lint
```

### Build for production

```bash
npm run build
```

### Preview a production build

```bash
npm run preview
```

## Deployment

Sweet Accounts is deployed on [Vercel](https://vercel.com). Since it's a static Vite build, Vercel just needs:

- **Build command:** `npm run build`
- **Output directory:** `dist`

Pushing to the connected Git branch triggers a new deployment automatically.

## Notes

- Because `autoBhogaCredits.js` timing logic runs client-side, at least one device needs the app open around each scheduled Bhoga time for the automatic credit to post promptly.
- `deleteAll` in `supabaseClient.js` is a destructive, whole-table wipe intended only for the admin "Reset Data" tool — it is never called from normal sales/credit/donation flows.

Edit → Test → Build → vercel --prod

npm run build
vercel --prod

if error then
npx vercel logout
npx vercel login
vercel --prod

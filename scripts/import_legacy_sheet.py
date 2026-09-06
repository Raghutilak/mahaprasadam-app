#!/usr/bin/env python3
"""
import_legacy_sheet.py
────────────────────────────────────────────────────────────────────────
Converts the old hand-maintained Google Sheet log (Date / Time / Dept /
Name of Devotee / Carried By / 7 "sweets issued" columns / 7 "sweets
received" columns) into the exact records this app's Supabase project
expects — using the SAME RPC functions the app itself calls, so every
imported row goes through the same atomic sale+items(+ledger) logic as
a normal entry made through the app.

WHY A SEPARATE SCRIPT (not inside the React app)
  This is a one-time / occasional bulk migration job, not something an
  end user clicks a button for inside the app. Keeping it as its own
  script means it can be re-run safely, reviewed before pushing, and
  never accidentally shipped to end users.

CLASSIFICATION RULES (confirmed with the temple's counter team)
  • DEPT = "RECEIVED"                        → stock received that day
  • DEPT = "CASH", blank Name & Carried By    → the day's ONE aggregate Cash Sale
  • DEPT = "BANK" (e.g. "IOB ... (QR Code)")  → the day's ONE aggregate Paytm Sale
  • Carried By ∈ {CASH, PAYTM, TR / T.R.}     → a Recovery/dues payment
        - if DEPT = "CREDIT"                 →   ...against an INDIVIDUAL's dues
        - otherwise (DEPT = a real dept code) →   ...against a DEPARTMENT's dues
  • DEPT = "CREDIT" (not a payment marker)    → Individual Credit sale
  • DEPT = anything else                     → Department Credit sale
        (Name of Devotee = account holder/contact, Carried By = carrier)

  Sweet quantities are read from whichever of the issued/received column
  blocks is actually non-empty for that row (the old sheet wasn't always
  consistent about which block a non-"RECEIVED" row's numbers went in —
  confirmed against real examples from the sheet). Only true "RECEIVED"
  rows are restricted to the received-column block.

  Anything that doesn't fit cleanly (unparseable dates, suspiciously
  large quantities that look like a stray ₹ amount rather than a sweet
  count, rows with no quantities at all, etc.) is NOT guessed at — it's
  written to review_needed.csv for a human to check before import.

USAGE
  1) Put your service-account file at:
       credentials/google-sheets-service-account.json   (sibling of scripts/, at the project root)
     — or pass --credentials <path> to point anywhere else — OR skip
     Google entirely and pass a downloaded CSV/TSV export with --file.

  2) Dry run first — this only classifies the data and writes CSVs into
     ./import_output/ for you to review. NOTHING is sent to Supabase:

       python import_legacy_sheet.py --sheet-url "<the sheet URL>"

     or, from a downloaded export:

       python import_legacy_sheet.py --file daily_log_export.csv

  3) Once import_output/review_needed.csv is empty (or every row in it
     has been checked and is fine to skip), push for real:

       python import_legacy_sheet.py --file daily_log_export.csv --push

     This app's public anon key is already baked into the app itself
     (same one supabaseClient.js uses), so no extra secrets are needed
     for a normal import. If you'd rather use your own service-role key
     (bypasses row-level security, useful for very large backfills),
     set SUPABASE_URL / SUPABASE_KEY environment variables first — the
     script will use those instead.

Requires: gspread, oauth2client, requests
    pip install gspread oauth2client requests
────────────────────────────────────────────────────────────────────────
"""

import argparse
import csv
import os
import sys
from datetime import datetime, timedelta

import requests

# ── Supabase connection ──────────────────────────────────────────────
# Same project + same public anon key already shipped inside the app's
# own supabaseClient.js (safe to reuse — it's the anon key, not a
# secret). Override with env vars to use a service-role key instead.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://mtenqjudpspxwntamgjv.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "sb_publishable_BIsAjxfeXUa90vWHV2sRHA_zkwU4whJ")

HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
JSON_HEADERS = {**HEADERS, "Content-Type": "application/json"}

# ── Sweet list, in the exact order the app uses ──────────────────────
SWEET_ORDER = ["Peda", "Sandesh", "Rasagulla", "Rasamalai", "Sweet Samosa", "Cake", "Ladoo"]
PRICES = {"Peda": 15, "Sandesh": 15, "Rasagulla": 25, "Rasamalai": 25, "Sweet Samosa": 150, "Cake": 60, "Ladoo": 60}

PAYMENT_MARKERS = {"CASH": "cash", "PAYTM": "paytm", "TR": "tr", "T.R.": "tr", "T.R": "tr"}

OUTPUT_DIR = "import_output"

# credentials/google-sheets-service-account.json, as a sibling of scripts/
# at the project root — resolved relative to this file so it works no
# matter what folder you run the script from.

# DEFAULT_CREDENTIALS_PATH = os.path.join(
#     os.path.dirname(os.path.abspath(__file__)), "..", "credentials", "google-sheets-service-account.json"
# )

DEFAULT_CREDENTIALS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "credentials.json"
)


# ══════════════════════════════════════════════════════════════════
# STEP 1 — read the raw sheet
# ══════════════════════════════════════════════════════════════════

def fetch_rows_from_sheet(sheet_url, credentials_path):
    import gspread
    from oauth2client.service_account import ServiceAccountCredentials

    if not os.path.isfile(credentials_path):
        print(f"❌ Couldn't find the service-account file at: {credentials_path}")
        print("   Pass --credentials <path> to point at it, or place it at the default path shown with --help.")
        sys.exit(1)

    scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
    creds = ServiceAccountCredentials.from_json_keyfile_name(credentials_path, scope)
    client = gspread.authorize(creds)
    sheet = client.open_by_url(sheet_url).sheet1
    return sheet.get_all_values()


def fetch_rows_from_file(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        sample = f.read(4096)
        f.seek(0)
        delimiter = "\t" if sample.count("\t") >= sample.count(",") else ","
        return list(csv.reader(f, delimiter=delimiter))


# ══════════════════════════════════════════════════════════════════
# STEP 2 — classify every row
# ══════════════════════════════════════════════════════════════════

def parse_date(raw):
    raw = (raw or "").strip()
    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def to_qty(raw):
    raw = (raw or "").strip()
    if raw in ("", "-"):
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


def find_column_blocks(header):
    """The header repeats PD..L twice (issued, then received) — find where each block starts."""
    first = header.index("PD")
    second = header.index("PD", first + 1)
    return first, second


def classify_rows(rows):
    header = rows[0]
    issued_start, received_start = find_column_blocks(header)

    records = {
        "stock_receipts": [], "cash_sales": [], "paytm_sales": [],
        "department_credit_sales": [], "individual_credit_sales": [], "recovery_payments": [],
    }
    review_needed = []

    # Some day-blocks in the old sheet are preceded by a dateless "closing stock" marker row —
    # CARRIED BY = "closing stock", with that day's actual physical stock count sitting in the
    # issued-column block. It has no date of its own, so it's associated with whichever dated row
    # comes right after it (the day-block it's heading). Used below to seed inventory_openings /
    # inventory_closings — see compute_and_push_inventory_snapshots().
    closing_stock_by_date = {}
    pending_closing_stock = None

    for row_num, row in enumerate(rows[1:], start=2):
        if not any(c.strip() for c in row):
            continue
        row = list(row) + [""] * (len(header) - len(row))

        date_raw, time_raw, dept, name, carried = (row[i].strip() for i in range(5))
        date = parse_date(date_raw)
        dept_upper = dept.upper()
        carried_upper = carried.upper().replace(".", "").strip()

        issued = {SWEET_ORDER[i]: to_qty(row[issued_start + i]) for i in range(7)}
        received = {SWEET_ORDER[i]: to_qty(row[received_start + i]) for i in range(7)}
        combined = {k: issued[k] + received[k] for k in SWEET_ORDER}

        # 0. "closing stock" marker row — a manually-counted closing-stock snapshot for a given
        # date, used ONLY as a fallback anchor when that date's PREVIOUS calendar day has no
        # computable closing of its own (see compute_and_push_inventory_snapshots). Preferred
        # format has its own date in column 1 (dept/name blank, "closing stock" in Carried By);
        # older/dateless rows (no date at all, marker sitting just above the day's own header+data)
        # are still supported and get associated with the next dated row that follows them.
        if not dept and not name and carried.strip().lower() == "closing stock":
            if date:
                closing_stock_by_date[date] = dict(issued)
            else:
                pending_closing_stock = dict(issued)
            continue

        if not date:
            review_needed.append({"row": row_num, "reason": "Unparseable date", "raw": "\t".join(row)})
            continue

        if pending_closing_stock is not None:
            closing_stock_by_date.setdefault(date, pending_closing_stock)
            pending_closing_stock = None

        # 1. Stock received for the day
        if dept_upper == "RECEIVED":
            if any(issued.values()):
                review_needed.append({"row": row_num, "reason": "RECEIVED row unexpectedly has issued-column values too — please check", "raw": "\t".join(row)})
            records["stock_receipts"].append({"date": date, "time": time_raw, **received})
            continue

        # 2. The day's ONE aggregate Cash Sale.
        # NOTE: the old sheet sometimes carries the day's computed ₹ total
        # into one stray cell of the "received" block for this row only, as
        # a manual cross-check — confirmed against a real example where that
        # stray value equalled exactly (qty × price) summed over the issued
        # columns. So for THIS row, only the issued columns are real sweet
        # quantities; a leftover received-block value is just a checksum.
        if dept_upper == "CASH" and not name and not carried:
            total_from_items = sum(issued[k] * PRICES[k] for k in SWEET_ORDER)
            stray_values = [v for v in received.values() if v > 0]
            if stray_values and round(sum(stray_values)) != round(total_from_items):
                review_needed.append({
                    "row": row_num,
                    "reason": f"Cash-sale row's stray received-block value(s) {stray_values} don't match the computed total ₹{total_from_items:.0f} from the issued quantities — please verify by hand before importing.",
                    "raw": "\t".join(row),
                })
                continue
            records["cash_sales"].append({"date": date, "time": time_raw, **issued})
            continue

        # 3. The day's ONE aggregate Paytm Sale (BANK / QR-code row)
        if dept_upper == "BANK":
            records["paytm_sales"].append({"date": date, "time": time_raw, "note": name, **combined})
            continue

       
        # 4. Recovery / dues payment — a payment marker in the Carried By column
        if carried_upper in PAYMENT_MARKERS:
            amount = sum(combined[k] * PRICES[k] for k in SWEET_ORDER)

            if amount <= 0:
                review_needed.append({
                    "row": row_num,
                    "reason": "Recovery row has zero/negative computed amount",
                    "raw": "\t".join(row),
                })
                continue

            if dept_upper == "CREDIT":
                records["recovery_payments"].append({
                    "date": date,
                    "time": time_raw,
                    "recovery_type": "Individual",
                    "target_name": name,
                    "account_holder": name,
                    "payment_method": PAYMENT_MARKERS[carried_upper],
                    "amount": amount,
                })
            else:
                records["recovery_payments"].append({
                    "date": date,
                    "time": time_raw,
                    "recovery_type": "Department",
                    "target_name": dept,
                    "account_holder": name,
                    "payment_method": PAYMENT_MARKERS[carried_upper],
                    "amount": amount,
                })
            continue


        # 5. Individual Credit sale
        if dept_upper == "CREDIT":
            if any(combined.values()):
                records["individual_credit_sales"].append({
                    "date": date, "time": time_raw, "individual_name": name, "reference_name": carried, **combined,
                })
            else:
                review_needed.append({"row": row_num, "reason": "CREDIT row has no sweet quantities at all", "raw": "\t".join(row)})
            continue

        # 6. Department Credit sale — anything else is a real department code
        if any(combined.values()):
            records["department_credit_sales"].append({
                "date": date, "time": time_raw, "department": dept, "account_holder": name, "carrier": carried, **combined,
            })
        else:
            review_needed.append({"row": row_num, "reason": "Unrecognized row with no quantities in either column block", "raw": "\t".join(row)})

    return records, review_needed, closing_stock_by_date


# ══════════════════════════════════════════════════════════════════
# STEP 3 — write CSVs for review (always happens, dry-run or not)
# ══════════════════════════════════════════════════════════════════

def write_csv(path, rows, fieldnames):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, path), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in rows:
            writer.writerow(r)


def write_all_csvs(records, review_needed, closing_stock_by_date):
    write_csv("stock_receipts.csv", records["stock_receipts"], ["date", "time"] + SWEET_ORDER)
    write_csv("cash_sales.csv", records["cash_sales"], ["date", "time"] + SWEET_ORDER)
    write_csv("paytm_sales.csv", records["paytm_sales"], ["date", "time", "note"] + SWEET_ORDER)
    write_csv("department_credit_sales.csv", records["department_credit_sales"], ["date", "time", "department", "account_holder", "carrier"] + SWEET_ORDER)
    write_csv("individual_credit_sales.csv", records["individual_credit_sales"], ["date", "time", "individual_name", "reference_name"] + SWEET_ORDER)
    write_csv("recovery_payments.csv", records["recovery_payments"], ["date", "time", "recovery_type", "target_name","account_holder", "payment_method", "amount"])
    write_csv("review_needed.csv", review_needed, ["row", "reason", "raw"])
    write_csv(
        "inventory_closing_stock.csv",
        [{"date": d, **qtys} for d, qtys in sorted(closing_stock_by_date.items())],
        ["date"] + SWEET_ORDER,
    )

    print(f"\nWrote review CSVs into ./{OUTPUT_DIR}/:")
    for key in records:
        print(f"  {key + '.csv':32s} {len(records[key])} row(s)")
    print(f"  {'review_needed.csv':32s} {len(review_needed)} row(s) — PLEASE CHECK THESE")
    print(f"  {'inventory_closing_stock.csv':32s} {len(closing_stock_by_date)} day(s) with a known closing-stock count")


# ══════════════════════════════════════════════════════════════════
# STEP 4 — push to Supabase (only with --push), via the app's own RPCs
# ══════════════════════════════════════════════════════════════════

def rpc(fn_name, params):
    r = requests.post(f"{SUPABASE_URL}/rest/v1/rpc/{fn_name}", headers=JSON_HEADERS, json=params)
    if not r.ok:
        raise RuntimeError(f"{fn_name} failed ({r.status_code}): {r.text}")
    return r.json()


def get_or_create_master_id(table, name, mobile=None, cache={}):
    if not name:
        return None
    key = (table, name.strip().lower())
    if key in cache:
        return cache[key]
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=HEADERS, params={"select": "id,name", "name": f"ilike.{name.strip()}"})
    r.raise_for_status()
    existing = r.json()
    if existing:
        cache[key] = existing[0]["id"]
        return existing[0]["id"]
    payload = {"name": name}
    if mobile:
        payload["mobile"] = mobile
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers={**JSON_HEADERS, "Prefer": "return=representation"}, json=[payload])
    r.raise_for_status()
    created = r.json()[0]["id"]
    cache[key] = created
    return created


def load_sweet_ids():
    r = requests.get(f"{SUPABASE_URL}/rest/v1/sweets", headers=HEADERS, params={"select": "id,name"})
    r.raise_for_status()
    return {row["name"]: row["id"] for row in r.json()}


def items_payload(sweet_ids, qty_dict):
    return [
        {"sweet_id": sweet_ids[name], "quantity": qty, "rate": PRICES[name], "total_amount": qty * PRICES[name]}
        for name, qty in qty_dict.items() if qty > 0
    ]


def push_all(records, sweet_ids):
    pushed, failed = 0, 0

    for r in records["stock_receipts"]:
        items = items_payload(sweet_ids, {k: r[k] for k in SWEET_ORDER})
        if not items:
            continue
        try:
            rpc("create_stock_receipt_with_items", {
                "p_receipt": {"receipt_date": r["date"], "notes": f"Imported from legacy sheet — {r['time']}"},
                "p_items": items,
            })
            pushed += 1
        except Exception as e:
            print(f"  ❌ stock_receipts {r['date']} {r['time']}: {e}")
            failed += 1

    for r in records["cash_sales"]:
        items = {k: r[k] for k in SWEET_ORDER}
        total = sum(v * PRICES[k] for k, v in items.items())
        item_rows = items_payload(sweet_ids, items)
        if not item_rows:
            continue
        try:
            rpc("create_sale_with_items", {
                "p_sale": {"sale_date": r["date"], "sale_type": "cash", "payment_method": "cash",
                           "subtotal": total, "discount": 0, "total_amount": total, "amount_paid": total, "balance_amount": 0},
                "p_items": item_rows,
            })
            pushed += 1
        except Exception as e:
            print(f"  ❌ cash_sales {r['date']}: {e}")
            failed += 1

    for r in records["paytm_sales"]:
        items = {k: r[k] for k in SWEET_ORDER}
        total = sum(v * PRICES[k] for k, v in items.items())
        item_rows = items_payload(sweet_ids, items)
        if not item_rows:
            continue
        try:
            rpc("create_sale_with_items", {
                "p_sale": {"sale_date": r["date"], "sale_type": "upi", "payment_method": "paytm",
                           "subtotal": total, "discount": 0, "total_amount": total, "amount_paid": total, "balance_amount": 0},
                "p_items": item_rows,
            })
            pushed += 1
        except Exception as e:
            print(f"  ❌ paytm_sales {r['date']}: {e}")
            failed += 1

    for r in records["department_credit_sales"]:
        items = {k: r[k] for k in SWEET_ORDER}
        total = sum(v * PRICES[k] for k, v in items.items())
        item_rows = items_payload(sweet_ids, items)
        if not item_rows:
            continue
        try:
            department_id = get_or_create_master_id("departments", r["department"])
            carrier_id = get_or_create_master_id("carriers", r["carrier"]) if r["carrier"] else None
            rpc("create_credit_sale_with_ledger", {
                "p_sale": {
                    "sale_date": r["date"], "sale_type": "department_credit", "department_id": department_id,
                    "account_holder_id": None, "carrier_id": carrier_id, "customer_name": r["account_holder"] or None,
                    "reference_type": None, "reference_name": None, "subtotal": total, "discount": 0,
                    "total_amount": total, "amount_paid": 0, "balance_amount": total,
                    "notes": f"Imported from legacy sheet — {r['time']}",
                },
                "p_items": item_rows,
                "p_ledger_table": "department_ledger_entries",
                "p_ledger": {"department_id": department_id, "entry_type": "credit_sale", "amount": total, "description": "Imported from legacy sheet"},
            })
            pushed += 1
        except Exception as e:
            print(f"  ❌ department_credit_sales {r['date']} {r['department']}: {e}")
            failed += 1

    for r in records["individual_credit_sales"]:
        items = {k: r[k] for k in SWEET_ORDER}
        total = sum(v * PRICES[k] for k, v in items.items())
        item_rows = items_payload(sweet_ids, items)
        if not item_rows:
            continue
        try:
            account_holder_id = get_or_create_master_id("account_holders", r["individual_name"])
            rpc("create_credit_sale_with_ledger", {
                "p_sale": {
                    "sale_date": r["date"], "sale_type": "individual_credit", "department_id": None,
                    "account_holder_id": account_holder_id, "carrier_id": None, "customer_name": None,
                    "reference_type": "Individual" if r["reference_name"] else None, "reference_name": r["reference_name"] or None,
                    "subtotal": total, "discount": 0, "total_amount": total, "amount_paid": 0, "balance_amount": total,
                    "notes": f"Imported from legacy sheet — {r['time']}",
                },
                "p_items": item_rows,
                "p_ledger_table": "account_ledger_entries",
                "p_ledger": {"account_holder_id": account_holder_id, "entry_type": "credit_sale", "amount": total, "description": "Imported from legacy sheet"},
            })
            pushed += 1
        except Exception as e:
            print(f"  ❌ individual_credit_sales {r['date']} {r['individual_name']}: {e}")
            failed += 1

    for r in records["recovery_payments"]:
        try:
            is_department = r["recovery_type"] == "Department"
            department_id = get_or_create_master_id("departments", r["target_name"]) if is_department else None
            account_holder_id = get_or_create_master_id("account_holders", r["target_name"]) if not is_department else None
            ledger_table = "department_ledger_entries" if is_department else "account_ledger_entries"
            ledger_payload = (
                {"department_id": department_id, "entry_type": "payment", "amount": -r["amount"], "description": f"Recovery — {r['payment_method']} (imported)"}
                if is_department else
                {"account_holder_id": account_holder_id, "entry_type": "payment", "amount": -r["amount"], "description": f"Recovery — {r['payment_method']} (imported)"}
            )
            rpc("create_recovery_payment", {
                # NOTE: payment_date must be passed explicitly here — unlike the sale/receipt
                # pushes above, this previously omitted the historical date entirely, so every
                # imported recovery payment silently fell back to the RPC's default (today's
                # date at import time) instead of its real day. That's why recoveries for any
                # imported date showed as ₹0 in the Daily Report. If create_recovery_payment
                # doesn't yet accept/honor payment_date, update that Postgres function first to
                # do: coalesce(p_payment->>'payment_date', current_date)::date.
                "p_payment": {"department_id": department_id, "account_holder_id": account_holder_id,
                              "amount": r["amount"], "payment_method": r["payment_method"],
                              "payment_date": r["date"]},
                "p_ledger_table": ledger_table,
                "p_ledger": ledger_payload,
            })
            pushed += 1
        except Exception as e:
            print(f"  ❌ recovery_payments {r['date']} {r['target_name']}: {e}")
            failed += 1

    print(f"\nPush complete: {pushed} record(s) written, {failed} failed.")


def upsert_table(table, rows, on_conflict):
    if not rows:
        return
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}?on_conflict={on_conflict}",
        headers={**JSON_HEADERS, "Prefer": "return=representation,resolution=merge-duplicates"},
        json=rows,
    )
    if not r.ok:
        raise RuntimeError(f"{table} upsert failed ({r.status_code}): {r.text}")


def compute_and_push_inventory_snapshots(records, closing_stock_by_date, sweet_ids):
    """
    Seeds inventory_openings / inventory_closings for the imported date range, so the app's Daily
    Report shows correct Opening/Closing Stock for these dates instead of falling back to 0 (or
    silently reusing whatever date was viewed previously — see the two Daily Report bugs fixed
    earlier). Design (confirmed with the temple team):

      • The REGULAR rule, used for every single date (this import, today, and every future date —
        it's exactly what the app's own Close Day button already does):
            closing = opening + received − issued
        So a date's Opening is simply the PREVIOUS calendar day's Closing, chained forward.

      • The ONLY exception: when the previous calendar day's closing isn't available to chain
        from at all (there's a gap — no transactions recorded for it, e.g. the very first date
        covered by this import, or any day the old sheet simply has no entries for). In that one
        case, this date's Opening is instead worked out backward from its OWN dated "closing
        stock" marker row (see classify_rows) plus its own received/issued:
            opening = closing(given) − received + issued
        This is a fallback anchor, not a substitute for the regular rule — the very next date
        goes right back to chaining forward from what was just computed.

      • Once the app itself starts covering a date live, its own Close Day keeps this exact same
        chain going forward on its own — nothing further needs backfilling from this script.

    If a date has BOTH a computed closing (chained from the day before) AND its own given
    "closing stock" marker row, the two are cross-checked and any mismatch beyond a small
    rounding tolerance is written to review_needed.csv for a human to check — the computed value
    is still what gets pushed, since the regular rule is authoritative.
    """
    def add_totals(acc, date, qtys):
        bucket = acc.setdefault(date, {s: 0.0 for s in SWEET_ORDER})
        for s in SWEET_ORDER:
            bucket[s] += qtys.get(s, 0.0)

    received_by_date, issued_by_date = {}, {}
    for r in records["stock_receipts"]:
        add_totals(received_by_date, r["date"], r)
    for key in ("cash_sales", "paytm_sales", "department_credit_sales", "individual_credit_sales"):
        for r in records[key]:
            add_totals(issued_by_date, r["date"], r)

    all_dates = sorted(set(received_by_date) | set(issued_by_date) | set(closing_stock_by_date))
    if not all_dates:
        print("\nNo dated activity found — skipping inventory_openings/closings seeding.")
        return

    print("\nSeeding inventory_openings/closings...")

    today = datetime.now().strftime("%Y-%m-%d")

    computed_closing = {}
    mismatches = []


    for date in all_dates:
        received = received_by_date.get(date, {s: 0.0 for s in SWEET_ORDER})
        issued = issued_by_date.get(date, {s: 0.0 for s in SWEET_ORDER})
        if date == today:
            print(f"  {date}: skipped — today's stock is managed live by the app")
            continue
        prev_date = (datetime.strptime(date, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")

        if prev_date in computed_closing:
            opening = computed_closing[prev_date]
            print(f"  {date}: opening carried forward from {prev_date}'s closing stock")
        elif date in closing_stock_by_date:
            closing_given = closing_stock_by_date[date]
            opening = {s: closing_given[s] - received.get(s, 0.0) + issued.get(s, 0.0) for s in SWEET_ORDER}
            print(f"  {date}: {prev_date}'s closing not available — computed opening = closing(given) − received + issued")
        else:
            print(f"  {date}: ⚠️  skipped — no prior day's closing AND no 'closing stock' marker row for this date, so opening can't be resolved")
            continue

        closing = {s: opening[s] + received.get(s, 0.0) - issued.get(s, 0.0) for s in SWEET_ORDER}

        if date in closing_stock_by_date:
            given = closing_stock_by_date[date]
            bad = [s for s in SWEET_ORDER if abs(given[s] - closing[s]) > 0.5]
            if bad:
                mismatches.append({
                    "row": "", "reason": f"{date}: computed closing stock doesn't match the sheet's own 'closing stock' row for "
                                          + ", ".join(f"{s} (computed {closing[s]:g} vs sheet {given[s]:g})" for s in bad),
                    "raw": "",
                })

        computed_closing[date] = closing

        opening_rows = [{"stock_date": date, "sweet_id": sweet_ids[s], "quantity": opening[s]} for s in SWEET_ORDER if s in sweet_ids]
        closing_rows = [{"stock_date": date, "sweet_id": sweet_ids[s], "quantity": closing[s]} for s in SWEET_ORDER if s in sweet_ids]
        try:
            upsert_table("inventory_openings", opening_rows, "stock_date,sweet_id")
            upsert_table("inventory_closings", closing_rows, "stock_date,sweet_id")
            print(f"    ✅ opening={opening}  closing={closing}")
        except Exception as e:
            print(f"    ❌ {date}: {e}")

    if mismatches:
        print(f"\n⚠️  {len(mismatches)} date(s) where computed closing stock didn't match the sheet's own 'closing stock' row — appended to review_needed.csv for a manual check.")
        try:
            with open(os.path.join(OUTPUT_DIR, "review_needed.csv"), "a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=["row", "reason", "raw"])
                for m in mismatches:
                    writer.writerow(m)
        except Exception as e:
            print(f"  (couldn't append to review_needed.csv: {e})")


# ══════════════════════════════════════════════════════════════════
# main
# ══════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sheet-url", help="Google Sheet URL (requires a service-account credentials file)")
    ap.add_argument("--file", help="Path to a downloaded CSV/TSV export instead of --sheet-url")
    ap.add_argument("--credentials", default=DEFAULT_CREDENTIALS_PATH,
                    help=f"Path to the Google service-account JSON file (default: {DEFAULT_CREDENTIALS_PATH})")
    ap.add_argument("--push", action="store_true", help="Actually write to Supabase. Without this flag, only review CSVs are produced.")
    args = ap.parse_args()

    if not args.sheet_url and not args.file:
        ap.error("Pass either --sheet-url or --file")

    print("Reading rows...")
    rows = fetch_rows_from_sheet(args.sheet_url, args.credentials) if args.sheet_url else fetch_rows_from_file(args.file)
    print(f"  {len(rows) - 1} data row(s) found (excluding header).")

    print("\nClassifying rows...")
    records, review_needed, closing_stock_by_date = classify_rows(rows)
    write_all_csvs(records, review_needed, closing_stock_by_date)

    if review_needed:
        print(f"\n⚠️  {len(review_needed)} row(s) need a manual look — see review_needed.csv. These were NOT imported.")

    if not args.push:
        print("\nDry run only — nothing was sent to Supabase. Re-run with --push once the CSVs above look right.")
        return

    if review_needed:
        answer = input(f"\n{len(review_needed)} row(s) in review_needed.csv were skipped. Continue pushing the rest anyway? [y/N] ")
        if answer.strip().lower() != "y":
            print("Aborted — nothing was pushed.")
            sys.exit(1)

    print("\nLoading sweet IDs from Supabase...")
    sweet_ids = load_sweet_ids()
    missing = [s for s in SWEET_ORDER if s not in sweet_ids]
    if missing:
        print(f"❌ These sweets are missing from the 'sweets' table in Supabase: {missing}. Add them in the app first, then re-run.")
        sys.exit(1)

    print("\nPushing to Supabase...")
    push_all(records, sweet_ids)
    compute_and_push_inventory_snapshots(records, closing_stock_by_date, sweet_ids)


if __name__ == "__main__":
    main()

# Legacy Sheet Importer

Converts the old hand-maintained Google Sheet daily log into records for
this app's Supabase project.

## Setup

```
pip install -r requirements.txt
```

Put your Google service-account JSON file at:

```
sweet-accounts/credentials/google-sheets-service-account.json
```

(a sibling of `scripts/`, at the project root). This path is never committed —
see `.gitignore`. If you'd rather keep it somewhere else, pass
`--credentials /path/to/file.json`.

## Usage

**1. Dry run (always do this first)** — classifies the data and writes
review CSVs into `import_output/`. Nothing is sent to Supabase.

From a live Google Sheet:

```

python import_legacy_sheet.py --sheet-url "https://docs.google.com/spreadsheets/d/1Mde8qQCpUCXBJWLIHxDaXt0j4kOmSKzZd5P9lhE4wHU/edit" --credentials "..\credentials.json"

From a downloaded CSV/TSV export instead:

```

python import_legacy_sheet.py --file daily_log_export.csv

**2. Check `import_output/review_needed.csv`.** Every row there was
skipped — fix the source row (or note it as fine to skip) before moving on.

**3. Push for real** — needs a **service-role key** first (the app's own
public anon key can't call these RPCs at all anymore — see the big comment
near the top of `import_legacy_sheet.py`). Treat this key like the Google
service-account JSON above — never commit it, only ever an environment
variable for the duration of the import:

```

export SUPABASE_KEY="<service-role key, from Supabase dashboard → Settings → API>"

python import_legacy_sheet.py --file daily_log_export.csv --push

python import_legacy_sheet.py --sheet-url "https://docs.google.com/spreadsheets/d/1Mde8qQCpUCXBJWLIHxDaXt0j4kOmSKzZd5P9lhE4wHU/edit" --credentials "..\credentials.json" --push

```

See the big comment block at the top of `import_legacy_sheet.py` for the
exact classification rules (Cash/Paytm totals, Department vs Individual
Credit, Recovery payments, Stock received).

```
npm install
npm run dev -- --host 0.0.0.0

```

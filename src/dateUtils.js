// Single source of truth for "what day is it, in the shop's own timezone".
//
// Every date the app treats as "today" — sale_date, the edit-lock check,
// an order's requested_date, a donation's default date, a report's default
// range — must agree with what the database considers today (IST,
// Asia/Kolkata), regardless of the device's own timezone/region settings.
// A phone with the wrong region, or anyone using the app between IST
// midnight and their own local midnight, will otherwise disagree with the
// database about which calendar day it is.
//
// Previously this exact snippet was pasted independently into App.jsx,
// IndividualCredit.jsx and DepartmentCredit.jsx (already correct, just
// duplicated three times), while six other files still used the device's
// local timezone via `new Date().getFullYear()/getMonth()/getDate()`.
// Import from here instead of redefining it locally.


const IST_TIME_ZONE = "Asia/Kolkata";

// "YYYY-MM-DD" for today, in IST — matches Postgres `date` columns and
// the `sale_date` / `bhoge_date` / `requested_date` etc. this app stores.
export const getBusinessDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

// "HH:mm:ss" for the current time, in IST.

export const getBusinessTime = () =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: IST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());

// "YYYY-MM" for the current month, in IST — for report month-pickers
// that default to "this month".

export const getBusinessMonth = () => getBusinessDate().slice(0, 7);

// "YYYY-MM-DD" for `days` days after (or before, if negative) the given
// anchor date (defaults to today, IST). Used for e.g. "tomorrow" pickers.
// Pure calendar-day arithmetic on an ISO date string, so it's safe
// regardless of timezone once the anchor itself is correct.

export const addBusinessDays = (days, anchorISO = getBusinessDate()) => {
  const d = new Date(`${anchorISO}T00:00:00`);
  d.setDate(d.getDate() + days);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};




// ── Darshan image cache date ────────────────────────────────────────────
// GitHub Actions updates the six Darshan photos at 12:30 AM IST.
// Keep using yesterday's cache tag during the midnight hour so the
// frontend doesn't request the new day's cache key before GitHub has
// finished uploading the new photos.
//
// At 1:00 AM IST, the cache tag switches to today's business date.

export const getDarshanCacheDate = () => {
  const businessDate = getBusinessDate();
  const { hour } = getBusinessTime();

  return hour === 0
    ? addBusinessDays(-1, businessDate)
    : businessDate;
};


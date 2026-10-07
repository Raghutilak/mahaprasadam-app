import { useCallback, useEffect, useRef, useState } from "react";
import sb from "./supabaseClient";
import "./AlternateScreens.css";
import { getBusinessDate, addBusinessDays, getBusinessTime } from "./dateUtils";

// ── Sweet photos ──────────────────────────────────────────────────────
// See public/pictures/README.txt — one file per sweet, named exactly
// after the sweet (spaces and all), any of these extensions.
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const SWEET_DISPLAY_ORDER = ["Peda", "Sandesh", "Rasagulla", "Rasamalai", "Sweet Samosa", "Cake", "Ladoo"];

function SweetPhoto({ name }) {
  const [extIndex, setExtIndex] = useState(0);
  if (extIndex >= IMAGE_EXTENSIONS.length) {
    return <div className="alt-sweet-photo alt-sweet-photo-fallback">🍬</div>;
  }
  return (
    <img
      className="alt-sweet-photo"
      src={`/pictures/${encodeURIComponent(name)}.${IMAGE_EXTENSIONS[extIndex]}`}
      alt={name}
      onError={() => setExtIndex((i) => i + 1)}
    />
  );
}

// ── Festival calendar (ISKCON official calendar, Bombay) ───────────────
// Source: https://github.com/Raghutilak/Calendar_Downloader (the
// downloader) → published data at https://github.com/Raghutilak/Calendar_Data.
// City is fixed to Bombay (Mumbai) per instruction — not user-selectable.
const CALENDAR_CITY = "Bombay";
const CALENDAR_BASE = "https://raw.githubusercontent.com/Raghutilak/Calendar_Data/main";

// BreakFast entries are fasting-timing reminders, not festivals in their
// own right — every other category (Appearance, Disappearance, Ekadasi,
// Festival) is what this screen means by "a festival".
const isFestivalEntry = (f) => f && f.category !== "BreakFast";

const todayISO = getBusinessDate;
const addDaysISO = (base, days) => addBusinessDays(days, base);
const formatDateForDisplay = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
};

// Fetches one year's calendar file for Bombay — returns {} (not an error)
// if that year isn't published yet, so callers don't need to special-case it.
const fetchYearCalendar = async (year) => {
  try {
    const res = await fetch(`${CALENDAR_BASE}/${year}/${CALENDAR_CITY}.json`);
    if (!res.ok) return {};
    const json = await res.json();
    return json?.dates || {};
  } catch {
    return {};
  }
};

// Looks today → tomorrow → the nearest day after that (up to ~2 years out,
// which is far more than enough headroom) with an actual festival.
const findFestival = async () => {
  const today = todayISO();
  const [y1, y2] = [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1];
  const [datesY1, datesY2] = await Promise.all([fetchYearCalendar(y1), fetchYearCalendar(y2)]);
  const dates = { ...datesY1, ...datesY2 };

  const festivalsOn = (iso) => (dates[iso]?.festivals || []).filter(isFestivalEntry);

  const todayFestivals = festivalsOn(today);
  if (todayFestivals.length > 0) return { when: "today", date: today, festivals: todayFestivals };

  const tomorrow = addDaysISO(today, 1);
  const tomorrowFestivals = festivalsOn(tomorrow);
  if (tomorrowFestivals.length > 0) return { when: "tomorrow", date: tomorrow, festivals: tomorrowFestivals };

  for (let i = 2; i <= 730; i++) {
    const iso = addDaysISO(today, i);
    const festivals = festivalsOn(iso);
    if (festivals.length > 0) return { when: "upcoming", date: iso, festivals };
  }
  return null;
};

// ── Screen 1 — Available Sweets ─────────────────────────────────────────
function SweetsScreen() {
  const [items, setItems] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [{ data: sweetRows }, { data: stockRows }] = await Promise.all([
          sb.from("sweets").select("id,name,price"),
          sb.rpc("get_public_available_stock"),
        ]);
        const availableByName = {};
        (stockRows || []).forEach((r) => { availableByName[r.sweet_name] = Number(r.available) || 0; });
        const list = (sweetRows || [])
          .map((s) => ({ ...s, available: availableByName[s.name] || 0 }))
          .filter((s) => s.available > 0)
          .sort((a, b) => {
            const ia = SWEET_DISPLAY_ORDER.indexOf(a.name);
            const ib = SWEET_DISPLAY_ORDER.indexOf(b.name);
            if (ia === -1 && ib === -1) return a.name.localeCompare(b.name);
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
          });
        if (!cancelled) setItems(list);
      } catch (e) {
        console.error("Alternate Screens — sweets load error:", e);
        if (!cancelled) setItems([]);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="alt-screen alt-screen-sweets">
      <h1 className="alt-screen-title">🍬 Available Sweets</h1>
      {items === null && <p className="alt-screen-loading">Loading...</p>}
      {items && items.length === 0 && <p className="alt-screen-loading">No sweets currently available.</p>}
      {items && items.length > 0 && (
        <div className="alt-sweets-grid">
          {items.map((s) => (
            <div className="alt-sweet-card" key={s.id}>
              <SweetPhoto name={s.name} />
              <div className="alt-sweet-name">{s.name}</div>
              <div className="alt-sweet-price">₹{s.price}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Screen 2 — Today's Bhoga Donors ─────────────────────────────────────
function DonorsScreen() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await sb.from("donations").selectFilter(
          "id,tr_no,donor_name,bhoge_type,amount",
          // Only donations whose BHOGA DATE is today (not the date the donation
          // was recorded) — so advance donations for later dates don't show up
          // early, and advance donations offered today do.
          `bhoge_date=eq.${todayISO()}&order=id.desc`
        );
        if (error) throw error;
        if (!cancelled) setRows(data || []);
      } catch (e) {
        console.error("Alternate Screens — donors load error:", e);
        if (!cancelled) setRows([]);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const total = (rows || []).reduce((t, r) => t + (Number(r.amount) || 0), 0);

  return (
    <div className="alt-screen alt-screen-donors">
      <h1 className="alt-screen-title">🙏 Today's Bhoga Donors</h1>
      {rows === null && <p className="alt-screen-loading">Loading...</p>}
      {rows && rows.length === 0 && <p className="alt-screen-loading">No Bhoga donations for today yet.</p>}
      {rows && rows.length > 0 && (
        <>
          <div className="alt-donors-list">
            {rows.map((d) => (
              <div className="alt-donor-row" key={d.id}>
                <div className="alt-donor-name">
                  {d.donor_name || "Anonymous"}
                  {d.tr_no && <span className="alt-donor-trno"> (TR No: {d.tr_no})</span>}
                </div>
                <div className="alt-donor-purpose">
                  {d.bhoge_type || "—"}
                  {d.bhoge_type === "Udayastama" && " — Full Day (all 6 Bhogas)"}
                </div>
                <div className="alt-donor-amount">₹{d.amount}</div>
              </div>
            ))}
          </div>
          <div className="alt-donors-total">Total Today: ₹{total}</div>
        </>
      )}
    </div>
  );
}

// ── Screen 3 — Festival ──────────────────────────────────────────────
function FestivalScreen() {
  const [result, setResult] = useState(undefined); // undefined = loading, null = fetch failed entirely

  useEffect(() => {
    let cancelled = false;
    findFestival().then((r) => { if (!cancelled) setResult(r === undefined ? null : r); });
    return () => { cancelled = true; };
  }, []);

  const headingByWhen = { today: "🎉 Today's Festival", tomorrow: "🎉 Tomorrow's Festival", upcoming: "🎉 Upcoming Festival" };

  return (
    <div className="alt-screen alt-screen-festival">
      {result === undefined && <p className="alt-screen-loading">Loading...</p>}
      {result === null && <p className="alt-screen-loading">Could not reach the festival calendar right now.</p>}
      {result && (
        <>
          <h1 className="alt-screen-title">{headingByWhen[result.when]}</h1>
          <div className="alt-festival-date">{formatDateForDisplay(result.date)}</div>
          <div className="alt-festival-list">
            {result.festivals.map((f, i) => (
              <div className="alt-festival-item" key={i}>{f.title}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Screen 4 — Deities (altar-closed darshan photos) ────────────────────
// Three altar photos per aarati (mangal in the morning, sringar the rest of
// the day) — you overwrite these same six files in place in the GitHub repo
// each day with that day's photo, so the URLs themselves never change.
// Browsers cache images by URL though, so without the "?v=" tag below, a
// visitor whose browser already cached yesterday's file at this exact URL
// could keep seeing yesterday's photo even after today's has been uploaded.
// Appending today's IST business date makes the browser treat it as a
// brand-new URL once a day, forcing a fresh fetch — no manual cache-
// clearing needed on your end.
const MANGAL_PHOTO_URLS = [
  "https://raw.githubusercontent.com/Raghutilak/e-darshan/main/mangala-1.jpg",
  "https://raw.githubusercontent.com/Raghutilak/e-darshan/main/mangala-2.jpg",
  "https://raw.githubusercontent.com/Raghutilak/e-darshan/main/mangala-3.jpg",
];
const SRINGAR_PHOTO_URLS = [
  "https://raw.githubusercontent.com/Raghutilak/e-darshan/main/sringar-1.jpg",
  "https://raw.githubusercontent.com/Raghutilak/e-darshan/main/sringar-2.jpg",
  "https://raw.githubusercontent.com/Raghutilak/e-darshan/main/sringar-3.jpg",
];
const ALL_DEITY_PHOTO_URLS = [...MANGAL_PHOTO_URLS, ...SRINGAR_PHOTO_URLS];

// How long each of the three altar photos stays on screen before advancing
// to the next one, while the Deities screen itself is showing.
const DEITY_PHOTO_SECONDS = 8;

// Fetches today's deity photos (all six — both mangal and sringar sets)
// into the browser's cache in the background, as soon as the display loads
// — well before the rotation ever reaches the Deities screen, and before
// either aarati's window even opens. Without this, the first time each day
// the rotation lands on Deities, the browser has to fetch that photo fresh
// from GitHub (a second or so), causing a visible delay/blank flash right
// as the screen switches. Once fetched here, the browser already has it
// cached, so the real on-screen switch later is instant — this just does
// that fetch early, while some other screen is showing.
const preloadDeityPhotos = () => {
  const cacheBustTag = getBusinessDate();
  ALL_DEITY_PHOTO_URLS.forEach((url) => {
    const img = new Image();
    img.src = `${url}${url.includes("?") ? "&" : "?"}v=${cacheBustTag}`;
  });
};

// Cycles through the given set of 3 (or however many) photo URLs one at a
// time, advancing every DEITY_PHOTO_SECONDS — a small rotation of its own,
// nested inside the Deities screen's slot in the main Sweets/Donors/
// Festival/Deities rotation above it.
function DeityScreen({ photoUrls, label }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const cacheBustTag = getBusinessDate(); // changes once per IST day

  useEffect(() => {
    setPhotoIndex(0); // start from the first altar whenever the active set changes (e.g. mangal → sringar)
    const id = setInterval(
      () => setPhotoIndex((i) => (i + 1) % photoUrls.length),
      DEITY_PHOTO_SECONDS * 1000
    );
    return () => clearInterval(id);
  }, [photoUrls]);

  const url = photoUrls[photoIndex];
  return (
    <div className="alt-screen alt-screen-deities">
      <h1 className="alt-screen-title">🙏 {label} Darshan</h1>
      <img
        key={url}
        className="alt-deity-photo-single"
        src={`${url}${url.includes("?") ? "&" : "?"}v=${cacheBustTag}`}
        alt={`${label} darshan, altar ${photoIndex + 1}`}
      />
    </div>
  );
}

// The Deities screen should only appear in the rotation while the altar
// curtain is actually closed — outside these windows there's no new photo
// to show, so it's left out of the rotation entirely rather than repeating
// a stale/irrelevant image. All times are IST (Asia/Kolkata) to match the
// temple's actual schedule, regardless of what timezone the display
// device's own clock happens to be set to.
//
// Each entry is [startMinutesSinceMidnight, endMinutesSinceMidnight, which
// aarati's photos to show during that window]. The last window (9:00 PM –
// 4:30 AM) wraps past midnight, handled below by treating start > end as
// "spans midnight".

const ALTAR_CLOSED_WINDOWS = [
  [4 * 60 + 58, 7 * 60 + 13, "mangal"],     // 5:00 AM – 7:15 AM
  [7 * 60 + 58, 8 * 60 + 30, "sringar"],    // 8:00 AM – 8:30 AM
  [11 * 60 + 45, 12 * 60 + 30, "sringar"],  // 11:45 AM – 12:30 PM
  [12 * 60 + 55, 16 * 60 + 15, "sringar"],  // 1:00 PM – 4:15 PM
  [20 * 60 + 55, 4 * 60 + 25, "sringar"],   // 9:00 PM – 4:30 AM (wraps past midnight)
];

// Wraps whichever screen is currently showing. If that screen's content is
// taller than the space available (e.g. "Available Sweets" with many items
// stacked up), instead of silently clipping it top and bottom, this measures
// the overflow and slowly auto-scrolls down through it and back up, in a
// loop — since this is an unattended kiosk display, every screen needs to
// reveal itself on its own rather than relying on someone to scroll.

function AutoScroll({ children }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const PIXELS_PER_SECOND = 40; // scroll speed
    const PAUSE_MS = 1500;        // pause at top/bottom before reversing
    let rafId;
    let start = null;

    const step = (timestamp) => {
      const maxScroll = el.scrollHeight - el.clientHeight;

      if (maxScroll > 0) {
        if (start === null) start = timestamp;
        const downMs = (maxScroll / PIXELS_PER_SECOND) * 1000;
        const t = (timestamp - start) % (downMs * 2 + PAUSE_MS * 2);

        if (t < downMs) el.scrollTop = (t / downMs) * maxScroll;
        else if (t < downMs + PAUSE_MS) el.scrollTop = maxScroll;
        else if (t < downMs * 2 + PAUSE_MS) el.scrollTop = maxScroll - ((t - downMs - PAUSE_MS) / downMs) * maxScroll;
        else el.scrollTop = 0;
      } else {
        start = null; // reset so timing restarts cleanly once overflow appears
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div className="alt-autoscroll" ref={scrollRef}>
      {children}
    </div>
  );
}


// Returns "mangal", "sringar", or null (altar currently open) depending on
// the time of day right now, IST.

const getActiveDarshanSet = () => {
  const [hour, minute] = getBusinessTime().split(":").map(Number);
  const nowMinutes = hour * 60 + minute;

  const match = ALTAR_CLOSED_WINDOWS.find(([start, end]) =>
    start <= end
      ? nowMinutes >= start && nowMinutes < end
      : nowMinutes >= start || nowMinutes < end
  );

  return match ? match[2] : null;
};


const isAltarClosedNow = () => getActiveDarshanSet() !== null;

// ── Rotation shell — full-screen, cycles Sweets → Donors → Festival, plus
// Deities whenever the altar is currently closed ─────────────────────────
const BASE_SCREENS = [
  { key: "sweets", render: () => <SweetsScreen /> },
  { key: "donors", render: () => <DonorsScreen /> },
  { key: "festival", render: () => <FestivalScreen /> },
];

console.log("DARSHAN CHECK:", getActiveDarshanSet());


const buildScreens = () => {
  const activeSet = getActiveDarshanSet(); // "mangal" | "sringar" | null
  if (!activeSet) return BASE_SCREENS;
  const isMangal = activeSet === "mangal";
  const deityScreen = {
    key: "deities",
    render: () => (
      <DeityScreen
        photoUrls={isMangal ? MANGAL_PHOTO_URLS : SRINGAR_PHOTO_URLS}
        label={isMangal ? "Mangal" : "Sringar"}
      />
    ),
  };
  return [...BASE_SCREENS, deityScreen];
};

export default function AlternateScreens() {
  const [running, setRunning] = useState(false);
  const [screenIndex, setScreenIndex] = useState(0);
  const [intervalMinutes, setIntervalMinutes] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  // Which screens are currently in the rotation. Recomputed periodically
  // below so Deities fades in/out on its own as each altar-closed window
  // opens or ends — no need to restart the display for that to take effect.
  // const [screens, setScreens] = useState(buildScreens());
  const [screens, setScreens] = useState(buildScreens());

  const containerRef = useRef(null);
  const rotationTimerRef = useRef(null);
  const hideControlsTimerRef = useRef(null);
  // Mirrors `screens` for the rotation timer's setInterval callback below,
  // which is created once (via useCallback with no deps) and would otherwise
  // keep closing over whatever `screens` was at that moment — going stale
  // the next time the altar schedule adds/removes the Deities screen.
  const screensRef = useRef(screens);
  useEffect(() => { screensRef.current = screens; }, [screens]);

  // Re-check the altar schedule every minute so Deities appears/disappears
  // from the rotation right on schedule while the display keeps running.
  // useEffect(() => {
  //   const id = setInterval(() => setScreens(buildScreens()), 60 * 1000);
  //   return () => clearInterval(id);
  // }, []);

  useEffect(() => {
    setScreens(buildScreens());

    const id = setInterval(() => {
      setScreens(buildScreens());
    }, 60 * 1000);

    return () => clearInterval(id);
  }, []);



  // Preload today's deity photos as soon as the display loads (see
  // preloadDeityPhotos above), then again once a day right after midnight
  // IST so the NEXT day's freshly-uploaded photo is also pre-fetched well
  // ahead of whenever the first altar-closed window of that new day begins.
  useEffect(() => {
    preloadDeityPhotos();
    let lastPreloadedDate = getBusinessDate();
    const id = setInterval(() => {
      const today = getBusinessDate();
      if (today !== lastPreloadedDate) {
        lastPreloadedDate = today;
        preloadDeityPhotos();
      }
    }, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // If the screen list just shrank (e.g. Deities dropped out) and the
  // current index no longer exists, snap back to the first screen instead
  // of rendering nothing.
  useEffect(() => {
    if (screenIndex >= screens.length) setScreenIndex(0);
  }, [screens, screenIndex]);

  // (Re)starts the rotation timer — called on start and whenever the
  // interval length changes, so a change takes effect immediately rather
  // than waiting out whatever was left of the old interval.
  const restartRotationTimer = useCallback((minutes) => {
    if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
    rotationTimerRef.current = setInterval(() => {
      setScreenIndex((i) => (i + 1) % screensRef.current.length);
    }, minutes * 60 * 1000);
  }, []);

  const start = async () => {
    setScreenIndex(0);
    setRunning(true);
    restartRotationTimer(intervalMinutes);
    try {
      if (containerRef.current?.requestFullscreen) {
        await containerRef.current.requestFullscreen();
      }
    } catch (e) {
      console.error("Alternate Screens — fullscreen request failed:", e);
      // Not fatal — rotation still runs, just not full-screen (some browsers
      // require extra permissions/HTTPS for Fullscreen API).
    }
  };

  const stop = () => {
    setRunning(false);
    if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  // If the admin exits full-screen directly (Esc key), stop the rotation
  // too rather than leaving it running invisibly in a windowed state.
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && running) stop();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => () => { if (rotationTimerRef.current) clearInterval(rotationTimerRef.current); }, []);

  const adjustMinutes = (delta) => {
    setIntervalMinutes((m) => {
      const next = Math.max(1, m + delta);
      if (running) restartRotationTimer(next);
      return next;
    });
  };

  // Controls appear on any mouse move / touch, then hide themselves again
  // after a few seconds of no activity — the display underneath stays
  // full-screen the whole time either way.
  const showControlsBriefly = () => {
    setControlsVisible(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  };

  useEffect(() => {
    if (!running) return undefined;
    showControlsBriefly();
    return () => { if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  if (!running) {
    return (
      <div className="alt-setup">
        <h2>🖥️ Alternate Screens</h2>
        <p>
          A full-screen rotating display for a shop TV or wall screen — cycles automatically between
          Available Sweets, Today's Bhoga Donors, and the Festival calendar, one minute at a time by default.
          A Deities darshan screen also joins the rotation automatically whenever the altar curtain is
          currently closed (5:00–7:15 AM, 11:30 AM–12:30 PM, 1:00–4:15 PM, 9:00 PM–4:30 AM), and drops out again once it reopens.
        </p>
        <label className="alt-setup-interval">
          Rotate every
          <button type="button" onClick={() => adjustMinutes(-1)}>−</button>
          <strong>{intervalMinutes} min</strong>
          <button type="button" onClick={() => adjustMinutes(1)}>+</button>
        </label>
        <button className="alt-setup-start" onClick={start}>▶ Start Full-Screen Display</button>
        <p className="alt-setup-hint">
          Once running, move the mouse or tap the screen at any time to bring up Exit and speed controls —
          they fade away again on their own so the display stays clean.
        </p>
      </div>
    );
  }

  return (
    <div
      className="alt-fullscreen-root"
      ref={containerRef}
      onMouseMove={showControlsBriefly}
      onTouchStart={showControlsBriefly}
    >
      <AutoScroll key={screens[screenIndex]?.key}>
        {screens[screenIndex]?.render()}
      </AutoScroll>

      <div className={`alt-controls ${controlsVisible ? "visible" : ""}`}>
        <button onClick={() => adjustMinutes(-1)} title="Decrease rotation time by 1 minute">−1 min</button>
        <span className="alt-controls-interval">{intervalMinutes} min</span>
        <button onClick={() => adjustMinutes(1)} title="Increase rotation time by 1 minute">+1 min</button>
        <button
          onClick={() => setScreenIndex((i) => (i + 1) % screens.length)}
          title="Skip to next screen"
        >
          ⏭ Next
        </button>
        <button className="alt-controls-exit" onClick={stop}>✖ Exit</button>
      </div>
    </div>
  );
}























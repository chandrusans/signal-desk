// Signal Desk — next-earnings dates from the nightly calendar file (data/earnings.json).
//
// Why a file: NASDAQ's per-stock "earnings-date" endpoint stopped carrying dates (it answers
// "our vendor hasn't provided the upcoming earnings report date" for every symbol), which left
// the 5-day earnings gate with nothing to read. NASDAQ's day-by-day calendar still works, so a
// nightly job (tools/build-earnings.mjs) walks the next five weeks of it and, for S&P 500 names
// that are not on it yet, estimates the next report from the company's own rhythm of SEC 8-K
// item 2.02 filings. Estimates are flagged; nothing here claims a confirmed date it does not have.
//
// File shape: { builtAt, calendarFrom, calendarThrough, dates: { "KMI": ["2027-01-20", "c", "post"] } }
//   kind  "c" = on the published calendar · "e" = estimated from past filings
//   when  "pre" | "post" | null  (before the open / after the close)

const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
/** One key for BRK.B / BRK-B / BRK/B. */
export const calKey = (sym) => String(sym || '').trim().toUpperCase().replace(/[.\-/ ]/g, '.');

/**
 * Collapse 8-K item 2.02 filing dates to one per quarter: a pre-announcement and the report
 * itself land weeks apart, and only the report sets the rhythm. Keeps the LAST of each cluster.
 */
export function quarterlyReports(dates, minGapDays = 45) {
  const out = [];
  for (const d of [...new Set(dates || [])].sort()) {
    if (out.length && (Date.parse(d) - Date.parse(out[out.length - 1])) / DAY < minGapDays) out[out.length - 1] = d;
    else out.push(d);
  }
  return out;
}

/**
 * Estimate the next report date from past ones. Prefers "same quarter last year + 52 weeks"
 * (companies keep their slot in the calendar), falls back to the last report plus the usual gap.
 * An estimate that is already a little overdue is held at today (the report is due any day);
 * one long overdue rolls forward a quarter. Returns 'YYYY-MM-DD' or null.
 */
export function estimateNext(pastDates, today) {
  const q = quarterlyReports(pastDates);
  if (!q.length) return null;
  const last = Date.parse(q[q.length - 1]), now = Date.parse(today);
  if ((now - last) / DAY > 200) return null;                 // stopped reporting (delisted, or filings not found)
  const gaps = []; for (let i = Math.max(1, q.length - 4); i < q.length; i++) gaps.push((Date.parse(q[i]) - Date.parse(q[i - 1])) / DAY);
  gaps.sort((a, b) => a - b);
  const usual = gaps.length ? Math.min(98, Math.max(84, gaps[Math.floor(gaps.length / 2)])) : 91;
  let est = last + usual * DAY;
  const yearAgo = q.map((d) => Date.parse(d)).find((t) => Math.abs(t - (est - 364 * DAY)) <= 20 * DAY);
  if (yearAgo != null) est = yearAgo + 364 * DAY;
  if (est <= last + 60 * DAY) est = last + usual * DAY;
  while (est < now - 10 * DAY) est += 91 * DAY;
  if (est < now) est = now;
  const wd = new Date(est).getUTCDay();                       // reports do not land on weekends
  if (wd === 6) est -= DAY; else if (wd === 0) est += DAY;
  return iso(est);
}

/**
 * The app's { date, daysAway, estimated, when, source } for a symbol, or null when the file has
 * nothing for it or its date has passed.
 */
export function calendarEntry(cal, sym, nowMs = Date.now()) {
  const e = cal?.dates?.[calKey(sym)];
  if (!e || !e[0]) return null;
  const today = iso(nowMs - 5 * 3600e3);                      // the US trading day, near enough for a date compare
  if (e[0] < today) return null;
  return { date: e[0], daysAway: Math.round((Date.parse(e[0]) - Date.parse(today)) / DAY), estimated: e[1] !== 'c', when: e[2] || null, source: e[1] === 'c' ? 'NASDAQ earnings calendar' : 'estimated from past SEC filings' };
}

/**
 * Fallback when the SEC cannot be reached: keep the estimate from the previous file. A date
 * that is still ahead is carried as it is; one that has passed was that quarter's report, so
 * the next is a quarter later (the report dates themselves arrive through the calendar, so
 * this keeps itself going without the SEC). Returns 'YYYY-MM-DD' or null.
 */
export function carryForward(prevEntry, today) {
  const d = prevEntry && prevEntry[0];
  if (!d) return null;
  if (d >= today) return d;
  return estimateNext([d], today);
}

/** Merge calendar rows and estimates into the file's `dates` map. Calendar wins; earliest date per symbol. */
export function buildDates(calendarRows, estimates = {}) {
  const dates = {};
  for (const r of [...calendarRows].sort((a, b) => (a.date < b.date ? -1 : 1))) { const k = calKey(r.symbol); if (k && !dates[k]) dates[k] = [r.date, 'c', r.when || null]; }
  for (const [sym, d] of Object.entries(estimates)) { const k = calKey(sym); if (d && !dates[k]) dates[k] = [d, 'e', null]; }
  return dates;
}

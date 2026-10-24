// Signal Desk — shared UI helpers: escaping and number formatting.
//
// Every page inserts third-party text (news headlines, social posts, company
// and coin names, token symbols) into HTML via template literals. That text is
// attacker-controlled: anyone can post on StockTwits or name a pump.fun token.
// Everything that comes from outside the app goes through esc() for text and
// safeHref() for links. Formatting lives here too, so the Dashboard, Today,
// Alerts and Crypto pages print the same price the same way (sub-dollar coins
// included) and never depend on the browser's locale.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
/** HTML-escape a value for insertion as text or inside a quoted attribute. */
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);

/** Only http(s) URLs survive; anything else (javascript:, data:, relative tricks) becomes '#'. */
export function safeHref(u) {
  try { const x = new URL(String(u || ''), 'https://invalid.local'); return x.protocol === 'http:' || x.protocol === 'https:' ? esc(x.href) : '#'; }
  catch { return '#'; }
}

const US = 'en-US';
/** $1,234.56 — fixed decimals, US formatting regardless of browser locale. */
export const money = (x, d = 2) => (x == null || !isFinite(x) ? '—' : (x < 0 ? '−' : '') + '$' + Math.abs(Number(x)).toLocaleString(US, { minimumFractionDigits: d, maximumFractionDigits: d }));
/** Price with sensible precision: $1,234 above 1,000; $12.34; $0.0000123 for sub-dollar coins. */
export const px = (p) => (p == null || !isFinite(p) ? '—' : p >= 1000 ? money(p, 0) : p >= 1 ? money(p, 2) : p >= 0.01 ? money(p, 4) : '$' + Number(p).toPrecision(3));
/** +1.2% / −0.8% */
export const pct = (x, d = 1, sign = true) => (x == null || !isFinite(x) ? '—' : `${sign && x > 0 ? '+' : ''}${Number(x).toFixed(d)}%`);
/** Plain number with US grouping, 2 dp by default. */
export const num = (x, d = 2) => (x == null || !isFinite(x) ? '—' : Number(x).toLocaleString(US, { minimumFractionDigits: d, maximumFractionDigits: d }));
/** $1.2B / $340M / $12K for large amounts. */
export const big = (x) => (x == null || !isFinite(x) ? '—' : Math.abs(x) >= 1e12 ? '$' + (x / 1e12).toFixed(2) + 'T' : Math.abs(x) >= 1e9 ? '$' + (x / 1e9).toFixed(1) + 'B' : Math.abs(x) >= 1e6 ? '$' + (x / 1e6).toFixed(0) + 'M' : Math.abs(x) >= 1e4 ? '$' + (x / 1e3).toFixed(0) + 'K' : money(x, 0));

/** Parse a number the way a person typed it: "1,5" and "1.5" both read as 1.5; "1,234.5" as 1234.5. */
export function parseNum(s) {
  if (s == null) return NaN;
  let t = String(s).trim().replace(/[$%\s]/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');          // 1,234.5
  else if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');                       // 1,5 (comma decimal)
  else t = t.replace(/,/g, '');
  const n = parseFloat(t);
  return isFinite(n) ? n : NaN;
}

/** The US trading date (New York), YYYY-MM-DD. */
export const tradingDateISO = () => { try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); } catch { return new Date().toISOString().slice(0, 10); } };

/** Weekdays between two ISO dates (a rough count of trading sessions; holidays not removed). */
export function weekdaysBetween(fromISO, toISO = tradingDateISO()) {
  const a = new Date(fromISO + 'T12:00:00Z'), b = new Date(toISO + 'T12:00:00Z');
  if (!(a < b)) return 0;
  let n = 0;
  for (let d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

/** Version check: pages pass the `build` field from any API response. The first value seen
 *  is this tab's build; when a later response carries a different one, a reload bar appears,
 *  so a tab left open across a deploy does not keep old modules polling changed endpoints. */
let seenBuild = null;
export function noteBuild(build) {
  if (!build || typeof document === 'undefined') return;
  if (seenBuild == null) { seenBuild = build; return; }
  if (build === seenBuild || document.getElementById('sd-reload-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'sd-reload-bar';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2000;background:var(--accent,#B8863A);color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center;';
  bar.innerHTML = '<span>Signal Desk was updated. Reload to get the new version.</span><button style="background:#fff;color:#000;border:0;padding:6px 12px;cursor:pointer;font-weight:700;">Reload</button>';
  bar.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
}

// Nightly: build data/earnings.json — the next-earnings date for every stock on NASDAQ's
// published calendar over the next five weeks, plus an estimate for S&P 500 names not on it yet.
// See earnings-calendar.js for why and for the file shape. `npm run earnings:build`.
//
// Exits 2 without writing when the calendar looks broken (too few populated days or symbols),
// so a bad night keeps yesterday's file instead of publishing an empty one. EARNINGS_FORCE=1 overrides.

import fs from 'node:fs';
import path from 'node:path';
import { buildDates, estimateNext, calKey } from '../earnings-calendar.js';
import { earningsDates, cikFor, yahooSym } from './replay-data.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const DAY = 864e5, HORIZON_DAYS = 35;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function calendarDay(d) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); return (j?.data?.rows || []).map((x) => ({ date: d, symbol: x.symbol, when: /pre-market/.test(x.time || '') ? 'pre' : /after-hours/.test(x.time || '') ? 'post' : null })).filter((x) => x.symbol); }
    } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;                                   // could not be read (distinct from "read, and empty")
}

const days = [];
for (let t = Date.parse(today); t <= Date.parse(today) + HORIZON_DAYS * DAY; t += DAY) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) days.push(iso(t)); }
const rows = []; let failed = 0, populated = 0, through = null;
for (const d of days) {
  const r = await calendarDay(d);
  if (r == null) failed++; else if (r.length) { populated++; through = d; rows.push(...r); }
  await sleep(250);
}
console.error(`calendar: ${days.length} weekdays, ${populated} with reports, ${failed} unreadable, ${rows.length} rows, through ${through}`);

// S&P 500 names (from the nightly screen file) that are not on the calendar: estimate from SEC filings.
const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'screen.json'), 'utf8')).rows.map((r) => r.t);
const onCal = new Set(rows.map((r) => calKey(r.symbol)));
const need = universe.filter((t) => !onCal.has(calKey(t)));
const estimates = {}; let i = 0, noFilings = 0;
const since = iso(Date.parse(today) - 800 * DAY);
async function worker() {
  while (i < need.length) {
    const t = need[i++];
    try {
      const cik = await cikFor(yahooSym(t));
      const est = cik ? estimateNext(await earningsDates(cik, since), today) : null;
      if (est) estimates[t] = est; else noFilings++;
    } catch { noFilings++; }
  }
}
await Promise.all([worker(), worker()]);
const dates = buildDates(rows, estimates);
const covered = universe.filter((t) => dates[calKey(t)]).length;
console.error(`S&P 500: ${universe.length - need.length} on the calendar, ${Object.keys(estimates).length} estimated, ${noFilings} without a usable filing history → ${covered}/${universe.length} covered`);

const ok = populated >= 8 && failed <= 5 && rows.length >= 150 && covered >= universe.length * 0.9;
if (!ok && !process.env.EARNINGS_FORCE) { console.error('coverage too low — keeping the previous file'); process.exit(2); }
const out = {
  builtAt: new Date().toISOString(), source: 'NASDAQ earnings calendar; estimates from SEC 8-K item 2.02 filing dates',
  calendarFrom: today, calendarThrough: through,
  counts: { calendar: Object.values(dates).filter((e) => e[1] === 'c').length, estimated: Object.values(dates).filter((e) => e[1] === 'e').length, sp500Covered: covered, sp500: universe.length },
  dates,
};
fs.writeFileSync(path.join(ROOT, 'data', 'earnings.json'), JSON.stringify(out));
console.error(`wrote data/earnings.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB, ${Object.keys(dates).length} symbols)`);

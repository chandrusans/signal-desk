// Data for the ten-year replay (tools/replay.mjs). Fetches and caches, under .cache/replay/:
//
//   • S&P 500 membership by date — today's list plus Wikipedia's change log, walked backwards.
//     This is what removes the survivorship bias of testing on today's members only.
//   • Daily bars (Yahoo chart API, split-adjusted) for every name that was a member at any point
//     in the window, plus SPY and ^VIX. Delisted names mostly return nothing; that gap is counted
//     and reported, never hidden.
//   • Past earnings dates: SEC 8-K filings carrying item 2.02 ("Results of Operations").
//
// Then precomputes, for every ticker and every trading day, exactly the /api/scan row the live
// app would have built that evening: analyze() on the trailing ~1 year of bars with SPY as the
// benchmark. Nothing here looks ahead: day k only ever sees bars up to day k.
//
// Personal research use. Yahoo's terms do not permit redistribution of its data, which is why
// only aggregate results (data/replay.json) are committed, never the bars.

import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { analyze } from '../analyze.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CACHE = path.join(ROOT, '.cache', 'replay');
const UA_WEB = 'Mozilla/5.0 (compatible; SignalDesk research)';
// SEC asks automated clients to identify themselves. A generic name is accepted; set SEC_UA to add a contact.
const UA_SEC = process.env.SEC_UA || 'SignalDesk research script';

fs.mkdirSync(path.join(CACHE, 'bars'), { recursive: true });
fs.mkdirSync(path.join(CACHE, 'sec'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const log = (...a) => console.error(...a);

async function getJSON(url, headers, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 404) return { __status: 404 };
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500 || r.status === 403) { await sleep(1500 * (i + 1)); continue; }
      return { __status: r.status };
    } catch { await sleep(1000 * (i + 1)); }
  }
  return { __status: 'failed' };
}

function cached(file, maxAgeDays, refresh) {
  if (refresh || !fs.existsSync(file)) return null;
  const age = (Date.now() - fs.statSync(file).mtimeMs) / 864e5;
  return age <= maxAgeDays ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// ── Membership ────────────────────────────────────────────────────────────
const wikiHtml = async (page, refresh) => {
  const file = path.join(CACHE, `wiki-${page.replace(/\W+/g, '_')}.json`);
  let j = cached(file, 7, refresh);
  if (!j) {
    j = await getJSON(`https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&formatversion=2`, { 'User-Agent': UA_WEB });
    if (!j?.parse?.text) throw new Error(`Wikipedia page ${page} unavailable`);
    fs.writeFileSync(file, JSON.stringify(j));
  }
  return j.parse.text;
};
const cellText = (s) => s.replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#91;|&#93;/g, '').replace(/&#160;|&nbsp;/g, ' ').trim();
function tableRows(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) throw new Error(`table #${id} not found`);
  const body = html.slice(start, html.indexOf('</table>', start));
  return body.split('<tr').slice(1).map((r) => [...r.matchAll(/<td[^>]*>([\s\S]*?)(?=<td|<\/tr>|$)/g)].map((m) => cellText(m[1]))).filter((r) => r.length);
}
export const yahooSym = (t) => t.trim().toUpperCase().replace(/\./g, '-');
// Symbol changes the name match cannot catch (the company renamed itself too).
const RENAMED = { CDAY: 'DAY', FLT: 'CPAY' };
const normName = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(inc|corp|corporation|co|company|plc|ltd|the|holdings?|group|class [a-z])\b\.?/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Membership intervals for [from, today]: { TICKER: [[startISO, endISO|null], ...] } where end is exclusive.
 * Also returns names, CIKs for current members, and any change-log rows it could not reconcile.
 */
export async function membership(from, { refresh = false } = {}) {
  const cur = tableRows(await wikiHtml('List_of_S&P_500_companies', refresh), 'constituents');
  const changes = tableRows(await wikiHtml('Historical_components_of_the_S&P_500', refresh), 'changes')
    .filter((r) => r.length >= 6)
    .map(([date, addT, addN, remT, remN, reason]) => ({ date: iso(Date.parse(date + ' UTC')), addT: addT ? yahooSym(addT) : null, addN, remT: remT ? yahooSym(remT) : null, remN, reason }))
    .filter((c) => c.date && c.date !== 'NaN-aN-aN' && c.date >= from)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const names = {}, cik = {};
  const active = new Map();                     // ticker -> exclusive end (null = still a member)
  for (const r of cur) { const t = yahooSym(r[0]); names[t] = r[1]; if (/^\d+$/.test(r[6] || '')) cik[t] = r[6].padStart(10, '0'); active.set(t, null); }
  const intervals = {}, unmatched = [], push = (t, s, e) => (intervals[t] ||= []).push([s, e]);
  for (const c of changes) {
    if (c.addT) {
      let t = RENAMED[c.addT] && active.has(RENAMED[c.addT]) ? RENAMED[c.addT] : c.addT;
      if (!active.has(t)) {
        // Renamed since it joined (the log keeps the old symbol): match on the company name.
        const n = normName(c.addN);
        const hit = [...active.keys()].find((k) => names[k] && n && (normName(names[k]) === n || normName(names[k]).startsWith(n) || n.startsWith(normName(names[k]))));
        if (hit) t = hit; else { unmatched.push({ ...c, why: 'added symbol not in the later list' }); t = null; }
      }
      if (t) { push(t, c.date, active.get(t)); active.delete(t); }
    }
    if (c.remT) { if (active.has(c.remT)) unmatched.push({ ...c, why: 'removed symbol already a member' }); active.set(c.remT, c.date); names[c.remT] ||= c.remN; }
  }
  for (const [t, e] of active) push(t, from, e);
  return { intervals, names, cik, unmatched, changes: changes.length, current: cur.length };
}

// ── Bars ──────────────────────────────────────────────────────────────────
export async function bars(sym, fromISO, { refresh = false } = {}) {
  const file = path.join(CACHE, 'bars', `${sym.replace(/[^A-Z0-9^.-]/gi, '_')}.json`);
  const hit = cached(file, 2, refresh);
  if (hit) return hit;
  const p1 = Math.floor(Date.parse(fromISO) / 1000), p2 = Math.floor(Date.now() / 1000);
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=div,split`, { 'User-Agent': UA_WEB });
  const r = j?.chart?.result?.[0];
  let out = { sym, status: j?.__status || (r ? 200 : 'empty'), bars: [] };
  if (r && r.timestamp) {
    const q = r.indicators?.quote?.[0] || {}, adj = r.indicators?.adjclose?.[0]?.adjclose || [];
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if ([o, h, l, c].some((x) => x == null || !(x > 0))) continue;
      out.bars.push({ d: iso(r.timestamp[i] * 1000), o, h, l, c, v: q.volume?.[i] || 0, a: adj[i] ?? c });
    }
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

// ── Earnings dates (SEC) ──────────────────────────────────────────────────
let tickerCik = null;
export async function cikFor(t) {
  if (!tickerCik) {
    const file = path.join(CACHE, 'sec', 'company_tickers.json');
    let j = cached(file, 7, false);
    if (!j) { j = await getJSON('https://www.sec.gov/files/company_tickers.json', { 'User-Agent': UA_SEC }); if (!j.__status) fs.writeFileSync(file, JSON.stringify(j)); }
    tickerCik = {};
    for (const v of Object.values(j || {})) if (v?.ticker) tickerCik[yahooSym(v.ticker)] = String(v.cik_str).padStart(10, '0');
  }
  return tickerCik[t] || null;
}
export async function earningsDates(cik, fromISO) {
  const file = path.join(CACHE, 'sec', `${cik}.json`);
  const hit = cached(file, 7, false);
  if (hit) return hit;
  const take = (f, out) => { for (let i = 0; i < (f.form || []).length; i++) if ((f.form[i] === '8-K' || f.form[i] === '8-K/A') && String(f.items?.[i] || '').split(',').includes('2.02')) out.add(f.filingDate[i]); };
  const j = await getJSON(`https://data.sec.gov/submissions/CIK${cik}.json`, { 'User-Agent': UA_SEC });
  if (j.__status) return null;
  const dates = new Set();
  take(j.filings?.recent || {}, dates);
  for (const f of j.filings?.files || []) {
    if (f.filingTo && f.filingTo < fromISO) continue;
    await sleep(150);
    const k = await getJSON(`https://data.sec.gov/submissions/${f.name}`, { 'User-Agent': UA_SEC });
    if (!k.__status) take(k, dates);
  }
  const out = [...dates].sort();
  fs.writeFileSync(file, JSON.stringify(out));
  await sleep(150);
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ── Precompute ────────────────────────────────────────────────────────────
export const SETUPS = ['BREAKOUT', 'PULLBACK', 'EARLY', 'EXTENDED', 'BROKEN', 'EARNINGS', 'AVOID'];
export const COLS = ['o', 'h', 'l', 'c', 'sc', 'su', 'rs', 'r20', 'a50', 'a200', 'rsi2', 'ma5', 'ma20', 'rsi14', 'slope', 'atr', 'stop', 'tgt'];
const WINDOW = 252;     // /api/scan fetches range=1y: about 252 sessions

/**
 * Everything the simulator needs, as columns aligned to SPY's trading calendar.
 * Returns { days, spy, vix, tickers: { T: { cols: {name: Float32Array}, member: Uint8Array } }, earnings, coverage }.
 */
export async function loadReplayData({ from = '2016-01-01', refresh = false, limit = 0 } = {}) {
  const warmFrom = iso(Date.parse(from) - 560 * 864e5);
  const mem = await membership(from, { refresh });
  let tickers = Object.keys(mem.intervals).sort();
  if (limit) tickers = tickers.slice(0, limit);
  log(`membership: ${mem.current} current, ${mem.changes} changes since ${from}, ${tickers.length} names ever in the index, ${mem.unmatched.length} log rows not reconciled`);

  const spyB = (await bars('SPY', warmFrom, { refresh })).bars, vixB = (await bars('^VIX', warmFrom, { refresh })).bars;
  if (spyB.length < 500 || vixB.length < 500) throw new Error('SPY or VIX history unavailable');
  let done = 0;
  const got = await pool(tickers, 4, async (t) => { const b = await bars(t, warmFrom, { refresh }); if (++done % 100 === 0) log(`  bars ${done}/${tickers.length}`); return b; });

  const days = spyB.filter((b) => b.d >= from).map((b) => b.d);
  const dayIdx = new Map(days.map((d, k) => [d, k]));
  const spyIdx = new Map(spyB.map((b, i) => [b.d, i]));
  const vixBy = new Map(vixB.map((b) => [b.d, b.c]));
  const spyBench = spyB.map((b) => ({ t: Date.parse(b.d), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));

  const out = {}, coverage = { names: tickers.length, withBars: 0, missing: [], partial: [] };
  const t0 = Date.now();
  for (const [n, t] of tickers.entries()) {
    const b = got[n].bars;
    const ivs = mem.intervals[t];
    const member = new Uint8Array(days.length);
    for (const [s, e] of ivs) for (let k = 0; k < days.length; k++) if (days[k] >= s && (!e || days[k] < e)) member[k] = 1;
    const memberDays = member.reduce((s, x) => s + x, 0);
    if (!b.length) { coverage.missing.push({ t, name: mem.names[t] || null, memberDays, status: got[n].status, intervals: ivs }); continue; }
    const cols = Object.fromEntries(COLS.map((c) => [c, new Float32Array(days.length).fill(NaN)]));
    const bb = b.map((x) => ({ t: Date.parse(x.d), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
    let covered = 0;
    for (let i = 0; i < b.length; i++) {
      const k = dayIdx.get(b[i].d);
      if (k == null) continue;
      cols.o[k] = b[i].o; cols.h[k] = b[i].h; cols.l[k] = b[i].l; cols.c[k] = b[i].c;
      if (member[k]) covered++;
      if (i < 59) continue;                       // analyze() needs 60 bars, like the live scan
      const j = spyIdx.get(b[i].d);
      if (j == null) continue;
      const a = analyze(bb.slice(Math.max(0, i - WINDOW + 1), i + 1), { benchBars: spyBench.slice(Math.max(0, j - WINDOW + 1), j + 1) });
      if (a.insufficient) continue;
      const I = a.indicators, p = b[i].c;
      cols.sc[k] = a.score; cols.su[k] = SETUPS.indexOf(a.setup);
      cols.rs[k] = I.rs20 ?? NaN; cols.r20[k] = I.ret20 ?? NaN;
      cols.a50[k] = I.ma50 != null ? (p > I.ma50 ? 1 : 0) : NaN;
      cols.a200[k] = I.ma200 != null ? (p > I.ma200 ? 1 : 0) : NaN;
      cols.rsi2[k] = I.rsi2 ?? NaN; cols.ma5[k] = I.ma5 ?? NaN; cols.ma20[k] = I.ma20 ?? NaN;
      cols.rsi14[k] = I.rsi14 ?? NaN; cols.slope[k] = I.ma20Slope ?? NaN; cols.atr[k] = I.atr14 ?? NaN;
      cols.stop[k] = a.plan?.stop ?? NaN; cols.tgt[k] = a.plan?.target ?? NaN;
    }
    coverage.withBars++;
    if (memberDays && covered < memberDays * 0.9) coverage.partial.push({ t, memberDays, covered });
    out[t] = { cols, member, name: mem.names[t] || null };
    if ((n + 1) % 100 === 0) log(`  analysed ${n + 1}/${tickers.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  // Earnings dates for every name we have prices for.
  let edone = 0;
  const withBars = Object.keys(out);
  const earnings = {};
  await pool(withBars, 2, async (t) => {
    const c = mem.cik[t] || (await cikFor(t));
    earnings[t] = c ? await earningsDates(c, warmFrom) : null;
    if (++edone % 100 === 0) log(`  earnings ${edone}/${withBars.length}`);
  });
  coverage.earningsKnown = withBars.filter((t) => earnings[t]?.length).length;

  const spy = { c: new Float32Array(days.map((d) => spyB[spyIdx.get(d)].c)), a: new Float64Array(days.map((d) => spyB[spyIdx.get(d)].a)),
    ma50: new Float32Array(days.map((d) => { const j = spyIdx.get(d); let s = 0; for (let q = j - 49; q <= j; q++) s += spyB[q].c; return s / 50; })) };
  const vix = new Float32Array(days.map((d) => vixBy.get(d) ?? NaN));
  // Carry the last VIX print over any day it is missing.
  for (let k = 1; k < vix.length; k++) if (!(vix[k] > 0)) vix[k] = vix[k - 1];
  return { from, days, spy, vix, tickers: out, earnings, coverage, unmatched: mem.unmatched, current: mem.current, changes: mem.changes };
}

/** Cached wrapper: the precompute takes a minute or two; reruns of the simulator should not. */
export async function replayData(opts = {}) {
  const file = path.join(CACHE, `pre-${opts.from || '2016-01-01'}${opts.limit ? '-' + opts.limit : ''}.v8`);
  if (!opts.refresh && fs.existsSync(file) && (Date.now() - fs.statSync(file).mtimeMs) / 864e5 < 2) return v8.deserialize(fs.readFileSync(file));
  const d = await loadReplayData(opts);
  fs.writeFileSync(file, v8.serialize(d));
  return d;
}

#!/usr/bin/env node
// Nightly batch: build data/screen.json — one compact row per S&P 500 name combining
//   • fundamentals from SEC XBRL via the same forensic module the Research page uses
//   • technicals from the deployed scan (score, setup, ATR, relative strength, plan)
//   • five-year price history (worst drawdown) from the deployed quotes endpoint
//   • yield / P/E / beta from the deployed fundamentals endpoint (NASDAQ) when it answers
//
// Runs in GitHub Actions (tools/../.github/workflows/screen.yml) and commits the file;
// the Research tab's "Screen" view reads it. Locally: npm run screen:build (needs the
// macOS CA bundle — sh tools/validate.sh exports it; or run with NODE_EXTRA_CA_CERTS).
//
// Honesty rules: a field the sources did not return stays null; the file records when it
// was built and how many names each source covered, and the page prints both.

import { writeFileSync, mkdirSync } from 'node:fs';
import { forensic } from '../api/_forensic.js';

const BASE = process.env.APP_URL || 'https://signal-desk-virid.vercel.app';
const CONCURRENCY = +(process.env.SCREEN_CONCURRENCY || 4);     // SEC asks for ≤ 10 req/s
const LIMIT = process.env.SCREEN_LIMIT ? +process.env.SCREEN_LIMIT : Infinity;   // for quick local runs
const j = async (u, tries = 3) => { for (let i = 0; i < tries; i++) { try { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status}`); return await r.json(); } catch (e) { if (i === tries - 1) throw e; await new Promise((s) => setTimeout(s, 1500 * (i + 1))); } } };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const r1 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(1));
const r2 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(2));
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; } } }; await Promise.all(Array.from({ length: n }, run)); return out; }
function maxDrawdown(closes) { let peak = -Infinity, mdd = 0; for (const c of closes) { if (c > peak) peak = c; const dd = (c / peak - 1) * 100; if (dd < mdd) mdd = dd; } return mdd; }
function riskRating({ atrPct, maxDrawdownPct, beta, netDebtToEbitda }) { let r = 1; if (atrPct != null) r += atrPct >= 6 ? 3 : atrPct >= 4 ? 2 : atrPct >= 2.5 ? 1 : 0; if (maxDrawdownPct != null) r += maxDrawdownPct <= -60 ? 3 : maxDrawdownPct <= -40 ? 2 : maxDrawdownPct <= -25 ? 1 : 0; if (beta != null) r += beta >= 1.5 ? 1 : 0; if (netDebtToEbitda != null) r += netDebtToEbitda >= 3 ? 2 : netDebtToEbitda >= 1.5 ? 1 : 0; return Math.max(1, Math.min(10, r)); }

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const uni = ((await j(`${BASE}/api/universe`)).constituents || []).slice(0, LIMIT);
log(`universe ${uni.length}`);
const meta = Object.fromEntries(uni.map((c) => [c.symbol, c]));
const symbols = uni.map((c) => c.symbol);

// 1. technicals — the deployed scan, 50 per call, 4 in flight
const scanRows = {};
await pool(chunk(uni, 50), 4, async (b) => {
  const tickers = b.map((c) => c.symbol).join(','), sectors = b.filter((c) => c.sectorEtf).map((c) => `${c.symbol}:${c.sectorEtf}`).join(',');
  const d = await j(`${BASE}/api/scan?tickers=${encodeURIComponent(tickers)}&sectors=${encodeURIComponent(sectors)}`);
  for (const r of d.rows || []) scanRows[r.t] = r;
});
log(`scan rows ${Object.keys(scanRows).length}`);

// 2. five-year history → worst drawdown, plus trailing-12-month cash dividends (yield), 20 per call
const dd = {}, ttmDiv = {};
await pool(chunk(symbols, 20), 4, async (b) => {
  const d = await j(`${BASE}/api/quotes?tickers=${encodeURIComponent(b.join(','))}&range=5y&dividends=1`);
  for (const [t, q] of Object.entries(d.quotes || {})) { if (q?.bars?.length > 200) dd[t] = r1(maxDrawdown(q.bars.map((x) => x.c))); if (q?.dividends?.ttmPerShare > 0) ttmDiv[t] = q.dividends.ttmPerShare; }
});
log(`drawdowns ${Object.keys(dd).length} · dividends ${Object.keys(ttmDiv).length}`);

// 3. NASDAQ summary via the deployed endpoint (may be partial — it is rate-limited at times)
const nas = {};
await pool(chunk(symbols, 40), 3, async (b) => { const d = await j(`${BASE}/api/fundamentals?tickers=${encodeURIComponent(b.join(','))}`); Object.assign(nas, d.fundamentals || {}); });
log(`nasdaq summaries ${Object.keys(nas).length}`);

// 4. filings — the forensic module, directly against SEC (one companyfacts read per name)
let done = 0, failed = 0;
const fx = await pool(symbols, CONCURRENCY, async (t) => {
  try { const f = await forensic(t, { sector: meta[t]?.sector || null }); done++; if (done % 50 === 0) log(`filings ${done}/${symbols.length}`); return f; }
  catch (e) { failed++; return { error: e.message }; }
});
log(`filings done ${done} failed ${failed}`);

// 5. assemble compact rows
const rows = symbols.map((t, i) => {
  const f = fx[i] && !fx[i].error ? fx[i] : null, s = scanRows[t] || {}, n = nas[t] || {};
  const y = f ? f.years[f.years.length - 1] || {} : {};
  const price = s.p ?? f?.valuation?.price ?? null;
  const yieldPct = ttmDiv[t] > 0 && price > 0 ? r2((ttmDiv[t] / price) * 100) : (n.yieldPct ?? null);   // cash actually paid ÷ price, NASDAQ as fallback
  // A fair-value range anchored on a depressed or windfall year is noise: drop it when it is not within 0.3×–3× of price.
  const fl = f?.valuation?.fairValue?.low ?? null, fh = f?.valuation?.fairValue?.high ?? null;
  const fairOk = fl != null && fh != null && price > 0 && fl >= price * 0.3 && fh <= price * 3;
  const nde = y.ndEbitda ?? null;
  const risk = riskRating({ atrPct: s.atr, maxDrawdownPct: dd[t], beta: n.beta, netDebtToEbitda: nde });
  return {
    t, name: meta[t]?.name || f?.name || t, sector: meta[t]?.sector || null, price: r2(price),
    mcap: n.marketCapRaw ?? f?.valuation?.marketCap ?? null,
    // technicals
    score: s.sc ?? null, setup: s.su ?? null, rs: s.rs ?? null, atrPct: s.atr ?? null, entry: s.p ?? null, stop: s.stop ?? null, target: s.tgt ?? null, d52: s.d52 ?? null,
    // fundamentals
    pe: n.peRatio ?? f?.valuation?.current?.pe ?? null, fwdPe: n.forwardPE ?? null, beta: n.beta ?? null, yieldPct,
    revCagr: f?.valuation?.revenueCagr ?? null, epsCagr: f?.valuation?.epsCagr ?? null,
    gm: y.gm ?? null, om: y.om ?? null, roic: y.roic ?? y.roce ?? null, de: y.de ?? null, ndEbitda: nde,
    fcfYield: f?.valuation?.current?.fcfYieldPct ?? null, premium: f?.valuation?.premiumToOwnHistoryPct ?? null,
    fairLow: fairOk ? fl : null, fairHigh: fairOk ? fh : null,
    divFcfPct: f && f.allocation?.totals?.fcf > 0 && f.allocation.totals.dividends > 0 ? r1((f.allocation.totals.dividends / f.allocation.totals.fcf) * 100) : null,
    cash: f?.cash?.verdict ?? null, moat: f?.moat?.score ?? null, alloc: f?.allocation?.verdict ?? null, val: f?.valuation?.verdict ?? null, credibility: f?.credibility?.score ?? null,
    maxDd: dd[t] ?? null, risk,
    financial: !!f?.isFinancial,
  };
});
const out = {
  builtAt: new Date().toISOString(), source: BASE, universe: symbols.length,
  coverage: { scan: Object.keys(scanRows).length, history: Object.keys(dd).length, nasdaq: Object.keys(nas).length, filings: done },
  conventions: 'Fundamentals from the latest 10-K via the forensic module (same conventions as the Research page); technicals from the scan at build time; risk 1–10 from ATR%, 5-yr drawdown, beta and net debt/EBITDA; P/E from NASDAQ when available, else price ÷ last fiscal-year GAAP EPS.',
  rows,
};
mkdirSync('data', { recursive: true });
writeFileSync('data/screen.json', JSON.stringify(out));
log(`wrote data/screen.json · ${rows.length} rows · ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);

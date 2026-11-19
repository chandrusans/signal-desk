// Vercel serverless: /api/fundamentals?tickers=NVDA,PLTR,...
//                    /api/fundamentals?op=research&ticker=NVDA[&sector=Information%20Technology]
//
// op=research is the Research tab's one call: the forensic module (_forensic.js —
// SEC XBRL cash flow / working capital / margins / capital allocation / valuation
// vs own history / earnings credibility) plus NASDAQ's company profile
// (description, sector, industry, website). Analyst consensus, news sentiment
// and the sector peers' multiples are fetched by the page from the existing
// endpoints so nothing is duplicated.
//
// Replaces the previously-mocked market cap / P/E on the screener AND supplies
// the next earnings date, which the analyzer needs to flag "earnings inside
// your holding window" — the single most common way an ATR-based stop fails.
//
// Sources (both free, no API key):
//   • NASDAQ /api/quote/{t}/summary   → market cap, 52w range, avg volume, yield
//   • data/earnings.json (nightly: NASDAQ's day-by-day calendar + SEC-based estimates) → next earnings date
//
// Returns { NVDA: { marketCap, marketCapRaw, peRatio, avgVolume, yield,
//                   fiftyTwoWeek: {high, low}, earningsDate, earningsInDays } }

import { forensic } from './_forensic.js';
import { calendarEntry } from '../earnings-calendar.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

async function fetchProfile(sym) {
  try {
    const res = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(sym)}/company-profile`, { headers: HEADERS });
    if (!res.ok) return null;
    const d = (await res.json())?.data; if (!d) return null;
    const v = (k) => d[k]?.value ?? null;
    return { name: v('CompanyName'), description: v('CompanyDescription'), sector: v('Sector'), industry: v('Industry'), region: v('Region'), website: v('CompanyUrl'), address: v('Address') };
  } catch { return null; }
}

function parseMoney(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

async function fetchSummary(sym) {
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`,
      { headers: HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const s = data?.data?.summaryData;
    if (!s) return null;
    const val = (k) => s[k]?.value ?? null;

    const mcRaw = parseMoney(val('MarketCap'));
    // 52-week range comes as "$236.54/$164.07"
    let high52 = null, low52 = null;
    const range = val('FiftTwoWeekHighLow');
    if (range) {
      const parts = String(range).split('/').map(parseMoney);
      high52 = parts[0] ?? null;
      low52 = parts[1] ?? null;
    }
    return {
      marketCapRaw: mcRaw,
      marketCap: mcRaw != null ? mcRaw / 1e9 : null,   // in $B for the screener
      peRatio: parseMoney(val('PERatio')),
      forwardPE: parseMoney(val('ForwardPE1Yr')),
      eps: parseMoney(val('EarningsPerShare')),
      beta: parseMoney(val('Beta')),
      avgVolume: parseMoney(val('AverageVolume')),
      yieldPct: parseMoney(val('Yield')),
      fiftyTwoWeek: { high: high52, low: low52 },
    };
  } catch { return null; }
}

// Next earnings date. The nightly calendar file (data/earnings.json, see earnings-calendar.js) is
// the source: NASDAQ's per-stock earnings-date endpoint no longer carries dates. The file is a
// static asset of this same deployment, fetched once and kept for half an hour per instance.
let calCache = { at: 0, cal: null };
async function loadCalendar(req) {
  if (calCache.cal && Date.now() - calCache.at < 30 * 60e3) return calCache.cal;
  try {
    const host = String(req.headers?.host || '');
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return calCache.cal;
    const proto = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https';
    const r = await fetch(`${proto}://${host}/data/earnings.json`);
    if (r.ok) { const cal = await r.json(); if (cal && cal.dates) calCache = { at: Date.now(), cal }; }
  } catch { /* keep whatever we had */ }
  return calCache.cal;
}

export default async function handler(req, res) {
  const op = String((req.query && req.query.op) || '').toLowerCase();
  if (op === 'research') {
    const t = String((req.query && req.query.ticker) || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,6}$/.test(t)) { res.status(400).json({ error: 'Pass ?op=research&ticker=NVDA' }); return; }
    const sector = (req.query && req.query.sector) ? String(req.query.sector).slice(0, 60) : null;
    try {
      const [f, profile, summary] = await Promise.all([forensic(t, { sector }), fetchProfile(t), fetchSummary(t)]);
      // Filings change quarterly, so cache for hours — but only a COMPLETE answer.
      // NASDAQ refuses Vercel's egress IPs now and then; a response missing the
      // profile or summary must not be pinned at the edge for six hours.
      const complete = profile && summary && f && !f.error;
      res.setHeader('Cache-Control', complete ? 's-maxage=21600, stale-while-revalidate=86400' : 's-maxage=60, stale-while-revalidate=120');
      res.status(200).json({ asOf: Date.now(), ticker: t, profile, summary, forensic: f });
    } catch (e) {
      res.status(200).json({ asOf: Date.now(), ticker: t, error: String(e.message || e) });
    }
    return;
  }
  const raw = (req.query && req.query.tickers) || '';
  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z^][A-Z0-9.\-^=]{0,11}$/.test(s))        // strict symbol shape: no injection into upstream URLs or regexes
    .filter((t) => !t.startsWith('^') && !t.includes('='))
    .slice(0, 40);

  if (!tickers.length) {
    res.status(400).json({ error: 'Pass ?tickers=NVDA,PLTR,...' });
    return;
  }

  const cal = await loadCalendar(req);
  // Eight NASDAQ reads in flight at most: forty at once is what gets a batch refused.
  const results = new Array(tickers.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, async () => {
    while (next < tickers.length) { const k = next++, t = tickers[k]; results[k] = [t, { ...((await fetchSummary(t)) || {}), earnings: calendarEntry(cal, t) }]; }
  }));

  const out = {};
  for (const [t, v] of results) {
    if (v && (v.marketCap != null || v.earnings)) out[t] = v;
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200'); // fundamentals move slowly
  res.status(200).json({ asOf: Date.now(), fundamentals: out, earningsCalendar: cal ? { builtAt: cal.builtAt, through: cal.calendarThrough } : null });
}

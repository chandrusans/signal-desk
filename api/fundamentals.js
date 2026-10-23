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
//   • NASDAQ /api/analyst/{t}/earnings-date → next estimated earnings date
//
// Returns { NVDA: { marketCap, marketCapRaw, peRatio, avgVolume, yield,
//                   fiftyTwoWeek: {high, low}, earningsDate, earningsInDays } }

import { forensic } from './_forensic.js';

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

async function fetchEarningsDate(sym) {
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-date`,
      { headers: HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.data?.reportText || '';
    // "…estimated to report earnings on  08/26/2026. The upcoming earnings…"
    const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    const iso = `${yyyy}-${mm}-${dd}`;
    const ts = Date.parse(iso + 'T00:00:00Z');
    if (isNaN(ts)) return null;
    return {
      date: iso,
      daysAway: Math.round((ts - Date.now()) / 86400000),
      // NASDAQ sources these from Zacks; before the company confirms they are
      // algorithmic estimates. Flag that honestly rather than implying certainty.
      estimated: /derived from an algorithm|estimated/i.test(text),
    };
  } catch { return null; }
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
      res.setHeader('Access-Control-Allow-Origin', '*');
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
    .filter(Boolean)
    .filter((t) => !t.startsWith('^') && !t.includes('='))
    .slice(0, 40);

  if (!tickers.length) {
    res.status(400).json({ error: 'Pass ?tickers=NVDA,PLTR,...' });
    return;
  }

  const results = await Promise.all(
    tickers.map(async (t) => {
      const [summary, earnings] = await Promise.all([fetchSummary(t), fetchEarningsDate(t)]);
      return [t, { ...(summary || {}), earnings }];
    })
  );

  const out = {};
  for (const [t, v] of results) {
    if (v && (v.marketCap != null || v.earnings)) out[t] = v;
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200'); // fundamentals move slowly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ asOf: Date.now(), fundamentals: out });
}

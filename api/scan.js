// Vercel serverless: /api/scan?tickers=AAPL,MSFT,...&sectors=AAPL:XLK,MSFT:XLK
//
// Scores a BATCH of tickers server-side and returns compact summary rows.
//
// Why this exists: the S&P 500 at 1y of daily bars is ~13MB of raw Yahoo
// payload. That exceeds Vercel's response limit and is unusable on mobile.
// Scoring here and shipping ~350 bytes per ticker turns 13MB into ~175KB for
// the full index, and means every client sees identical, reproducible scores
// rather than each browser computing its own.
//
// The frontend fetches /api/universe once, chunks it, and fans out several
// scan calls in parallel. Full bar history for the ONE ticker a user clicks
// is fetched separately from /api/quotes.

import { analyze } from '../analyze.js';

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const CHART = (sym, range) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`;

async function fetchBars(sym, range = '1y') {
  try {
    const res = await fetch(CHART(sym, range), { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data?.chart?.result?.[0];
    if (!r) return null;
    const q = r.indicators?.quote?.[0] || {};
    const ts = r.timestamp || [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if (o != null && h != null && l != null && c != null && v != null) {
        bars.push({ t: ts[i] * 1000, o, h, l, c, v });
      }
    }
    if (bars.length < 60) return null;
    const meta = r.meta || {};
    const price = meta.regularMarketPrice ?? bars[bars.length - 1].c;
    const prevClose = bars.length >= 2 ? bars[bars.length - 2].c : null;
    return {
      bars,
      price,
      changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
      volume: meta.regularMarketVolume ?? bars[bars.length - 1].v,
    };
  } catch { return null; }
}

const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);

export default async function handler(req, res) {
  const rawTickers = (req.query && req.query.tickers) || '';
  const tickers = String(rawTickers)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 80);                                   // batch ceiling per invocation

  if (!tickers.length) {
    res.status(400).json({ error: 'Pass ?tickers=AAPL,MSFT,...' });
    return;
  }

  // Optional ticker -> sector-ETF map so we can compute sector-relative strength
  const sectorMap = {};
  for (const pair of String((req.query && req.query.sectors) || '').split(',')) {
    const [t, e] = pair.split(':');
    if (t && e) sectorMap[t.trim().toUpperCase()] = e.trim().toUpperCase();
  }
  const sectorEtfs = [...new Set(Object.values(sectorMap))].filter(Boolean);

  // Benchmarks: SPY for market RS, plus whichever sector ETFs this batch needs.
  // Fetched alongside the batch so RS is computed against the same window.
  const benchSyms = ['SPY', ...sectorEtfs];
  const [benchResults, tickerResults] = await Promise.all([
    Promise.all(benchSyms.map(async (s) => [s, await fetchBars(s)])),
    Promise.all(tickers.map(async (t) => [t, await fetchBars(t)])),
  ]);
  const benchMap = Object.fromEntries(benchResults);
  const spyBars = benchMap['SPY']?.bars || null;

  const rows = [];
  const errors = [];

  for (const [ticker, data] of tickerResults) {
    if (!data) { errors.push(ticker); continue; }
    const etf = sectorMap[ticker];
    const sectorBars = etf ? (benchMap[etf]?.bars || null) : null;

    const a = analyze(data.bars, { benchBars: spyBars });
    if (a.insufficient) { errors.push(ticker); continue; }

    // Sector-relative strength: 20d return minus the sector ETF's 20d return.
    // Beating SPY while lagging your own sector is not leadership.
    let sectorRs = null;
    if (sectorBars && sectorBars.length >= 21 && a.indicators.ret20 != null) {
      const sc = sectorBars.map((b) => b.c);
      const secRet20 = ((sc[sc.length - 1] - sc[sc.length - 21]) / sc[sc.length - 21]) * 100;
      sectorRs = a.indicators.ret20 - secRet20;
    }

    // Downsample the sparkline: 20 points is plenty at card size, and it keeps
    // the response small enough to ship the whole index at once.
    const closes = data.bars.map((b) => b.c);
    const tail = closes.slice(-40);
    const spark = [];
    for (let i = 0; i < tail.length; i += 2) spark.push(r2(tail[i]));

    rows.push({
      t: ticker,
      p: r2(data.price),
      c: r2(data.changePct),
      sc: a.score,
      su: a.setup,
      rsi: r1(a.indicators.rsi14),
      atr: r1(a.indicators.atrPct),
      r20: r1(a.indicators.ret20),
      r60: r1(a.indicators.ret60),
      rs: r1(a.indicators.rs20),
      srs: r1(sectorRs),
      d52: r1(a.indicators.distFrom52w),
      vr: r2(a.indicators.volRatio),
      // Above its own 50d MA — the input for market-breadth calculation
      a50: a.indicators.ma50 != null ? data.price > a.indicators.ma50 : null,
      // Trade plan essentials so cards can render without a second round trip
      stop: r2(a.plan?.stop),
      tgt: r2(a.plan?.target),
      reason: a.setupReason,
      spark,
    });
  }

  // Sort by score so the caller can merge batches and still have the best first.
  // The composite caps at 100 and across 500 names a dozen or more will tie
  // there, so break ties on leadership: sector-relative strength first (beating
  // SPY while lagging your own sector isn't leadership), then RS vs SPY.
  rows.sort((a, b) =>
    b.sc - a.sc ||
    (b.srs ?? -999) - (a.srs ?? -999) ||
    (b.rs ?? -999) - (a.rs ?? -999)
  );

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    requested: tickers.length,
    scored: rows.length,
    ...(errors.length ? { skipped: errors } : {}),
    rows,
  });
}

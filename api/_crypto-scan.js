// Vercel serverless: /api/crypto-scan?coins=BTC,ETH,SOL&hours=1
//
// Scores a batch of crypto pairs server-side and returns compact rows, the
// same shape and reasoning as /api/scan for equities.
//
// Two extras that only make sense for crypto:
//
//   1. The benchmark is BTC, not SPY. Relative strength vs BTC is the metric
//      that matters — an alt up 6% while BTC is up 10% is a laggard, and in a
//      BTC drawdown it will fall harder.
//
//   2. There is no earnings gate and no VIX. Regime comes from BTC's own
//      realised volatility — see cryptoRegime() in analyze.js.
//
// Hour-of-day timing lives in /api/crypto-hours, not here: a meaningful sample
// needs ~100 days of hourly candles, which is 8 paginated requests per coin.
// That is affordable for the one coin a user opens, not for 40 at once.

import { analyze } from '../analyze.js';

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const CANDLES = (product, granularity) =>
  `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${granularity}`;

const DAY = 86400;
const HOUR = 3600;

/**
 * Coinbase returns [time, low, high, open, close, volume] newest-first.
 * Note the ordering: it is NOT the conventional OHLC. Getting this wrong
 * silently swaps highs and opens and every indicator quietly goes wrong.
 */
async function fetchCandles(product, granularity) {
  try {
    const res = await fetch(CANDLES(product, granularity), { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const raw = await res.json();
    if (!Array.isArray(raw) || !raw.length) return null;
    const bars = raw
      .filter((x) => Array.isArray(x) && x.length >= 6 && x.every((n) => n != null))
      .map((x) => ({ t: x[0] * 1000, l: x[1], h: x[2], o: x[3], c: x[4], v: x[5] }))
      .sort((a, b) => a.t - b.t);
    return bars.length ? bars : null;
  } catch {
    return null;
  }
}

const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);

/** Small prices need more decimals than BTC does. */
function roundPrice(p) {
  if (p == null || !isFinite(p)) return null;
  if (p >= 100) return Math.round(p * 100) / 100;
  if (p >= 1) return Math.round(p * 10000) / 10000;
  return Math.round(p * 1e8) / 1e8;
}

export default async function handler(req, res) {
  const q = req.query || {};
  const coins = String(q.coins || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 40);                                   // batch ceiling per invocation

  if (!coins.length) {
    res.status(400).json({ error: 'Pass ?coins=BTC,ETH,SOL' });
    return;
  }

  // BTC is both a scored coin and the benchmark, so fetch it once regardless.
  const [btcDaily, dailyResults] = await Promise.all([
    fetchCandles('BTC-USD', DAY),
    Promise.all(coins.map(async (c) => [c, await fetchCandles(`${c}-USD`, DAY)])),
  ]);

  const rows = [];
  const skipped = [];

  for (const [coin, bars] of dailyResults) {
    if (!bars || bars.length < 60) { skipped.push(coin); continue; }

    const a = analyze(bars, {
      benchBars: coin === 'BTC' ? null : btcDaily,   // BTC is not its own benchmark
      assetClass: 'crypto',
    });
    if (a.insufficient) { skipped.push(coin); continue; }

    const last = bars[bars.length - 1];
    const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
    const price = last.c;
    const changePct = prev && prev.c > 0 ? ((price - prev.c) / prev.c) * 100 : null;

    // 20-point sparkline, same downsampling as the equity scan
    const tail = bars.slice(-40).map((b) => b.c);
    const spark = [];
    for (let i = 0; i < tail.length; i += 2) spark.push(roundPrice(tail[i]));

    rows.push({
      t: coin,
      p: roundPrice(price),
      c: r2(changePct),
      sc: a.score,
      su: a.setup,
      rsi: r1(a.indicators.rsi14),
      atr: r1(a.indicators.atrPct),
      r20: r1(a.indicators.ret20),
      r60: r1(a.indicators.ret60),
      rs: r1(a.indicators.rs20),                     // vs BTC
      d52: r1(a.indicators.distFrom52w),
      vr: r2(a.indicators.volRatio),
      a50: a.indicators.ma50 != null ? price > a.indicators.ma50 : null,
      stop: roundPrice(a.plan?.stop),
      tgt: roundPrice(a.plan?.target),
      stopPct: r1(a.plan?.stopPct),
      tgtPct: r1(a.plan?.targetPct),
      reason: a.setupReason,
      spark,
    });
  }

  // Score first, then relative strength vs BTC as the tiebreaker
  rows.sort((a, b) => b.sc - a.sc || (b.rs ?? -999) - (a.rs ?? -999));

  // BTC bars travel back so the client can compute the crypto regime without
  // a second round trip. Closes only — the regime maths needs nothing else.
  const btcCloses = btcDaily ? btcDaily.slice(-260).map((b) => ({ t: b.t, c: roundPrice(b.c) })) : null;

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    requested: coins.length,
    scored: rows.length,
    ...(skipped.length ? { skipped } : {}),
    btc: btcCloses,
    rows,
  });
}

// Vercel serverless: /api/crypto-backtest
//
// Runs the real backtest engine over a liquid crypto universe and returns the
// measured result, including a fee sweep.
//
// This exists because of one finding that a user asking "which coin do I buy
// today to make $50?" needs to see before anything else: the momentum strategy
// has POSITIVE expectancy before costs and NEGATIVE expectancy after realistic
// Coinbase retail fees. The whole edge, and more, goes to the exchange. The fee
// sweep is returned so the breakeven fee is visible rather than asserted.
//
// Computed live rather than hardcoded — a number written into the page today is
// misleading in three months, and the repo rule is that nothing claims to be
// measured unless it is.

import { runBacktest } from '../backtest.js';

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const DAY = 86400;
const PAGES = 6;                 // 6 x 300 daily candles ~= 4.9 years
const CONCURRENCY = 6;           // with retry/backoff in place this stays inside the per-IP limit

// ~50 paginated fetches; comfortably under this, but the default 10s would be
// tight. The result is edge-cached for 6h so this rarely runs cold.
export const config = { maxDuration: 60 };

// Deliberately the liquid majors. Illiquid alts would make the result look
// better (more volatility, more signals) while being untradeable at size.
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOGE', 'DOT', 'LTC', 'UNI', 'ATOM'];

// Taker fee per side at each venue's retail tier, in basis points. These are
// the lever that decides whether the strategy has an edge at all, so they are
// surfaced in the response rather than buried.
const VENUES = [
  { name: 'Coinbase (retail, <$10k vol)', bps: 60 },
  { name: 'Coinbase Advanced ($10k-50k)', bps: 40 },
  { name: 'Kraken Pro (retail)', bps: 26 },
  { name: 'Binance.US / high volume', bps: 10 },
  { name: 'Zero cost (theoretical)', bps: 0 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Paginated daily candles.
 *
 * Coinbase rate-limits public endpoints per IP. An earlier version fired all
 * pages back to back and broke out of the loop on the first non-200, which
 * silently returned a short history — the backtest then ran on 1.6 years
 * instead of 3.3 and reported a far more negative result, because that window
 * happened to be a BTC drawdown. Pace the requests and retry rather than
 * truncating, so a rate limit never masquerades as "this is all the data".
 */
async function dailyBars(product) {
  const now = Math.floor(Date.now() / 1000);
  const all = new Map();
  for (let p = 0; p < PAGES; p++) {
    const end = now - p * 300 * DAY;
    const start = end - 300 * DAY;
    const url = `https://api.exchange.coinbase.com/products/${product}/candles`
      + `?granularity=${DAY}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    let got = false;
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      if (attempt) await sleep(250 * attempt);
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (r.status === 429) continue;                    // rate limited — back off and retry
        if (!r.ok) { got = true; break; }                  // genuine miss: stop paging this coin
        const d = await r.json();
        if (!Array.isArray(d) || !d.length) { got = true; break; }
        for (const x of d) {
          if (Array.isArray(x) && x.length >= 6 && x.every((n) => n != null)) all.set(x[0], x);
        }
        got = true;
      } catch { /* retry */ }
    }
    await sleep(120);                                       // stay under the per-IP limit
  }
  return [...all.values()]
    .sort((a, b) => a[0] - b[0])
    .map((x) => ({ t: x[0] * 1000, l: x[1], h: x[2], o: x[3], c: x[4], v: x[5] }));
}

async function pooled(items, limit, worker) {
  const out = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx]); } catch { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);

function summarise(m) {
  if (!m || !m.trades) return null;
  return {
    trades: m.trades,
    winRate: r1(m.winRate * 100),
    expectancy: r3(m.expectancy),
    profitFactor: r3(m.profitFactor),
    totalReturn: r1(m.totalReturn * 100),
    cagr: r1(m.cagr * 100),
    maxDrawdown: r1(m.maxDrawdown * 100),
    avgWinR: r3(m.avgWinR),
    avgLossR: r3(m.avgLossR),
    avgDaysHeld: r1(m.avgDaysHeld),
    tradesPerYear: r1(m.tradesPerYear),
    years: r1(m.years),
  };
}

export default async function handler(req, res) {
  const results = await pooled(COINS, CONCURRENCY, async (c) => [c, await dailyBars(`${c}-USD`)]);

  const byTicker = {};
  for (const entry of results) {
    if (!entry) continue;
    const [coin, bars] = entry;
    if (bars && bars.length > 260) byTicker[coin] = bars;
  }

  const btc = byTicker.BTC || null;
  if (Object.keys(byTicker).length < 5) {
    res.setHeader('Cache-Control', 's-maxage=120');
    res.status(200).json({ error: 'insufficient crypto history available', coins: Object.keys(byTicker).length });
    return;
  }

  // Fee sweep on the momentum strategy — the headline finding
  const sweep = [];
  for (const v of VENUES) {
    const r = runBacktest(byTicker, { strategy: 'momentum', assetClass: 'crypto', slippageBps: v.bps }, null, btc);
    const s = summarise(r.metrics);
    if (s) sweep.push({ venue: v.name, bps: v.bps, roundTripBps: v.bps * 2, ...s });
  }

  // All three strategies at the realistic retail default
  const strategies = {};
  for (const strat of ['momentum', 'mean-reversion', 'composite']) {
    const r = runBacktest(byTicker, { strategy: strat, assetClass: 'crypto' }, null, btc);
    strategies[strat] = summarise(r.metrics);
  }

  // Breakeven fee: highest swept fee that still leaves expectancy >= 0
  const positive = sweep.filter((s) => s.expectancy >= 0).sort((a, b) => b.bps - a.bps);
  const breakevenBps = positive.length ? positive[0].bps : null;

  // BTC buy-and-hold over the identical window, as the do-nothing baseline
  let buyHold = null;
  if (btc && btc.length > 1) {
    const first = btc[0].c, last = btc[btc.length - 1].c;
    const years = (btc[btc.length - 1].t - btc[0].t) / (365.25 * 86400 * 1000);
    let peak = first, mdd = 0;
    for (const b of btc) { if (b.c > peak) peak = b.c; mdd = Math.min(mdd, (b.c - peak) / peak); }
    buyHold = {
      totalReturn: r1(((last - first) / first) * 100),
      cagr: r1((Math.pow(last / first, 1 / years) - 1) * 100),
      maxDrawdown: r1(mdd * 100),
      years: r1(years),
      from: new Date(btc[0].t).toISOString().slice(0, 10),
      to: new Date(btc[btc.length - 1].t).toISOString().slice(0, 10),
    };
  }

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  // Surfaced so a short fetch can never pass as a full-history result. A
  // window this strategy is judged on must be long enough to contain both a
  // crypto bull and bear leg; anything under ~3 years is not.
  const barCounts = Object.values(byTicker).map((b) => b.length);
  const coverage = {
    minBars: Math.min(...barCounts),
    maxBars: Math.max(...barCounts),
    years: buyHold ? buyHold.years : null,
    adequate: buyHold != null && buyHold.years >= 3,
  };

  res.status(200).json({
    asOf: Date.now(),
    universe: Object.keys(byTicker),
    coins: Object.keys(byTicker).length,
    requested: COINS.length,
    coverage,
    defaultFeeBps: 60,
    breakevenBps,
    sweep,
    strategies,
    buyHold,
  });
}

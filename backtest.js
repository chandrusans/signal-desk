// Real backtest engine — replaces the illustrative/seeded equity curves.
//
// Design principles (addressing the standard criticisms of retail backtests):
//   • POINT-IN-TIME: analyze() only ever sees bars[0..t]. No look-ahead.
//   • REALISTIC FILLS: entry at NEXT bar's open, never the signal bar's close.
//   • COSTS MODELED: commission + slippage in basis points on both sides.
//   • GAP-AWARE STOPS: if the open gaps below the stop, we fill at the open
//     (a worse-than-1R loss), not at the stop price. This is what actually
//     happens and is the #1 reason naive backtests overstate performance.
//   • INTRABAR ORDER: stop checked before target within the same bar (conservative).
//   • TRAILING: stop to breakeven at +1R, to +1R at +2R — matches the live rules.
//
// Metrics reported are the ones that matter for expectancy, not vanity:
//   win rate, avg win R, avg loss R, EXPECTANCY (R/trade), profit factor,
//   max drawdown, Sharpe, Sortino, CAGR, R-multiple distribution, and
//   gap-through-stop frequency.

import { analyze, regime } from './analyze.js';

const DEFAULTS = {
  riskPctPerTrade: 1.0,      // % of equity risked per trade
  slippageBps: 7,            // 7 bps each side — realistic for liquid US names
  commissionPerShare: 0,     // $0 at Robinhood/Schwab for stocks
  maxConcurrent: 5,          // portfolio-level position cap
  timeStopDays: 15,
  targetR: 2.5,
  startEquity: 10000,
  warmupBars: 200,           // need 200 bars before MA200 is valid
  assetClass: 'equity',      // 'equity' | 'crypto' — selects stop bounds + costs
  reportOpen: false,         // return still-open positions marked to the last bar
};

// Per-asset-class execution cost and stop bounds. Cost is charged per side.
//
// The crypto number is the one that matters. Coinbase's retail taker fee is
// 0.60% below $10k of 30-day volume (0.40% above it) — 60 bps a side, roughly
// 9x the equity assumption and 120 bps round trip. Modelling crypto with
// equity costs overstates results badly enough to flip the conclusion, so this
// defaults to the honest, pessimistic retail number.
const CLASS_CFG = {
  equity: { costBps: 7,  stopFloorPct: 0.05, stopCapPct: 0.10 },
  crypto: { costBps: 60, stopFloorPct: 0.03, stopCapPct: 0.15 },
};

/**
 * Run the backtest across a set of tickers.
 * @param {Object} barsByTicker  { NVDA: [{t,o,h,l,c,v}, ...], ... }
 * @param {Object} opts
 * @param {Array}  vixBars       optional ^VIX bars for regime filtering
 * @param {Array}  benchBars     optional SPY bars for benchmark comparison
 */
export function runBacktest(barsByTicker, opts = {}, vixBars = null, benchBars = null) {
  const cfg = { ...DEFAULTS, ...opts };
  const strategy = cfg.strategy || 'momentum';   // 'momentum' | 'mean-reversion' | 'composite'
  const klass = CLASS_CFG[cfg.assetClass] || CLASS_CFG.equity;
  // An explicit slippageBps in opts wins; otherwise take the asset class's cost.
  const costBps = opts.slippageBps != null ? opts.slippageBps : klass.costBps;
  cfg.slippageBps = costBps;

  // Build a VIX lookup by timestamp for the regime filter
  const vixByTs = {};
  if (vixBars) for (const b of vixBars) vixByTs[dayKey(b.t)] = b.c;

  // Collect every ticker's usable bar range
  const tickers = Object.keys(barsByTicker).filter(t => (barsByTicker[t] || []).length > cfg.warmupBars + 20);
  if (tickers.length === 0) {
    return { error: 'insufficient history', trades: [], metrics: null };
  }

  // ── PASS 1 ─────────────────────────────────────────────────────────────
  // Generate every candidate trade per ticker, with its full lifecycle
  // resolved. These are hypotheticals — pass 2 decides which we could
  // actually have taken given the portfolio's concurrent-position limit.
  const candidates = [];

  for (const ticker of tickers) {
    const bars = barsByTicker[ticker];
    let open = null;

    for (let t = cfg.warmupBars; t < bars.length - 1; t++) {
      const slice = bars.slice(0, t + 1);       // POINT-IN-TIME: only past+current
      const bar = bars[t];
      const next = bars[t + 1];

      // ---- Manage an open position first ----
      if (open) {
        const held = t - open.entryIdx;
        let exit = null;

        // 1. Gap-through-stop: open below stop means we fill at open, worse than -1R
        if (bar.o <= open.stop) {
          exit = { price: bar.o, reason: 'gap_through_stop', gapped: true };
        }
        // 2. Intrabar stop hit (conservative: stop checked before target)
        else if (bar.l <= open.stop) {
          exit = { price: open.stop, reason: 'stop', gapped: false };
        }
        // 3. Target hit
        else if (bar.h >= open.target) {
          exit = { price: open.target, reason: 'target', gapped: false };
        }
        // 4. Time stop
        else if (held >= cfg.timeStopDays) {
          exit = { price: bar.c, reason: 'time_stop', gapped: false };
        }

        if (exit) {
          const exitFill = exit.price * (1 - cfg.slippageBps / 10000);
          const rMultiple = (exitFill - open.entryFill) / open.R;
          candidates.push({
            ticker,
            entryIdx: open.entryIdx,
            exitIdx: t,
            entryDate: bars[open.entryIdx + 1].t,
            exitDate: bar.t,
            entry: open.entryFill,
            exit: exitFill,
            stop: open.initialStop,
            target: open.target,
            R: open.R,
            rMultiple,
            daysHeld: held,
            reason: exit.reason,
            gapped: exit.gapped,
            setup: open.setup,
            score: open.score,
          });
          open = null;
          continue;
        }

        // Trailing stop management — mirrors the live rules
        const currentR = (bar.c - open.entryFill) / open.R;
        if (currentR >= 2 && open.stop < open.entryFill + open.R) {
          open.stop = open.entryFill + open.R;      // trail to +1R
        } else if (currentR >= 1 && open.stop < open.entryFill) {
          open.stop = open.entryFill;               // trail to breakeven
        }
        continue;   // one position per ticker at a time
      }

      // ---- Look for an entry ----
      const a = analyze(slice, { assetClass: cfg.assetClass });
      if (a.insufficient) continue;

      // Regime filter
      const vix = vixByTs[dayKey(bar.t)];
      const rg = vix != null ? regime(vix) : null;
      if (rg && rg.sizeMult === 0) continue;              // crisis: no new longs

      let wantEntry = false;
      if (strategy === 'momentum') {
        wantEntry = (a.setup === 'BREAKOUT' || a.setup === 'PULLBACK');
      } else if (strategy === 'mean-reversion') {
        // Connors-style: RSI(2) deeply oversold inside a confirmed uptrend.
        // RSI(14) is the wrong tool here — it rarely prints below 35 while a
        // stock is still above its 200d MA, so a RSI(14) filter fires never.
        const r2 = a.indicators.rsi2;
        const aboveLongTrend = a.indicators.ma200 != null
          ? bar.c > a.indicators.ma200
          : a.trendState.alignedMid;
        wantEntry = aboveLongTrend && r2 != null && r2 < 10;
      } else { // composite: score-gated
        wantEntry = a.score >= 70 && a.setup !== 'BROKEN' && a.setup !== 'AVOID';
      }
      if (!wantEntry) continue;
      if (rg && rg.allow.length && !rg.allow.includes(a.setup) && strategy === 'momentum') continue;

      // Entry at NEXT bar's open, with slippage
      const entryRaw = next.o;
      const entryFill = entryRaw * (1 + cfg.slippageBps / 10000);
      const atr = a.indicators.atr14;
      if (!(atr > 0)) continue;
      const stopDist = Math.min(entryFill * klass.stopCapPct, Math.max(1.5 * atr, entryFill * klass.stopFloorPct));
      const stop = entryFill - stopDist;
      const target = entryFill + cfg.targetR * stopDist;

      open = {
        entryIdx: t,
        entryFill,
        stop,
        initialStop: stop,      // preserved for reporting; `stop` gets trailed
        target,
        R: stopDist,
        setup: a.setup,
        score: a.score,
      };
    }
    // Any still-open position at the end of data is discarded from the RECORD —
    // reporting an unrealised paper gain as a result would inflate it. With
    // reportOpen the position is returned separately, marked to the last close,
    // so a forward paper-trading simulation can show what it is holding now.
    // It still occupies a slot in pass 2 and is excluded from every metric.
    if (open && cfg.reportOpen) {
      const last = bars[bars.length - 1];
      const mark = last.c;
      candidates.push({
        ticker,
        open: true,
        entryIdx: open.entryIdx,
        exitIdx: bars.length - 1,
        entryDate: bars[open.entryIdx + 1].t,
        exitDate: last.t,
        entry: open.entryFill,
        exit: mark,
        stop: open.stop,
        initialStop: open.initialStop,
        target: open.target,
        R: open.R,
        rMultiple: (mark - open.entryFill) / open.R,
        daysHeld: (bars.length - 1) - open.entryIdx,
        reason: 'open',
        gapped: false,
        setup: open.setup,
        score: open.score,
      });
    }
  }

  // ── PASS 2 ─────────────────────────────────────────────────────────────
  // Portfolio-level simulation. Walk candidates in chronological order and
  // accept a trade only when a slot is free. Without this the backtest would
  // silently assume you could hold every signal simultaneously (30+ positions),
  // which is far more permissive than the live rules and materially inflates
  // returns. Skipped signals are counted so the omission is visible.
  candidates.sort((a, b) => a.entryDate - b.entryDate);
  const trades = [];
  let skippedForCapacity = 0;
  const openUntil = [];   // exitDate timestamps of currently-open positions

  for (const c of candidates) {
    // Free any slots whose position closed before this candidate's entry
    for (let i = openUntil.length - 1; i >= 0; i--) {
      if (openUntil[i] <= c.entryDate) openUntil.splice(i, 1);
    }
    if (openUntil.length >= cfg.maxConcurrent) { skippedForCapacity++; continue; }
    openUntil.push(c.exitDate);
    trades.push(c);
  }

  const closed = trades.filter(t => !t.open);
  const openPositions = trades.filter(t => t.open);

  const metrics = computeMetrics(closed, cfg, benchBars);
  if (metrics && !metrics.note) {
    metrics.candidatesGenerated = candidates.length;
    metrics.skippedForCapacity = skippedForCapacity;
    metrics.maxConcurrent = cfg.maxConcurrent;
  }
  return { trades: closed, openPositions, metrics, config: cfg, candidates: candidates.length, skippedForCapacity };
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function computeMetrics(trades, cfg, benchBars) {
  if (!trades.length) {
    return { trades: 0, note: 'no trades generated — loosen the strategy or extend the window' };
  }

  const rs = trades.map(t => t.rMultiple);
  const wins = trades.filter(t => t.rMultiple > 0);
  const losses = trades.filter(t => t.rMultiple <= 0);
  const winRate = wins.length / trades.length;
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.rMultiple, 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s, t) => s + t.rMultiple, 0) / losses.length : 0;

  // THE number that matters
  const expectancy = winRate * avgWinR + (1 - winRate) * avgLossR;

  const grossWin = wins.reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // Equity curve — compound, risking riskPctPerTrade of equity per trade
  let equity = cfg.startEquity;
  let peak = equity;
  let maxDD = 0;
  const curve = [{ t: trades[0].entryDate, equity }];
  const returns = [];
  for (const tr of trades) {
    const pnl = equity * (cfg.riskPctPerTrade / 100) * tr.rMultiple;
    const before = equity;
    equity += pnl;
    returns.push(pnl / before);
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
    curve.push({ t: tr.exitDate, equity });
  }

  // Annualized figures
  const spanMs = trades[trades.length - 1].exitDate - trades[0].entryDate;
  const years = Math.max(spanMs / (365.25 * 24 * 3600 * 1000), 1 / 365);
  const totalReturn = (equity - cfg.startEquity) / cfg.startEquity;
  const cagr = Math.pow(equity / cfg.startEquity, 1 / years) - 1;

  // Sharpe / Sortino on per-trade returns, annualized by trade frequency
  const meanRet = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + Math.pow(x - meanRet, 2), 0) / Math.max(returns.length - 1, 1);
  const sd = Math.sqrt(variance);
  const downside = returns.filter(x => x < 0);
  const dsVar = downside.length
    ? downside.reduce((s, x) => s + x * x, 0) / downside.length
    : 0;
  const dsSd = Math.sqrt(dsVar);
  const tradesPerYear = trades.length / years;
  const sharpe = sd > 0 ? (meanRet / sd) * Math.sqrt(tradesPerYear) : 0;
  const sortino = dsSd > 0 ? (meanRet / dsSd) * Math.sqrt(tradesPerYear) : 0;

  // R-multiple distribution (for the histogram)
  // Bucket boundaries matter for honesty: a clean stop-out fills at almost
  // exactly −1R (a hair worse after slippage). Binning that as "worse than −1R"
  // makes the system look like it routinely blows through its stops when it
  // doesn't. We separate "stop worked as designed" from "stop was gapped".
  const buckets = [
    { label: 'gapped past stop', lo: -Infinity, hi: -1.08, n: 0 },
    { label: '−1R (stop hit)',   lo: -1.08, hi: -0.92, n: 0 },
    { label: '−0.9 to −0.5',     lo: -0.92, hi: -0.5, n: 0 },
    { label: '−0.5 to 0',        lo: -0.5, hi: 0, n: 0 },
    { label: '0 to +1',          lo: 0, hi: 1, n: 0 },
    { label: '+1 to +2',         lo: 1, hi: 2, n: 0 },
    { label: '+2 to +2.5 (tgt)', lo: 2, hi: 2.6, n: 0 },
    { label: '> +2.5R',          lo: 2.6, hi: Infinity, n: 0 },
  ];
  for (const r of rs) {
    for (const b of buckets) { if (r > b.lo && r <= b.hi) { b.n++; break; } }
  }

  // Exit reason breakdown + the honest gap statistic
  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  const gapped = trades.filter(t => t.gapped);
  const gapRate = gapped.length / trades.length;
  const worstGap = gapped.length ? Math.min(...gapped.map(t => t.rMultiple)) : 0;

  // Benchmark (buy & hold SPY over the same span)
  let benchReturn = null;
  if (benchBars && benchBars.length > 1) {
    const startTs = trades[0].entryDate;
    const endTs = trades[trades.length - 1].exitDate;
    const inRange = benchBars.filter(b => b.t >= startTs && b.t <= endTs);
    if (inRange.length > 1) {
      benchReturn = (inRange[inRange.length - 1].c - inRange[0].c) / inRange[0].c;
    }
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinR,
    avgLossR,
    expectancy,                 // ← the headline number
    profitFactor,
    totalReturn,
    cagr,
    maxDrawdown: maxDD,
    sharpe,
    sortino,
    avgDaysHeld: trades.reduce((s, t) => s + t.daysHeld, 0) / trades.length,
    tradesPerYear,
    finalEquity: equity,
    curve,
    distribution: buckets,
    exitReasons: byReason,
    gapThroughStopRate: gapRate,
    gapCount: gapped.length,
    worstGapR: worstGap,
    benchReturn,
    years,
  };
}

/**
 * Walk-forward validation: split the bars into train/test windows and report
 * out-of-sample performance separately. Catches overfitting.
 */
export function walkForward(barsByTicker, opts = {}, vixBars = null, splits = 3) {
  const results = [];
  const tickers = Object.keys(barsByTicker);
  if (!tickers.length) return results;
  const cfg = { ...DEFAULTS, ...opts };
  const len = Math.min(...tickers.map(t => barsByTicker[t].length));

  // Each window must carry its full warmup history, otherwise the indicators
  // are never valid and the window trades nothing. Naively slicing the bar
  // array into N equal pieces (the obvious implementation) silently produces
  // zero trades whenever len/splits < warmupBars — which looked like "the
  // strategy has no edge out of sample" when really it just never ran.
  const tradableLen = len - cfg.warmupBars;
  if (tradableLen < splits * 25) {
    return [{
      window: 1,
      note: `need ≥${cfg.warmupBars + splits * 25} bars for ${splits}-way walk-forward; have ${len}`,
      metrics: null,
    }];
  }
  const windowSize = Math.floor(tradableLen / splits);

  for (let i = 0; i < splits; i++) {
    const testStart = cfg.warmupBars + i * windowSize;
    const testEnd = i === splits - 1 ? len : cfg.warmupBars + (i + 1) * windowSize;
    // Give the window ALL preceding bars so indicators are valid, then only
    // count trades whose entry falls inside the out-of-sample slice.
    const sliced = {};
    for (const t of tickers) sliced[t] = barsByTicker[t].slice(0, testEnd);
    const vixSlice = vixBars ? vixBars.slice(0, testEnd) : null;
    const r = runBacktest(sliced, opts, vixSlice);

    const anyTicker = barsByTicker[tickers[0]];
    const fromTs = anyTicker[testStart]?.t;
    const toTs = anyTicker[testEnd - 1]?.t;
    const windowTrades = (r.trades || []).filter(tr => tr.entryDate >= fromTs);
    results.push({
      window: i + 1,
      from: fromTs,
      to: toTs,
      metrics: windowTrades.length ? computeMetrics(windowTrades, cfg, null) : { note: 'no trades in window' },
    });
  }
  return results;
}

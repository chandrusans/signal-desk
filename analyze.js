// Momentum-swing analytics — pure functions over OHLC bars.
// Modeled on how a long-only momentum book screens: trend alignment,
// pullback/breakout setups, ATR-based stops, R-multiple targets, VIX regime filter.
// All numbers computed from real OHLC. No fabricated signal weights.

// ------- Indicators -------

function sma(closes, n) {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

function smaSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += closes[i];
  out[n - 1] = s / n;
  for (let i = n; i < closes.length; i++) {
    s += closes[i] - closes[i - n];
    out[i] = s / n;
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = 0;
  for (let i = 0; i < period; i++) a += trs[i];
  a /= period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
}

function slope(series, lookback = 5) {
  const vals = series.filter((v) => v != null).slice(-lookback);
  if (vals.length < 2) return 0;
  const first = vals[0], last = vals[vals.length - 1];
  return (last - first) / first;
}

function pctReturn(closes, lookback) {
  if (closes.length < lookback + 1) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - lookback];
  return ((now - then) / then) * 100;
}

function highest(vals, lookback) {
  const slice = vals.slice(-lookback);
  return slice.length ? Math.max(...slice) : null;
}

function avgVolume(bars, lookback) {
  if (bars.length < lookback) return null;
  let s = 0;
  for (let i = bars.length - lookback; i < bars.length; i++) s += bars[i].v;
  return s / lookback;
}

// ------- Core analysis -------

export function analyze(bars, extras = {}) {
  if (!bars || bars.length < 60) {
    return { insufficient: true, reason: 'need ≥60 bars of history' };
  }
  const news = extras.news;
  // extras.benchBars  — SPY (or sector ETF) bars for relative-strength scoring
  // extras.earnings   — { date: 'YYYY-MM-DD' } next earnings date
  // extras.breadth    — { pctAbove50: 0..100 } market breadth for regime context
  const benchBars = extras.benchBars;
  const earnings = extras.earnings;
  const closes = bars.map((b) => b.c);
  const price = closes[closes.length - 1];

  const ma10  = sma(closes, 10);
  const ma20  = sma(closes, 20);
  const ma50  = sma(closes, 50);
  const ma200 = closes.length >= 200 ? sma(closes, 200) : null;
  const ma20Slope = slope(smaSeries(closes, 20), 5);

  const rsi14 = rsi(closes, 14);
  // RSI(2) — the Connors short-term mean-reversion oscillator. RSI(14) almost
  // never reads below 35 inside a confirmed uptrend, which is why a RSI(14)
  // -based pullback filter generates no trades. RSI(2) is the correct tool.
  const rsi2 = rsi(closes, 2);
  const atr14 = atr(bars, 14);
  const atrPct = atr14 != null ? (atr14 / price) * 100 : null;

  const ret20 = pctReturn(closes, 20);
  const ret60 = pctReturn(closes, 60);

  // ---- Relative strength vs benchmark (SPY) ----
  // A stock up 5% while SPY is up 9% is a LAGGARD, not a leader. Absolute
  // momentum alone systematically buys underperformers in a strong tape.
  let rs20 = null, rs60 = null, benchRet20 = null, benchRet60 = null;
  if (benchBars && benchBars.length >= 61) {
    const bCloses = benchBars.map(b => b.c);
    benchRet20 = pctReturn(bCloses, 20);
    benchRet60 = pctReturn(bCloses, 60);
    if (ret20 != null && benchRet20 != null) rs20 = ret20 - benchRet20;
    if (ret60 != null && benchRet60 != null) rs60 = ret60 - benchRet60;
  }

  const high52w = highest(closes, Math.min(252, closes.length));
  const distFrom52w = high52w ? ((price - high52w) / high52w) * 100 : null;
  const high20 = highest(closes, 20);
  const distFrom20 = high20 ? ((price - high20) / high20) * 100 : null;

  const vol5  = avgVolume(bars, 5);
  const vol20 = avgVolume(bars, 20);
  const volRatio = vol5 && vol20 ? vol5 / vol20 : null;

  const alignedFull = ma200 != null && price > ma20 && ma20 > ma50 && ma50 > ma200;
  const alignedMid  = price > ma20 && ma20 > ma50;
  const alignedShort = price > ma20;

  // ---- Composite score (0-100) ----
  const parts = { trend: 0, momentum: 0, location: 0, volume: 0, volatility: 0 };
  let notes = [];

  // Trend (30 pts) — alignment + slope
  if (alignedFull) { parts.trend = 25; notes.push('Full MA alignment (price > MA20 > MA50 > MA200)'); }
  else if (alignedMid) { parts.trend = 17; notes.push('Price > MA20 > MA50 (200d not confirmed)'); }
  else if (alignedShort) { parts.trend = 8; notes.push('Above MA20 only — trend developing'); }
  else { notes.push('Below MA20 — trend broken or basing'); }
  if (ma20Slope > 0.01) { parts.trend += 5; notes.push(`MA20 sloping up (+${(ma20Slope*100).toFixed(1)}% / 5d)`); }
  else if (ma20Slope < -0.01) { notes.push(`MA20 sloping down (${(ma20Slope*100).toFixed(1)}% / 5d)`); }

  // Momentum (25 pts) — RELATIVE strength preferred over absolute return.
  // When a benchmark is supplied we score outperformance vs SPY; a stock up
  // 5% while SPY is up 9% scores as the laggard it is. Falls back to absolute
  // 20d return only when no benchmark is available.
  const r20 = ret20 || 0;
  if (rs20 != null) {
    // RS sweet spot: +8% or better vs SPY over 20 days = full marks
    if (rs20 <= 0) {
      parts.momentum = 0;
      notes.push(`Relative strength ${rs20.toFixed(1)}% vs SPY — underperforming, laggard`);
    } else if (rs20 >= 8) {
      parts.momentum = 25;
      notes.push(`Relative strength +${rs20.toFixed(1)}% vs SPY — clear leader`);
    } else {
      parts.momentum = Math.round((rs20 / 8) * 25);
      notes.push(`Relative strength +${rs20.toFixed(1)}% vs SPY (abs ${r20 >= 0 ? '+' : ''}${r20.toFixed(1)}%)`);
    }
    // Confirm with the 60-day RS — persistence matters more than a single spike
    if (rs60 != null && rs60 > 0 && rs20 > 0) {
      notes.push(`60d RS +${rs60.toFixed(1)}% — outperformance is persistent`);
    } else if (rs60 != null && rs60 < -5 && rs20 > 0) {
      parts.momentum = Math.max(0, parts.momentum - 6);
      notes.push(`60d RS ${rs60.toFixed(1)}% — recent strength is a bounce, not a trend`);
    }
  } else {
    if (r20 <= 0) { parts.momentum = 0; notes.push(`20d return ${r20.toFixed(1)}% — no momentum`); }
    else if (r20 >= 15) { parts.momentum = 25; notes.push(`20d return +${r20.toFixed(1)}% — strong momentum`); }
    else { parts.momentum = Math.round((r20 / 15) * 25); notes.push(`20d return +${r20.toFixed(1)}%`); }
  }
  if (rsi14 != null) {
    if (rsi14 > 75) { parts.momentum = Math.max(0, parts.momentum - 8); notes.push(`RSI ${rsi14.toFixed(0)} — overbought penalty`); }
    else if (rsi14 < 30) { parts.momentum = Math.max(0, parts.momentum - 5); notes.push(`RSI ${rsi14.toFixed(0)} — oversold, momentum negative`); }
    else notes.push(`RSI ${rsi14.toFixed(0)} — healthy range`);
  }

  // Location (20 pts) — how close to 52w high
  if (distFrom52w != null) {
    if (distFrom52w >= -3) { parts.location = 20; notes.push(`At/near 52w high (${distFrom52w.toFixed(1)}%)`); }
    else if (distFrom52w >= -10) { parts.location = 14; notes.push(`Within 10% of 52w high (${distFrom52w.toFixed(1)}%)`); }
    else if (distFrom52w >= -20) { parts.location = 6; notes.push(`10–20% below 52w high (${distFrom52w.toFixed(1)}%)`); }
    else notes.push(`>20% below 52w high (${distFrom52w.toFixed(1)}%) — not in an uptrend`);
  }

  // Volume (15 pts) — accumulation via 5/20 volume ratio
  if (volRatio != null) {
    if (volRatio >= 1.3) { parts.volume = 15; notes.push(`Volume expanding (5d/20d = ${volRatio.toFixed(2)})`); }
    else if (volRatio >= 1.1) { parts.volume = 10; notes.push(`Mild volume pickup (${volRatio.toFixed(2)})`); }
    else if (volRatio >= 0.9) { parts.volume = 5; notes.push(`Neutral volume (${volRatio.toFixed(2)})`); }
    else notes.push(`Volume drying up (${volRatio.toFixed(2)}) — no participation`);
  }

  // Volatility (10 pts) — tradable ATR range
  if (atrPct != null) {
    if (atrPct >= 1.5 && atrPct <= 4) { parts.volatility = 10; notes.push(`ATR ${atrPct.toFixed(1)}% — tradable range`); }
    else if (atrPct < 1.5) { parts.volatility = 6; notes.push(`ATR ${atrPct.toFixed(1)}% — quiet, tight`); }
    else if (atrPct <= 6) { parts.volatility = 5; notes.push(`ATR ${atrPct.toFixed(1)}% — elevated`); }
    else notes.push(`ATR ${atrPct.toFixed(1)}% — too wild, cut size`);
  }

  // Catalyst adjustment from live news sentiment (max ±10)
  let catalyst = 0;
  if (news && news.count24h > 0) {
    const intensity = Math.min(news.count24h, 5) * 2; // 2..10
    catalyst = Math.round(news.avgSentiment * intensity);
    if (catalyst > 0) notes.push(`News catalyst: ${news.count24h} headlines / 24h · avg sentiment ${news.avgSentiment >= 0 ? '+' : ''}${news.avgSentiment} → +${catalyst} pts`);
    else if (catalyst < 0) notes.push(`News drag: ${news.count24h} headlines / 24h · avg sentiment ${news.avgSentiment.toFixed(2)} → ${catalyst} pts`);
    else notes.push(`News flow: ${news.count24h} headlines / 24h · sentiment neutral`);
  }
  parts.catalyst = catalyst;

  // Political overlay — sector-aware, max ±8
  let political = 0;
  if (news && news.political24h > 0) {
    const polIntensity = Math.min(news.political24h, 4) * 2; // 2..8
    political = Math.round(news.avgPoliticalSentiment * polIntensity);
    if (political > 0) notes.push(`Political tailwind (${news.sector || 'generic'}): ${news.political24h} political headlines · avg ${news.avgPoliticalSentiment >= 0 ? '+' : ''}${news.avgPoliticalSentiment} → +${political} pts`);
    else if (political < 0) notes.push(`Political headwind (${news.sector || 'generic'}): ${news.political24h} political headlines · avg ${news.avgPoliticalSentiment.toFixed(2)} → ${political} pts`);
    else notes.push(`Political flow: ${news.political24h} headlines, sentiment neutral for this sector`);
  }
  parts.political = political;

  // ---- Earnings-in-window risk (the #1 killer of ATR-based stops) ----
  // A 15-trading-day swing routinely straddles an earnings print. Gaps don't
  // respect stops — a stock that opens −12% fills your stop at −12%, not −1R.
  // We surface this loudly and haircut the score rather than pretend it away.
  let earningsRisk = null;
  if (earnings && earnings.date) {
    const eTs = Date.parse(earnings.date + 'T00:00:00Z');
    if (!isNaN(eTs)) {
      const calDays = Math.round((eTs - Date.now()) / 86400000);
      // 15 trading days ≈ 21 calendar days
      const inWindow = calDays >= 0 && calDays <= 21;
      earningsRisk = {
        date: earnings.date,
        calendarDays: calDays,
        inHoldingWindow: inWindow,
        severity: calDays < 0 ? 'past' : calDays <= 5 ? 'imminent' : inWindow ? 'in-window' : 'clear',
      };
      if (earningsRisk.severity === 'imminent') {
        notes.push(`⚠ Earnings in ${calDays}d — gap risk defeats the stop. Halve size or wait for the print.`);
      } else if (inWindow) {
        notes.push(`⚠ Earnings ${calDays}d out — inside the 15-day holding window. Plan to exit before the print.`);
      }
    }
  }

  // Gap-through-stop history: how often has this name opened beyond 1.5×ATR
  // from the prior close? High-beta names do this far more than the ATR model
  // assumes, and it turns a nominal −1R into a −2R or worse.
  let gapRisk = null;
  if (atr14 > 0 && bars.length > 60) {
    let gaps = 0, checked = 0, worst = 0;
    for (let i = Math.max(1, bars.length - 252); i < bars.length; i++) {
      const prevClose = bars[i - 1].c;
      const gapPct = (bars[i].o - prevClose) / prevClose;
      const atrPctLocal = atr14 / price;
      checked++;
      if (Math.abs(gapPct) > 1.5 * atrPctLocal) {
        gaps++;
        if (gapPct < worst) worst = gapPct;
      }
    }
    gapRisk = {
      frequency: checked ? gaps / checked : 0,
      count: gaps,
      worstGapPct: worst * 100,
    };
    if (gapRisk.frequency > 0.04) {
      notes.push(`Gap risk elevated: opened beyond 1.5×ATR on ${(gapRisk.frequency*100).toFixed(1)}% of days (worst ${(worst*100).toFixed(1)}%) — stops may slip.`);
    }
  }

  const score = Math.max(0, Math.min(100, parts.trend + parts.momentum + parts.location + parts.volume + parts.volatility + catalyst + political));

  // ---- Setup classifier ----
  let setup = 'AVOID', setupReason = '';
  // Earnings inside 5 days overrides everything: no new entry, regardless of
  // how good the technical setup looks. You cannot risk-manage a gap.
  if (earningsRisk && earningsRisk.severity === 'imminent') {
    setup = 'EARNINGS';
    setupReason = `Earnings in ${earningsRisk.calendarDays}d (${earningsRisk.date}). No new entry — a gap through your stop is unmanageable. Revisit after the print.`;
  } else if (!alignedShort || (ma50 && price < ma50)) {
    setup = 'BROKEN';
    setupReason = 'Price below key MAs — trend broken; wait for base and reclaim';
  } else if (rsi14 != null && (rsi14 > 78 || (distFrom52w != null && distFrom52w > 0 && r20 > 25))) {
    setup = 'EXTENDED';
    setupReason = 'Overextended — chasing here has poor R:R; wait for pullback to MA10/20';
  } else if (
    distFrom20 != null && distFrom20 >= -1 && volRatio != null && volRatio >= 1.2 &&
    rsi14 != null && rsi14 >= 55 && rsi14 <= 72 && alignedMid
  ) {
    setup = 'BREAKOUT';
    setupReason = 'At 20d highs on expanding volume with healthy RSI — clean momentum entry';
  } else if (
    alignedMid && ma10 && Math.abs((price - ma10) / ma10) < 0.02 &&
    rsi14 != null && rsi14 >= 40 && rsi14 <= 58 && r20 > 3
  ) {
    setup = 'PULLBACK';
    setupReason = 'Uptrend pulling back to MA10 with RSI cooled — buy-the-dip entry in a trend';
  } else if (alignedShort && ma20 && (price - ma20) / ma20 > 0.06) {
    setup = 'EXTENDED';
    setupReason = 'Price extended >6% above MA20 — wait for mean reversion';
  } else if (alignedShort && ma50 && price > ma50) {
    setup = 'EARLY';
    setupReason = 'Uptrend forming but no confirmed breakout or pullback entry yet — watchlist';
  } else {
    setup = 'AVOID';
    setupReason = 'No clean setup on this bar';
  }

  // ---- Trade plan (ATR-based) ----
  const plan = tradePlan({ price, atr14, atrPct, setup, ma10, ma20, distFrom52w });

  return {
    price,
    indicators: {
      ma10, ma20, ma50, ma200, ma20Slope, rsi14, rsi2, atr14, atrPct,
      ret20, ret60, high52w, distFrom52w, distFrom20, vol5, vol20, volRatio,
      // Relative strength — the review's highest-value signal upgrade
      rs20, rs60, benchRet20, benchRet60,
    },
    trendState: { alignedFull, alignedMid, alignedShort },
    parts,
    score,
    notes,
    setup,
    setupReason,
    plan,
    earningsRisk,
    gapRisk,
  };
}

function tradePlan({ price, atr14, atrPct, setup, ma10, ma20 }) {
  if (atr14 == null || price == null) return null;
  // Entry: at market for BREAKOUT; at MA10 pullback zone for PULLBACK
  const entryLow  = setup === 'PULLBACK' && ma10 ? Math.min(price, ma10) * 0.995 : price * 0.985;
  const entryHigh = setup === 'PULLBACK' && ma10 ? Math.max(price, ma10) * 1.005 : price * 1.015;
  const entry = (entryLow + entryHigh) / 2;

  // Stop: max(1.5*ATR, 5% of price), capped at 10%
  const stopDist = Math.min(entry * 0.10, Math.max(1.5 * atr14, entry * 0.05));
  const stop = entry - stopDist;
  const stopPct = (stopDist / entry) * 100;

  // Target: 2.5R (2.5x initial risk) — anchors the 15-25% swing goal to real vol
  const R = stopDist;
  const target = entry + 2.5 * R;
  const targetPct = ((target - entry) / entry) * 100;
  const rr = 2.5;

  // Position size using risk-parity: risk 0.75% of capital per trade
  // shares per $10k capital = (10000 * 0.0075) / stopDist
  const shares10k = Math.floor((10000 * 0.0075) / stopDist);
  const sizeNotional = ((shares10k * entry) / 10000) * 100; // % of $10k capital deployed

  return {
    entry, entryLow, entryHigh,
    stop, stopPct,
    target, targetPct,
    rr,
    atrMult: 1.5,
    timeStopDays: 15,
    shares10k,
    sizePct: Math.min(20, +sizeNotional.toFixed(1)),
    riskPct: 0.75, // % of capital risked per trade
  };
}

// ------- Regime -------

export function regime(vixPrice, breadth = null) {
  let base;
  if (vixPrice == null) base = { level: 'unknown', sizeMult: 1, allow: ['BREAKOUT','PULLBACK','EARLY'], note: 'VIX unavailable' };
  else if (vixPrice < 15) base = { level: 'calm',    sizeMult: 1.0, allow: ['BREAKOUT','PULLBACK','EARLY'], note: 'Low-vol regime — full sizing' };
  else if (vixPrice < 20) base = { level: 'normal',  sizeMult: 1.0, allow: ['BREAKOUT','PULLBACK'],         note: 'Normal — trade A+ setups only' };
  else if (vixPrice < 25) base = { level: 'elevated',sizeMult: 0.5, allow: ['PULLBACK'],                    note: 'Half size — pullbacks only, no chasing' };
  else if (vixPrice < 35) base = { level: 'stress',  sizeMult: 0.25,allow: [],                              note: 'No new longs — manage existing risk' };
  else base =                    { level: 'crisis', sizeMult: 0,   allow: [],                              note: 'Risk-off — exit weakest, hedge book' };

  // ---- Breadth as a SECOND regime input ----
  // VIX alone lags. Low VIX with collapsing breadth (2007, Jan 2020) is exactly
  // when momentum entries stop working — the index is held up by a handful of
  // names while the average stock is already rolling over.
  if (breadth && breadth.pctAbove50 != null) {
    const b = breadth.pctAbove50;
    base.breadth = b;
    if (b < 30) {
      base.sizeMult = Math.min(base.sizeMult, 0.25);
      base.allow = [];
      base.level = base.level === 'calm' || base.level === 'normal' ? 'divergent' : base.level;
      base.note = `Breadth collapsed — only ${b.toFixed(0)}% of universe above its 50d MA. Index calm but internals broken. No new longs.`;
    } else if (b < 45) {
      base.sizeMult = Math.min(base.sizeMult, 0.5);
      base.allow = base.allow.filter(s => s === 'PULLBACK');
      base.note = `Narrow tape — ${b.toFixed(0)}% above 50d MA. Half size, pullbacks only. ${base.note}`;
    } else if (b > 65) {
      base.note = `${base.note} · Breadth healthy (${b.toFixed(0)}% above 50d MA).`;
    }
  }
  return base;
}

/**
 * Market breadth from a set of ticker bar-series: the % trading above their
 * own 50-day moving average. A real, computable breadth proxy from data we
 * already fetch — no extra vendor needed.
 */
export function computeBreadth(barsByTicker) {
  let above = 0, total = 0;
  for (const bars of Object.values(barsByTicker || {})) {
    if (!bars || bars.length < 50) continue;
    const closes = bars.map(b => b.c);
    const ma50 = sma(closes, 50);
    if (ma50 == null) continue;
    total++;
    if (closes[closes.length - 1] > ma50) above++;
  }
  if (!total) return null;
  return { pctAbove50: (above / total) * 100, above, total };
}

/**
 * Portfolio heat: total open risk expressed in R. The review is right that the
 * Handbook implies this but nothing computed it. Cap around 4–6R.
 * @param positions [{ price, stop, qty, multiplier }]
 * @param equity     account size in dollars
 */
export function portfolioHeat(positions, equity) {
  if (!equity || equity <= 0) return null;
  let openRiskDollars = 0;
  const perPosition = [];
  for (const p of positions || []) {
    const mult = p.multiplier || 1;
    const stop = p.stop != null ? p.stop : p.buyPrice * 0.95;
    // Risk remaining = current price − stop (never negative; a trade above its
    // trailed stop has locked in gains and carries no further downside to stop)
    const riskPerShare = Math.max(0, (p.price ?? p.buyPrice) - stop);
    const dollars = riskPerShare * (p.qty || 0) * mult;
    openRiskDollars += dollars;
    perPosition.push({ ticker: p.ticker, riskDollars: dollars, riskPct: (dollars / equity) * 100 });
  }
  const heatPct = (openRiskDollars / equity) * 100;
  return {
    openRiskDollars,
    heatPct,
    heatR: heatPct,                  // with 1% risk per trade, 1R ≈ 1% of equity
    perPosition,
    status: heatPct > 6 ? 'over' : heatPct > 4 ? 'warm' : 'ok',
    note: heatPct > 6
      ? `Portfolio heat ${heatPct.toFixed(1)}% — over the 6% ceiling. Close or tighten something before adding.`
      : heatPct > 4
        ? `Portfolio heat ${heatPct.toFixed(1)}% — approaching the 6% ceiling. One more full-size entry maximum.`
        : `Portfolio heat ${heatPct.toFixed(1)}% — room to add.`,
  };
}

/**
 * Position size from risk-parity: shares such that (entry − stop) × shares
 * equals riskPct of equity. This is the formula the Handbook describes.
 */
export function positionSize(entry, stop, equity, riskPct = 1.0, sizeMult = 1) {
  const riskPerShare = entry - stop;
  if (!(riskPerShare > 0) || !(equity > 0)) return null;
  const riskDollars = equity * (riskPct / 100) * sizeMult;
  const shares = Math.floor(riskDollars / riskPerShare);
  return {
    shares,
    riskDollars,
    notional: shares * entry,
    notionalPct: ((shares * entry) / equity) * 100,
    riskPerShare,
  };
}

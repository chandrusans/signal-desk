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

export function analyze(bars) {
  if (!bars || bars.length < 60) {
    return { insufficient: true, reason: 'need ≥60 bars of history' };
  }
  const closes = bars.map((b) => b.c);
  const price = closes[closes.length - 1];

  const ma10  = sma(closes, 10);
  const ma20  = sma(closes, 20);
  const ma50  = sma(closes, 50);
  const ma200 = closes.length >= 200 ? sma(closes, 200) : null;
  const ma20Slope = slope(smaSeries(closes, 20), 5);

  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const atrPct = atr14 != null ? (atr14 / price) * 100 : null;

  const ret20 = pctReturn(closes, 20);
  const ret60 = pctReturn(closes, 60);

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

  // Momentum (25 pts) — 20d return with RSI overbought penalty
  const r20 = ret20 || 0;
  if (r20 <= 0) { parts.momentum = 0; notes.push(`20d return ${r20.toFixed(1)}% — no momentum`); }
  else if (r20 >= 15) { parts.momentum = 25; notes.push(`20d return +${r20.toFixed(1)}% — strong momentum`); }
  else { parts.momentum = Math.round((r20 / 15) * 25); notes.push(`20d return +${r20.toFixed(1)}%`); }
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

  const score = Math.max(0, Math.min(100, parts.trend + parts.momentum + parts.location + parts.volume + parts.volatility));

  // ---- Setup classifier ----
  let setup = 'AVOID', setupReason = '';
  if (!alignedShort || (ma50 && price < ma50)) {
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
    indicators: { ma10, ma20, ma50, ma200, ma20Slope, rsi14, atr14, atrPct, ret20, ret60, high52w, distFrom52w, distFrom20, vol5, vol20, volRatio },
    trendState: { alignedFull, alignedMid, alignedShort },
    parts,
    score,
    notes,
    setup,
    setupReason,
    plan,
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

export function regime(vixPrice) {
  if (vixPrice == null) return { level: 'unknown', sizeMult: 1, allow: ['BREAKOUT','PULLBACK','EARLY'], note: 'VIX unavailable' };
  if (vixPrice < 15) return { level: 'calm',    sizeMult: 1.0, allow: ['BREAKOUT','PULLBACK','EARLY'], note: 'Low-vol regime — full sizing' };
  if (vixPrice < 20) return { level: 'normal',  sizeMult: 1.0, allow: ['BREAKOUT','PULLBACK'],         note: 'Normal — trade A+ setups only' };
  if (vixPrice < 25) return { level: 'elevated',sizeMult: 0.5, allow: ['PULLBACK'],                    note: 'Half size — pullbacks only, no chasing' };
  if (vixPrice < 35) return { level: 'stress',  sizeMult: 0.25,allow: [],                              note: 'No new longs — manage existing risk' };
  return                    { level: 'crisis', sizeMult: 0,   allow: [],                              note: 'Risk-off — exit weakest, hedge book' };
}

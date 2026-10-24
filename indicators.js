// Signal Desk — display-only indicators and statistical tests, separate from the rulebook.
//
// analyze.js holds the tested rulebook (the only things that drive BUY/SELL). This file
// holds what people ask to SEE: higher-timeframe trend, MACD, Bollinger %B, seasonality and
// day-of-week tests with multiple-testing correction, drawdowns for stress tests, liquidity,
// rate sensitivity and a 1–10 risk rating. Each function states what it is and is not.
// Nothing here changes a verdict.

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const sma = (xs, n) => (xs.length >= n ? mean(xs.slice(-n)) : null);
const ema = (xs, n) => { if (xs.length < n) return null; const k = 2 / (n + 1); let e = mean(xs.slice(0, n)); for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k); return e; };

/** Resample daily bars {t,o,h,l,c,v} into weekly (ISO week) or monthly bars. */
export function resample(bars, period = 'week') {
  const out = []; let cur = null, key = null;
  for (const b of bars) {
    const d = new Date(b.t);
    const k = period === 'month' ? `${d.getUTCFullYear()}-${d.getUTCMonth()}` : (() => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1)); return `${x.getUTCFullYear()}-W${Math.ceil(((x - y0) / 864e5 + 1) / 7)}`; })();
    if (k !== key) { if (cur) out.push(cur); cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; key = k; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Trend label on one timeframe: price vs fast and slow averages and the slow average's slope. */
export function trendLabel(closes, fast, slow) {
  if (closes.length < slow + 5) return { label: 'insufficient', fast: null, slow: null };
  const f = sma(closes, fast), s = sma(closes, slow), sPrev = sma(closes.slice(0, -5), slow), p = closes[closes.length - 1];
  const up = p > f && f > s && s > sPrev, down = p < f && f < s && s < sPrev;
  return { label: up ? 'uptrend' : down ? 'downtrend' : p > s ? 'sideways-up' : 'sideways-down', price: p, fast: f, slow: s, slopePct: sPrev ? ((s / sPrev - 1) * 100) : null };
}

/** Daily / weekly / monthly trend from daily bars (needs ~5y for the monthly read). */
export function multiTimeframeTrend(bars) {
  const c = bars.map((b) => b.c);
  const w = resample(bars, 'week').map((b) => b.c), m = resample(bars, 'month').map((b) => b.c);
  return {
    daily: { ...trendLabel(c, 50, 200), fastName: '50-day', slowName: '200-day', ma100: sma(c, 100) },
    weekly: { ...trendLabel(w, 10, 40), fastName: '10-week', slowName: '40-week' },
    monthly: { ...trendLabel(m, 6, 12), fastName: '6-month', slowName: '12-month' },
  };
}

/** MACD (12, 26, 9) on closes. Display only — it did not add to the backtest. */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal + 5) return null;
  const line = [];
  for (let i = slow; i <= closes.length; i++) { const w = closes.slice(0, i); line.push(ema(w, fast) - ema(w, slow)); }
  const sig = ema(line, signal);
  const m = line[line.length - 1], prev = line[line.length - 2], sigPrev = ema(line.slice(0, -1), signal);
  return { macd: m, signal: sig, histogram: m - sig, cross: prev != null && sigPrev != null ? (prev <= sigPrev && m > sig ? 'bullish cross' : prev >= sigPrev && m < sig ? 'bearish cross' : m > sig ? 'above signal' : 'below signal') : null };
}

/** Bollinger Bands (20, 2): %B says where price sits in the band; bandwidth says how tight. */
export function bollinger(closes, n = 20, k = 2) {
  if (closes.length < n) return null;
  const w = closes.slice(-n), m = mean(w), s = sd(w), p = closes[closes.length - 1];
  const upper = m + k * s, lower = m - k * s;
  return { middle: m, upper, lower, percentB: upper > lower ? (p - lower) / (upper - lower) : null, bandwidthPct: m > 0 ? ((upper - lower) / m) * 100 : null };
}

/** RSI(14) Wilder — same definition as the rulebook, exposed for the card. */
export function rsi(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** Welch-style one-sample t against zero mean; two-sided p approximated from the normal for n ≥ 20. */
function tStat(a) { const n = a.length; if (n < 8) return null; const s = sd(a); if (!s) return null; return (mean(a) / (s / Math.sqrt(n))); }
const pFromT = (t, n) => { if (t == null) return null; const z = Math.abs(t) * (n >= 30 ? 1 : Math.sqrt(n / (n + 2))); const p = 2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2))); return p; };
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }

/** Seasonality: mean return by calendar month with t-stat and Bonferroni-corrected significance (12 tests). */
export function seasonality(bars) {
  const months = resample(bars, 'month');
  const by = Array.from({ length: 12 }, () => []);
  for (let i = 1; i < months.length; i++) { const r = (months[i].c / months[i - 1].c - 1) * 100; by[new Date(months[i].t).getUTCMonth()].push(r); }
  const rows = by.map((a, m) => { const t = tStat(a); const p = pFromT(t, a.length); return { month: m + 1, n: a.length, meanPct: mean(a), winRate: a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null, t, p, significantAfterBonferroni: p != null && p * 12 < 0.05 }; });
  const valid = rows.filter((r) => r.n >= 3);
  const best = valid.slice().sort((a, b) => b.meanPct - a.meanPct)[0], worst = valid.slice().sort((a, b) => a.meanPct - b.meanPct)[0];
  return { rows, best, worst, yearsCovered: +(months.length / 12).toFixed(1), anySignificant: rows.some((r) => r.significantAfterBonferroni), note: 'Twelve months are twelve tests: a month must clear p < 0.05/12 to count. With under ten years of data almost none do, which is the honest finding.' };
}

/** Day-of-week: mean daily return Monday–Friday with Bonferroni (5 tests). */
export function dayOfWeek(bars) {
  const by = Array.from({ length: 5 }, () => []);
  for (let i = 1; i < bars.length; i++) { const d = new Date(bars[i].t).getUTCDay(); if (d >= 1 && d <= 5) by[d - 1].push((bars[i].c / bars[i - 1].c - 1) * 100); }
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const rows = by.map((a, i) => { const t = tStat(a); const p = pFromT(t, a.length); return { day: names[i], n: a.length, meanPct: mean(a), t, p, significantAfterBonferroni: p != null && p * 5 < 0.05 }; });
  return { rows, anySignificant: rows.some((r) => r.significantAfterBonferroni), note: 'Five tests, so p < 0.01 is the bar. A day that fails it is noise, however good it looks.' };
}

/** Maximum drawdown over a close series, with its window. */
export function maxDrawdown(bars) {
  let peak = -Infinity, peakT = null, mdd = 0, from = null, to = null, troughT = null;
  for (const b of bars) {
    if (b.c > peak) { peak = b.c; peakT = b.t; }
    const dd = (b.c / peak - 1) * 100;
    if (dd < mdd) { mdd = dd; from = peakT; to = b.t; troughT = b.t; }
  }
  return { maxDrawdownPct: +mdd.toFixed(1), from: from ? new Date(from).toISOString().slice(0, 10) : null, to: troughT ? new Date(troughT).toISOString().slice(0, 10) : null };
}

/** Return of a series between two dates (closest bars), for stress windows like 2020-02-19 → 2020-03-23. */
export function windowReturn(bars, fromISO, toISO) {
  const f = Date.parse(fromISO), t = Date.parse(toISO);
  const a = bars.find((b) => b.t >= f), z = [...bars].reverse().find((b) => b.t <= t);
  return a && z && z.t > a.t ? +((z.c / a.c - 1) * 100).toFixed(1) : null;
}
export const STRESS_WINDOWS = [
  { name: 'COVID crash', from: '2020-02-19', to: '2020-03-23' },
  { name: '2022 bear market', from: '2022-01-03', to: '2022-10-12' },
  { name: 'Worst 60 sessions in the data', rolling: 60 },
];
/** Worst rolling N-session return. */
export function worstRolling(bars, n = 60) {
  let worst = 0, at = null;
  for (let i = n; i < bars.length; i++) { const r = (bars[i].c / bars[i - n].c - 1) * 100; if (r < worst) { worst = r; at = bars[i].t; } }
  return { pct: +worst.toFixed(1), endedOn: at ? new Date(at).toISOString().slice(0, 10) : null };
}

/** Liquidity: how many sessions to exit a position at 10% of average dollar volume. */
export function liquidity(bars, notional) {
  const last20 = bars.slice(-20);
  if (last20.length < 5) return null;
  const adv = mean(last20.map((b) => (b.c || 0) * (b.v || 0)));
  if (!(adv > 0)) return null;
  const sessions = notional / (adv * 0.1);
  return { avgDollarVolume: adv, sessionsToExit: +sessions.toFixed(2), rating: sessions <= 0.1 ? 'deep' : sessions <= 1 ? 'fine' : sessions <= 5 ? 'thin' : 'illiquid' };
}

/** Sensitivity of a holding's daily returns to daily changes in the 10-year yield (beta to Δyield, last ~120 sessions). */
export function rateBeta(bars, tnxBars, n = 120) {
  const byDay = new Map(tnxBars.map((b) => [new Date(b.t).toISOString().slice(0, 10), b.c]));
  const xs = [], ys = [];
  for (let i = 1; i < bars.length; i++) {
    const d0 = new Date(bars[i - 1].t).toISOString().slice(0, 10), d1 = new Date(bars[i].t).toISOString().slice(0, 10);
    if (!byDay.has(d0) || !byDay.has(d1)) continue;
    xs.push(byDay.get(d1) - byDay.get(d0)); ys.push((bars[i].c / bars[i - 1].c - 1) * 100);
  }
  const X = xs.slice(-n), Yv = ys.slice(-n);
  if (X.length < 40) return null;
  const mx = mean(X), my = mean(Yv);
  let sxy = 0, sxx = 0; for (let i = 0; i < X.length; i++) { sxy += (X[i] - mx) * (Yv[i] - my); sxx += (X[i] - mx) ** 2; }
  if (!sxx) return null;
  const beta = sxy / sxx;   // % stock move per +1.00 pt move in the 10-year yield
  return { betaPerPoint: +beta.toFixed(2), n: X.length, read: beta < -3 ? 'rate-sensitive: falls when yields rise (long-duration)' : beta > 3 ? 'benefits when yields rise (banks, energy)' : 'little rate sensitivity' };
}

/** Risk rating 1–10 from volatility, drawdown and leverage — higher is riskier. Rules printed in the handbook. */
export function riskRating({ atrPct, maxDrawdownPct, beta, netDebtToEbitda, isOption = false, cls = 'stock' }) {
  let r = 1;
  if (atrPct != null) r += atrPct >= 6 ? 3 : atrPct >= 4 ? 2 : atrPct >= 2.5 ? 1 : 0;
  if (maxDrawdownPct != null) r += maxDrawdownPct <= -60 ? 3 : maxDrawdownPct <= -40 ? 2 : maxDrawdownPct <= -25 ? 1 : 0;
  if (beta != null) r += beta >= 1.5 ? 1 : 0;
  if (netDebtToEbitda != null) r += netDebtToEbitda >= 3 ? 2 : netDebtToEbitda >= 1.5 ? 1 : 0;
  if (cls === 'crypto') r += 2;
  if (isOption) r = 10;
  return Math.max(1, Math.min(10, r));
}

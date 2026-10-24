import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resample, multiTimeframeTrend, macd, bollinger, rsi, seasonality, dayOfWeek, maxDrawdown, windowReturn, worstRolling, liquidity, rateBeta, riskRating } from '../indicators.js';

// 6 years of weekday bars: a steady uptrend with a crash in March 2020
const bars = []; let c = 100, seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };          // deterministic noise
const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
for (let d = new Date(Date.UTC(2019, 0, 2)); d < new Date(Date.UTC(2025, 0, 1)); d.setUTCDate(d.getUTCDate() + 1)) {
  const w = d.getUTCDay(); if (w === 0 || w === 6) continue;
  const t = d.getTime();
  const crash = t >= Date.UTC(2020, 1, 20) && t <= Date.UTC(2020, 2, 23);
  c *= crash ? 0.985 : 1 + 0.0006 + 0.01 * gauss();
  bars.push({ t, o: c * 0.999, h: c * 1.01, l: c * 0.99, c, v: 1e6 });
}

test('resample keeps the first open, last close and the extreme high/low', () => {
  const w = resample(bars, 'week'), m = resample(bars, 'month');
  assert.ok(w.length > 300 && w.length < 320); assert.ok(m.length === 72);
  assert.equal(m[0].o, bars[0].o);
});
test('multi-timeframe trend reads an uptrend on all three', () => {
  const t = multiTimeframeTrend(bars);
  assert.equal(t.daily.label, 'uptrend'); assert.equal(t.weekly.label, 'uptrend'); assert.equal(t.monthly.label, 'uptrend');
  assert.ok(t.daily.ma100 > 0);
});
test('MACD, Bollinger and RSI return finite readings with sensible ranges', () => {
  const closes = bars.map((b) => b.c);
  const m = macd(closes); assert.ok(isFinite(m.macd) && typeof m.cross === 'string');
  const b = bollinger(closes); assert.ok(b.percentB > -0.5 && b.percentB < 1.5 && b.bandwidthPct > 0);
  const r = rsi(closes); assert.ok(r > 50 && r <= 100, `rsi ${r}`);
});
test('seasonality and day-of-week: synthetic data with no calendar effect finds none after Bonferroni', () => {
  const s = seasonality(bars); assert.equal(s.rows.length, 12); assert.ok(s.yearsCovered >= 5.9);
  assert.equal(s.anySignificant, false);
  const d = dayOfWeek(bars); assert.equal(d.rows.length, 5); assert.equal(d.anySignificant, false);
});
test('drawdown and stress windows catch the March 2020 crash', () => {
  const dd = maxDrawdown(bars); assert.ok(dd.maxDrawdownPct < -25 && dd.to.startsWith('2020'), JSON.stringify(dd));
  const covid = windowReturn(bars, '2020-02-19', '2020-03-23'); assert.ok(covid < -25, `${covid}`);
  const wr = worstRolling(bars, 60); assert.ok(wr.pct < -25 && wr.endedOn.startsWith('2020'), JSON.stringify(wr));
});
test('liquidity grades a position against 10% of average dollar volume', () => {
  const l = liquidity(bars, 50_000); assert.equal(l.rating, 'deep');
  const big = liquidity(bars, 200_000_000); assert.ok(['thin', 'illiquid'].includes(big.rating));
});
test('rate beta measures response to yield changes', () => {
  // build a yield series where the stock falls 2% per +1pt yield day
  const tnx = []; const stock = []; let y = 4, p = 100;
  for (let i = 0; i < 200; i++) { const t = Date.UTC(2024, 0, 1) + i * 864e5; const dy = (i % 2 ? 0.05 : -0.05); y += dy; p *= 1 - 0.02 * dy; tnx.push({ t, c: y }); stock.push({ t, c: p, v: 1 }); }
  const rb = rateBeta(stock, tnx); assert.ok(rb && Math.abs(rb.betaPerPoint + 2) < 0.2, JSON.stringify(rb));
});
test('risk rating is 1–10, options are always 10, crypto adds two', () => {
  assert.equal(riskRating({ atrPct: 1, maxDrawdownPct: -10 }), 1);
  assert.equal(riskRating({ atrPct: 7, maxDrawdownPct: -65, beta: 1.8, netDebtToEbitda: 4 }), 10);
  assert.equal(riskRating({ atrPct: 1, cls: 'crypto' }), 3);
  assert.equal(riskRating({ isOption: true }), 10);
});

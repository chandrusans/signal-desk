// Rule experiments on the ten-year replay: `npm run experiments`.
//
// Each idea is run over the whole window AND over each half on its own (2016–2020, 2021 to now).
// An idea only counts if it beats the current rules in both halves; a result that needs one lucky
// stretch, or one exact setting, is noise. Prints tables; writes nothing the app reads.
//
//   1. INDEX TIMING  hold SPY only while a signal is on, cash otherwise. Signals: the app's own market
//      gate, and plain moving-average rules for comparison. Decided on a close, acted on at the NEXT
//      close (one day late on purpose), 5 bps charged per switch, cash earns nothing.
//   2. STRICTER ENTRIES and 3. FEWER STRATEGIES  the stock rules with one or two things changed.

import fs from 'node:fs';
import path from 'node:path';
import { replayData, CACHE } from './replay-data.mjs';
import { simulate, gateSeries, indexTiming } from '../replay.js';

const data = await replayData({ from: '2016-01-01' });
const { days } = data;
const SPLIT = '2021-01-01';
const yearsBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / (365.25 * 864e5);
const cagr = (v0, v1, a, b) => (Math.pow(v1 / v0, 1 / Math.max(yearsBetween(a, b), 0.01)) - 1) * 100;
const maxDd = (xs) => { let pk = -Infinity, m = 0; for (const x of xs) { pk = Math.max(pk, x); m = Math.min(m, x / pk - 1); } return m * 100; };
const f = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}`);

// ── 1. Index timing ──────────────────────────────────────────────────────
const spyBars = JSON.parse(fs.readFileSync(path.join(CACHE, 'bars', 'SPY.json'), 'utf8')).bars;
const idx = new Map(spyBars.map((b, i) => [b.d, i]));
const adj = days.map((d) => spyBars[idx.get(d)].a), close = days.map((d) => spyBars[idx.get(d)].c);
const sma = (n) => days.map((d) => { const j = idx.get(d); if (j < n - 1) return NaN; let s = 0; for (let q = j - n + 1; q <= j; q++) s += spyBars[q].c; return s / n; });
const gates = gateSeries(data);
const above = (n) => { const m = sma(n); return days.map((_, k) => (close[k] > m[k] ? 1 : 0)); };
const SIGNALS = {
  'Buy and hold SPY': days.map(() => 1),
  "The app's gate: in when new longs are allowed": gates.map((g) => (g && g.allow.length ? 1 : 0)),
  "The app's gate, sized (100/50/25%)": gates.map((g) => (g && g.allow.length ? Math.min(1, g.sizeMult ?? 1) : 0)),
  'Gate without the VIX rule: index above 50-day and breadth 30%+': gates.map((g, k) => (close[k] > data.spy.ma50[k] && !(g?.breadth < 30) ? 1 : 0)),
  'SPY above its 50-day': above(50),
  'SPY above its 100-day': above(100),
  'SPY above its 150-day': above(150),
  'SPY above its 200-day': above(200),
  'VIX under 25': Array.from(data.vix, (v) => (v < 25 ? 1 : 0)),
};
function timing(signal, { lag = 1, costBps = 5, from = 0, to = days.length - 1 } = {}) {
  const r = indexTiming(adj, signal, { lag, costBps, from, to });
  return { final: r.final, cagr: cagr(1000, r.final, days[from], days[to]), dd: r.maxDdPct, inPct: r.inMarketPct, switches: r.switches };
}
const kSplit = days.findIndex((d) => d >= SPLIT);
console.log(`\n1. INDEX TIMING — $1,000 in SPY (dividends in), ${days[0]} → ${days.at(-1)}; decided on a close, acted on the next close, 5 bps a switch\n`);
console.log('signal'.padEnd(64), '$1,000→'.padStart(8), 'a year'.padStart(8), 'worst drop'.padStart(11), 'in market'.padStart(10), 'switches'.padStart(9), '| 2016–20'.padStart(10), '2021–now'.padStart(9), '| same-day'.padStart(11));
for (const [name, sig] of Object.entries(SIGNALS)) {
  const all = timing(sig), h1 = timing(sig, { to: kSplit }), h2 = timing(sig, { from: kSplit }), fast = timing(sig, { lag: 0 });
  console.log(name.padEnd(64), ('$' + Math.round(all.final).toLocaleString()).padStart(8), (f(all.cagr) + '%').padStart(8), (all.dd.toFixed(0) + '%').padStart(11), (all.inPct.toFixed(0) + '%').padStart(10), String(all.switches).padStart(9), ('| ' + f(h1.cagr) + '%').padStart(10), (f(h2.cagr) + '%').padStart(9), ('| ' + f(fast.cagr) + '%').padStart(11));
}

// ── 2 and 3. The stock rules, changed ────────────────────────────────────
const STOCK = [
  ['Current rules (base)', {}],
  ['Score bars +10 (75 / 70)', { minScore: { breakout: 75, pullback: 70 } }],
  ['Score bars +20 (85 / 80)', { minScore: { breakout: 85, pullback: 80 } }],
  ['Score bars +25 (90 / 85)', { minScore: { breakout: 90, pullback: 85 } }],
  ['Time stop 20 sessions', { timeStop: 20 }],
  ['Time stop 25 sessions', { timeStop: 25 }],
  ['Score +10 and time stop 20', { minScore: { breakout: 75, pullback: 70 }, timeStop: 20 }],
  ['Score +20 and time stop 20', { minScore: { breakout: 85, pullback: 80 }, timeStop: 20 }],
  ['Pullbacks only', { strategies: ['pullback'] }],
  ['Pullbacks only, score 70+', { strategies: ['pullback'], minScore: { pullback: 70 } }],
  ['Pullbacks only, score 70+, time stop 20', { strategies: ['pullback'], minScore: { pullback: 70 }, timeStop: 20 }],
  ['Pullbacks only, score 80+, time stop 20', { strategies: ['pullback'], minScore: { pullback: 80 }, timeStop: 20 }],
  ['Breakouts + pullbacks (no mean reversion)', { strategies: ['breakout', 'pullback'] }],
  ['Breakouts + pullbacks, score +10, time stop 20', { strategies: ['breakout', 'pullback'], minScore: { breakout: 75, pullback: 70 }, timeStop: 20 }],
];
console.log(`\n2–3. THE STOCK RULES, CHANGED — $1,000 account, every gate on, point-in-time S&P 500\n`);
console.log('rules'.padEnd(50), '$1,000→'.padStart(8), 'a year'.padStart(8), 'worst drop'.padStart(11), 'trades'.padStart(7), 'avg R'.padStart(8), '| 2016–20'.padStart(10), 'avg R'.padStart(7), '2021–now'.padStart(9), 'avg R'.padStart(7), ' verdict');
let base = null;
for (const [name, o] of STOCK) {
  const all = simulate(data, o).metrics, h1 = simulate(data, { ...o, to: '2020-12-31' }).metrics, h2 = simulate(data, { ...o, from: SPLIT }).metrics;
  if (!base) base = { all, h1, h2 };
  const better = all.cagrPct > base.all.cagrPct && h1.cagrPct > base.h1.cagrPct && h2.cagrPct > base.h2.cagrPct;
  const verdict = name.includes('base') ? '' : better ? (h1.cagrPct > 0 && h2.cagrPct > 0 ? 'better in both halves' : 'better, but one half still loses') : 'not better in both halves';
  console.log(name.padEnd(50), ('$' + Math.round(all.final).toLocaleString()).padStart(8), (f(all.cagrPct) + '%').padStart(8), (all.maxDdPct.toFixed(0) + '%').padStart(11), String(all.trades).padStart(7), (f(all.expectancyR, 3) + 'R').padStart(8),
    ('| ' + f(h1.cagrPct) + '%').padStart(10), f(h1.expectancyR, 2).padStart(7), (f(h2.cagrPct) + '%').padStart(9), f(h2.expectancyR, 2).padStart(7), ' ' + verdict);
}
console.log(`\nFor scale: SPY held throughout made ${f(base.all.spyCagrPct)}% a year (${f(base.h1.spyCagrPct)}% in 2016–20, ${f(base.h2.spyCagrPct)}% since) with a worst drop of ${base.all.spyMaxDdPct.toFixed(0)}%.\n`);

// Ten-year replay of the Swing rules: `npm run replay` (add --refresh to refetch everything).
//
// Runs the base case (point-in-time S&P 500, every live gate, $1,000 cash account, fractional
// shares, next-open fills, 7 bps a side), then the same thing with one assumption changed at a
// time, and writes the aggregate results to data/replay.json for the Swing tab. No bars are
// written to the repo; the cache lives in .cache/replay/ (gitignored).
//
// Needs NODE_EXTRA_CA_CERTS on this Mac (see tools/validate.sh). About two minutes cold,
// twenty seconds warm.

import fs from 'node:fs';
import path from 'node:path';
import { replayData } from './replay-data.mjs';
import { simulate } from '../replay.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const refresh = process.argv.includes('--refresh');
const FROM = '2016-01-01';
const data = await replayData({ from: FROM, refresh });

const VARIANTS = [
  { id: 'base', group: 'base', label: 'As the app runs today' },
  { id: 'survivors', group: 'bias', label: 'Only today\'s S&P 500 members, for all ten years', o: { universe: 'today' } },
  { id: 'nogate', group: 'gates', label: 'Market gate off (VIX, breadth, S&P 500 trend)', o: { gates: false } },
  { id: 'noearn', group: 'gates', label: 'Earnings gate off', o: { earningsGate: false } },
  { id: 'breakout', group: 'strategy', label: 'Breakouts only', o: { strategies: ['breakout'] } },
  { id: 'pullback', group: 'strategy', label: 'Pullbacks only', o: { strategies: ['pullback'] } },
  { id: 'meanrev', group: 'strategy', label: 'Mean reversion only', o: { strategies: ['meanrev'] } },
  { id: 'score-up', group: 'sensitivity', label: 'Score bars 10 points stricter (75 / 70)', o: { minScore: { breakout: 75, pullback: 70 } } },
  { id: 'score-down', group: 'sensitivity', label: 'Score bars 10 points looser (55 / 50)', o: { minScore: { breakout: 55, pullback: 50 } } },
  { id: 'stop-1', group: 'sensitivity', label: 'Stop at 1 ATR instead of 1.5', o: { stopAtr: 1 } },
  { id: 'stop-2', group: 'sensitivity', label: 'Stop at 2 ATR instead of 1.5', o: { stopAtr: 2 } },
  { id: 'tgt-2', group: 'sensitivity', label: 'Target 2R instead of 2.5R', o: { targetR: 2 } },
  { id: 'tgt-3', group: 'sensitivity', label: 'Target 3R instead of 2.5R', o: { targetR: 3 } },
  { id: 'time-10', group: 'sensitivity', label: 'Time stop 10 sessions', o: { timeStop: 10 } },
  { id: 'time-20', group: 'sensitivity', label: 'Time stop 20 sessions', o: { timeStop: 20 } },
  { id: 'at-close', group: 'execution', label: 'Fill at the signal day\'s close, not the next open', o: { exec: 'close' } },
  { id: 'cost-20', group: 'execution', label: 'Costs 20 bps a side instead of 7', o: { costBps: 20 } },
  { id: 'whole', group: 'execution', label: 'Whole shares only, $1,000', o: { fractional: false } },
  { id: 'risk-05', group: 'execution', label: 'Risk 0.5% a trade', o: { riskPct: 0.5 } },
  { id: 'risk-2', group: 'execution', label: 'Risk 2% a trade', o: { riskPct: 2 } },
  { id: 'cap-10k', group: 'execution', label: '$10,000 account', o: { capital: 10000 } },
  { id: 'h1', group: 'period', label: 'First half: 2016–2020 only', o: { to: '2020-12-31' } },
  { id: 'h2', group: 'period', label: 'Second half: 2021 to now only', o: { from: '2021-01-01' } },
];

const pick = (m) => m && {
  from: m.from, to: m.to, years: m.years, capital: m.capital, final: m.final, returnPct: m.returnPct, cagrPct: m.cagrPct, maxDdPct: m.maxDdPct,
  spyReturnPct: m.spyReturnPct, spyCagrPct: m.spyCagrPct, spyMaxDdPct: m.spyMaxDdPct, trades: m.trades, winRate: m.winRate, expectancyR: m.expectancyR,
  profitFactor: m.profitFactor, avgSessions: m.avgSessions, gapStops: m.gapStops, exposurePct: m.exposurePct, byStrategy: m.byStrategy,
};

const results = [];
let base = null;
for (const v of VARIANTS) {
  const t0 = Date.now();
  const r = simulate(data, v.o || {});
  if (v.id === 'base') base = r;
  results.push({ id: v.id, group: v.group, label: v.label, ...pick(r.metrics) });
  console.error(`${v.id.padEnd(11)} ${String(r.metrics.returnPct).padStart(7)}%  CAGR ${String(r.metrics.cagrPct).padStart(6)}%  vs SPY ${r.metrics.spyCagrPct}%  ${String(r.metrics.trades).padStart(5)} trades  ${r.metrics.expectancyR}R  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// Weekly equity curve of the base case against SPY bought with the same $1,000.
const m = base.metrics, spyA = data.spy.a, k0 = data.days.indexOf(m.from);
const curve = base.curve.filter((c, i) => i % 5 === 0 || i === base.curve.length - 1)
  .map((c) => ({ d: c.d, eq: Math.round(c.eq * 100) / 100, spy: Math.round((m.capital * spyA[data.days.indexOf(c.d)] / spyA[k0]) * 100) / 100 }));

const cov = data.coverage;
let memberDays = 0; for (const t of Object.values(data.tickers)) memberDays += t.member.reduce((s, x) => s + x, 0);
const missingDays = cov.missing.reduce((s, x) => s + x.memberDays, 0);
const exitRules = {};
for (const t of base.trades) exitRules[t.rule] = (exitRules[t.rule] || 0) + 1;
const signs = results.filter((r) => ['sensitivity', 'execution', 'period'].includes(r.group));
const out = {
  builtAt: new Date().toISOString(),
  window: { from: m.from, to: m.to, years: m.years, sessions: base.curve.length },
  assumptions: {
    account: '$1,000 cash account, fractional shares, compounding; 1% of equity risked a trade; at most 6 positions, 5% open risk, 3% daily loss, 25% in one name (risk.js limits).',
    fills: 'Decided on each close, filled at the next session\'s open, 7 bps a side. Stops trigger intraday; an open below the stop fills at the open.',
    entries: 'signalFor() on the row /api/scan would have built that evening: breakout (score 65+), pullback (60+), mean reversion (2-day RSI under 10 above the 200-day). Ranked by score, then relative strength.',
    exits: 'positionVerdict(): stop, regime cuts, earnings exit, broken trend, time stop; half off at the target or a trim rule, the rest trailed under the 20-day average.',
    gates: 'VIX regime with breadth (share of the day\'s members above their 50-day), S&P 500 above its 50-day, 5-day earnings gate from SEC 8-K item 2.02 filing dates.',
    notReplayed: [
      'The macro-calendar gate (no free history of the release calendar). Live, it skips more entry days than the replay does.',
      'Post-earnings drift (needs historical consensus estimates). It is half-sized and untested live.',
      'Conviction grade (needs historical filings scores). Candidates are ranked by score instead.',
    ],
  },
  coverage: {
    namesEverInIndex: cov.names, withPrices: cov.withBars, withoutPrices: cov.missing.length,
    missingMemberDaysPct: +((missingDays / (memberDays + missingDays)) * 100).toFixed(1),
    withEarningsDates: cov.earningsKnown,
    missing: cov.missing.sort((a, b) => b.memberDays - a.memberDays).slice(0, 60).map((x) => ({ t: x.t, name: x.name, memberDays: x.memberDays })),
    unreconciledChanges: data.unmatched.length,
  },
  base: { ...pick(m), byYear: m.byYear, stats: base.stats, exitRules, open: base.open },
  variants: results.filter((r) => r.id !== 'base'),
  robustness: {
    checked: signs.length,
    positive: signs.filter((r) => r.expectancyR > 0).length,
    beatSpy: results.filter((r) => r.cagrPct > r.spyCagrPct).length,
  },
  curve,
};
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'replay.json'), JSON.stringify(out));
console.error(`wrote data/replay.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);

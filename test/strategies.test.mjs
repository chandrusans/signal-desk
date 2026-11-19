import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, signalFor, gradeFor, sizePosition, accountTrades, applySpyTrend } from '../strategies.js';
import { regime } from '../analyze.js';
import { positionVerdict } from '../exits.js';
import { closeTrade, journalStats } from '../risk.js';
import { runBacktest } from '../backtest.js';

const NORMAL = regime(17);                       // allows BREAKOUT and PULLBACK at full size
const row = (o = {}) => ({ t: 'TEST', p: 100, sc: 80, su: 'BREAKOUT', rs: 8, r20: 9, a50: true, a200: true, rsi2: 60, ma5: 99, stop: 95, tgt: 112.5, ...o });
const far = { date: '2027-03-01', daysAway: 60 };
const ctx = (o = {}) => ({ regime: NORMAL, macroLevel: 'clear', nextEarnings: far, today: '2026-11-18', ...o });

test('breakout and pullback fire on setup + score, and carry the card plan', () => {
  const b = signalFor(row(), ctx());
  assert.equal(b.action, 'BUY'); assert.equal(b.strategy, 'breakout');
  assert.equal(b.stop, 95); assert.equal(b.target, 112.5); assert.equal(b.timeStopDays, 15); assert.equal(b.sizeMult, 1);
  const p = signalFor(row({ su: 'PULLBACK', sc: 62 }), ctx());
  assert.equal(p.strategy, 'pullback');
  assert.equal(signalFor(row({ sc: 60 }), ctx()).action, 'WAIT', 'a breakout under score 65 is not an entry');
  assert.equal(signalFor(row({ su: 'BROKEN' , rsi2: 50}), ctx()).action, 'AVOID');
  assert.equal(signalFor(row({ su: 'EXTENDED' }), ctx()).action, 'WAIT');
});

test('gates override the chart: macro, earnings inside 5 days, regime, index below its 50-day', () => {
  assert.equal(signalFor(row(), ctx({ macroLevel: 'blocked' })).action, 'WAIT');
  const e = signalFor(row(), ctx({ nextEarnings: { date: '2026-11-20', daysAway: 2 } }));
  assert.equal(e.action, 'AVOID'); assert.match(e.reason, /Earnings in 2 days/);
  assert.equal(signalFor(row(), ctx({ regime: regime(28) })).action, 'WAIT', 'stress regime: no new longs');
  assert.equal(signalFor(row(), ctx({ regime: regime(22) })).action, 'WAIT', 'elevated regime: breakouts are not allowed');
  const half = signalFor(row({ su: 'PULLBACK', sc: 70 }), ctx({ regime: regime(22) }));
  assert.equal(half.action, 'BUY'); assert.equal(half.sizeMult, 0.5, 'elevated regime halves the size');
  const down = applySpyTrend(NORMAL, false);
  assert.deepEqual(down.allow, []); assert.equal(signalFor(row(), ctx({ regime: down })).action, 'WAIT');
  assert.equal(applySpyTrend(NORMAL, null), NORMAL, 'unknown index trend leaves the regime alone');
});

test('mean reversion: RSI-2 under 10 above the 200-day, no target, 7-session clock', () => {
  const m = signalFor(row({ su: 'EARLY', sc: 40, rsi2: 6 }), ctx());
  assert.equal(m.action, 'BUY'); assert.equal(m.strategy, 'meanrev'); assert.equal(m.target, null); assert.equal(m.timeStopDays, 7);
  assert.equal(signalFor(row({ su: 'EARLY', rsi2: 6, a200: false }), ctx()).action, 'WAIT', 'below the 200-day it is not a dip, it is a downtrend');
  assert.equal(signalFor(row({ su: 'EARLY', rsi2: 6 }), ctx({ regime: regime(28) })).action, 'WAIT');
});

test('post-earnings drift: beat of 5%+, 2 to 10 sessions ago, half size, flagged untested', () => {
  const le = { dateReported: '2026-11-11', surprisePct: 12 };          // 5 sessions before 2026-11-18
  const s = signalFor(row({ su: 'EARLY', sc: 55 }), ctx({ lastEarnings: le }));
  assert.equal(s.strategy, 'pead'); assert.equal(s.sizeMult, 0.5); assert.equal(s.timeStopDays, 20);
  assert.ok(s.caveats.some((c) => /not backtested/.test(c)));
  assert.equal(signalFor(row({ su: 'EARLY' }), ctx({ lastEarnings: { dateReported: '2026-11-17', surprisePct: 12 } })).action, 'WAIT', 'too fresh');
  assert.equal(signalFor(row({ su: 'EARLY' }), ctx({ lastEarnings: { dateReported: '2026-10-01', surprisePct: 12 } })).action, 'WAIT', 'too old');
  assert.equal(signalFor(row({ su: 'EARLY' }), ctx({ lastEarnings: { dateReported: '2026-11-11', surprisePct: 2 } })).action, 'WAIT', 'not a clear beat');
  assert.equal(signalFor(row(), ctx({ lastEarnings: le })).strategy, 'breakout', 'a tested strategy outranks the untested one');
});

test('caveats: unknown earnings date, and a report inside the holding window', () => {
  assert.ok(signalFor(row(), ctx({ nextEarnings: null })).caveats.some((c) => /no next-earnings date/.test(c)));
  assert.ok(signalFor(row(), ctx({ nextEarnings: { date: '2026-11-30', daysAway: 12 } })).caveats.some((c) => /inside the 15-session holding window/.test(c)));
  assert.equal(signalFor(row(), ctx()).caveats.length, 0);
});

test('grade counts five printed checks', () => {
  const s = signalFor(row(), ctx());
  const a = gradeFor(row(), s, { cash: 'REAL', risk: 3 }, ctx());
  assert.equal(a.points, 5); assert.equal(a.grade, 'A');
  const c = gradeFor(row({ rs: 1 }), signalFor(row({ stop: 91 }), ctx()), { cash: 'WATCH', risk: 7 }, ctx({ nextEarnings: null }));
  assert.equal(c.grade, 'C'); assert.equal(c.checks.length, 5);
});

test('sizing a $500 account: fractional shares, the 25% name cap, the cash cap, whole shares', () => {
  const s = sizePosition({ capital: 500, riskPct: 1, entry: 34.43, stop: 32.71 });         // $5 risk / $1.72 = 2.906 sh
  assert.equal(s.qty, 2.906); assert.equal(s.cappedBy, 'risk'); assert.ok(s.risk <= 5.0001 && s.risk > 4.99); assert.ok(s.feasible);
  const whole = sizePosition({ capital: 500, riskPct: 1, entry: 422.07, stop: 398.33, fractional: false });
  assert.equal(whole.qty, 0); assert.equal(whole.feasible, false); assert.equal(whole.capitalForOneShare, 2374);
  const frac = sizePosition({ capital: 500, riskPct: 1, entry: 422.07, stop: 398.33 });
  assert.equal(frac.qty, 0.21); assert.ok(frac.feasible);
  const tight = sizePosition({ capital: 500, riskPct: 1, entry: 100, stop: 98 });          // $5/$2 = 2.5 sh = $250 → capped at 25% = $125
  assert.equal(tight.cappedBy, 'concentration'); assert.equal(tight.qty, 1.25);
  const broke = sizePosition({ capital: 500, cash: 40, riskPct: 1, entry: 34.43, stop: 32.71 });
  assert.equal(broke.cappedBy, 'cash'); assert.ok(broke.notional <= 40);
  assert.equal(sizePosition({ capital: 500, entry: 10, stop: 11 }), null, 'a stop above entry is not a long');
});

test('accountTrades: same trades, different account, whole shares skip what $500 cannot afford', () => {
  const T = [
    { entry: 400, exit: 450, R: 20, rMultiple: 2.5, exitDate: 2 },     // $5 risk / $20 = 0.25 sh
    { entry: 30, exit: 28.5, R: 1.5, rMultiple: -1, exitDate: 3 },      // 3.33 sh
  ];
  const f = accountTrades(T, { capital: 500, fractional: true });
  assert.equal(f.taken, 2); assert.ok(f.final > 500);
  const w = accountTrades(T, { capital: 500, fractional: false });
  assert.equal(w.skipped, 1); assert.equal(w.taken, 1); assert.ok(w.final < 500, 'whole shares miss the winner and keep the loser');
});

test('exit rulebook: a mean-reversion position sells above its 5-day average and on its short clock', () => {
  const pos = { id: 'x', ticker: 'TEST', qty: 1, buyPrice: 100, buyDate: '2026-11-10', stop: 95, planStop: 95, initialStop: 95, timeStopDays: 7, strategy: 'meanrev', book: 'swing', assetClass: 'stock' };
  const an = (ma5) => ({ setup: 'EARLY', indicators: { ma5, rsi14: 50 } });
  const v = positionVerdict(pos, { price: 102, analysis: an(101) });
  assert.equal(v.action, 'SELL'); assert.equal(v.rule, 'meanrev_exit');
  assert.notEqual(positionVerdict({ ...pos, buyDate: new Date().toISOString().slice(0, 10) }, { price: 99, analysis: an(101) }).rule, 'meanrev_exit', 'still below the 5-day: no exit');
  const old = positionVerdict({ ...pos, buyDate: '2026-10-01' }, { price: 99, analysis: an(101) });
  assert.equal(old.rule, 'time_stop');
  // the same price action on a breakout position is not a sell
  assert.notEqual(positionVerdict({ ...pos, strategy: 'breakout', timeStopDays: 15, buyDate: new Date().toISOString().slice(0, 10) }, { price: 102, analysis: an(101) }).rule, 'meanrev_exit');
  // under the 50-day is the dip it was bought for: not a "broken trend" sell (a breakout in the same spot is)
  const broken = { setup: 'BROKEN', indicators: { ma5: 101, rsi14: 30 } };
  assert.equal(positionVerdict(pos, { price: 98, analysis: broken, today: '2026-11-13' }).action, 'HOLD');
  assert.equal(positionVerdict({ ...pos, strategy: 'breakout', timeStopDays: 15 }, { price: 98, analysis: broken, today: '2026-11-13' }).rule, 'broken');
});

test('exit rulebook: ctx.today replays the clock as of that day', () => {
  const pos = { id: 'y', ticker: 'TEST', qty: 1, buyPrice: 100, buyDate: '2020-03-02', stop: 95, initialStop: 95, timeStopDays: 15, assetClass: 'stock' };
  assert.equal(positionVerdict(pos, { price: 100.5, today: '2020-03-23' }).rule, 'time_stop');
  assert.equal(positionVerdict(pos, { price: 100.5, today: '2020-03-05' }).sessionsHeld, 3);
});

test('exit rulebook: the swing book sells a non-winner two days before earnings; other books only warn', () => {
  const today = new Date().toISOString().slice(0, 10);
  const pos = { id: 'y', ticker: 'TEST', qty: 1, buyPrice: 100, buyDate: today, stop: 95, planStop: 95, initialStop: 95, strategy: 'breakout', book: 'swing', assetClass: 'stock' };
  const e = { date: '2026-11-20', daysAway: 2 };
  assert.equal(positionVerdict(pos, { price: 101, earnings: e }).rule, 'earnings_exit');
  assert.equal(positionVerdict({ ...pos, book: undefined }, { price: 101, earnings: e }).rule, 'earnings_soon');
  assert.equal(positionVerdict(pos, { price: 107, earnings: e }).action, 'TRIM', 'a +1R winner is trimmed, not dumped');
});

test('journal splits results by strategy', () => {
  const mk = (strategy, exit) => closeTrade({ id: strategy, ticker: 'T', qty: 1, buyPrice: 100, buyDate: '2026-11-01', stop: 95, strategy, book: 'swing' }, { exitPrice: exit, exitDate: '2026-11-10' });
  const s = journalStats([mk('breakout', 110), mk('breakout', 95), mk('meanrev', 103)]);
  assert.equal(s.byStrategy.breakout.n, 2); assert.equal(s.byStrategy.breakout.expectancyR, 0.5);
  assert.equal(s.byStrategy.meanrev.expectancyR, 0.6); assert.equal(mk('pead', 100).book, 'swing');
});

test('backtest: breakout and pullback run alone, and mean reversion uses its own exit', () => {
  // 320 bars: a steady uptrend with a sharp three-day dip every 40 bars
  const bars = []; let c = 50;
  for (let i = 0; i < 320; i++) { const dip = i > 210 && i % 40 < 3; c *= dip ? 0.965 : 1.004; bars.push({ t: Date.UTC(2025, 0, 1) + i * 86400000, o: c * 0.999, h: c * 1.006, l: c * 0.994, c, v: 1e6 * (dip ? 2 : 1) }); }
  const mr = runBacktest({ T: bars }, { strategy: 'mean-reversion', mrExit: true, timeStopDays: 7 });
  assert.ok(mr.trades.length >= 1, 'dips in an uptrend produce mean-reversion entries');
  assert.ok(mr.trades.every((t) => ['ma5_exit', 'stop', 'gap_through_stop', 'time_stop'].includes(t.reason)), 'no 2.5R target exits');
  assert.ok(mr.trades.some((t) => t.reason === 'ma5_exit'));
  for (const s of ['breakout', 'pullback']) { const r = runBacktest({ T: bars }, { strategy: s }); assert.ok(r.trades.every((t) => t.setup === s.toUpperCase())); }
  assert.equal(Object.keys(STRATEGIES).length, 4);
});

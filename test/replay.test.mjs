import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, nextEarningsFrom, SETUPS } from '../replay.js';

const COLS = ['o', 'h', 'l', 'c', 'sc', 'su', 'rs', 'r20', 'a50', 'a200', 'rsi2', 'ma5', 'ma20', 'rsi14', 'slope', 'atr', 'stop', 'tgt'];
const day = (k) => new Date(Date.UTC(2020, 0, 6) + Math.floor(k / 5) * 7 * 864e5 + (k % 5) * 864e5).toISOString().slice(0, 10);   // weekdays only

/** One ticker, flat at $100 with a quiet uptrend read, plus whatever the test paints on top. */
function world(n = 60, paint = () => {}) {
  const days = Array.from({ length: n }, (_, k) => day(k));
  const cols = Object.fromEntries(COLS.map((c) => [c, new Float32Array(n).fill(NaN)]));
  for (let k = 0; k < n; k++) {
    Object.assign(cols, {});
    cols.o[k] = 100; cols.h[k] = 100.5; cols.l[k] = 99.5; cols.c[k] = 100;
    cols.sc[k] = 50; cols.su[k] = SETUPS.indexOf('EARLY'); cols.rs[k] = 2; cols.r20[k] = 3; cols.a50[k] = 1; cols.a200[k] = 1;
    cols.rsi2[k] = 50; cols.ma5[k] = 99; cols.ma20[k] = 97; cols.rsi14[k] = 55; cols.slope[k] = 0.002; cols.atr[k] = 2; cols.stop[k] = 95; cols.tgt[k] = 112.5;
  }
  const member = new Uint8Array(n).fill(1);
  const t = { cols, member };
  const set = (k, o) => { for (const [f, v] of Object.entries(o)) cols[f][k] = f === 'su' ? SETUPS.indexOf(v) : v; };
  paint(set, member);
  return {
    days, tickers: { KMI: t }, earnings: { KMI: ['2030-01-01'] },
    spy: { c: new Float32Array(n).fill(400), a: new Float64Array(n).fill(400), ma50: new Float32Array(n).fill(390) },
    vix: new Float32Array(n).fill(16),
  };
}
const breakoutOn = (k) => (set) => set(k, { su: 'BREAKOUT', sc: 80 });
const run = (w, o = {}) => simulate(w, { gates: false, ...o });

test('a breakout on day 5 fills at day 6 open plus costs, sized at 1% risk and capped at 25% of the account', () => {
  const r = run(world(30, (set) => { breakoutOn(5)(set); set(9, { l: 94 }); }));
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryDate, day(6)); assert.equal(t.exitRule, 'stop'); assert.equal(t.exitDate, day(9));
  assert.ok(Math.abs(t.entry - 100.07) < 1e-3, 'next open + 7 bps');
  assert.equal(t.qty, 1.972, '$10 of risk / $5.07 a share, floored to 0.001; $197 is under the 25% name cap');
  assert.ok(t.rMultiple < -0.99 && t.rMultiple > -1.05);
});

test('an open below the stop fills at the open — a worse-than-1R loss, flagged as a gap', () => {
  const r = run(world(30, (set) => { breakoutOn(5)(set); set(9, { o: 90, l: 89, c: 91 }); }));
  const t = r.trades[0];
  assert.equal(t.gapped, true); assert.ok(t.rMultiple < -1.9);
  assert.equal(r.metrics.gapStops, 1);
});

test('the target sells half; the rest trails and leaves on its own rule', () => {
  const r = run(world(40, (set) => { breakoutOn(5)(set); set(10, { h: 113, c: 112 }); for (let k = 11; k < 40; k++) set(k, { c: 112, o: 112, h: 112.5, l: 111.5, ma20: 105 }); set(20, { l: 104 }); }));
  const t = r.trades[0];
  assert.equal(t.trimmed, true); assert.match(t.rule, /^target\+stop$/);
  assert.ok(t.rMultiple > 1.5, `half at 2.5R, half stopped at the 20-day trail: ${t.rMultiple}`);
});

test('no entry inside five days of earnings, and the reason is counted', () => {
  const w = world(30, breakoutOn(5)); w.earnings.KMI = [day(8)];
  const r = run(w);
  assert.equal(r.trades.length + r.open.length, 0);
  assert.equal(r.stats.heldByEarnings, 1);
  const off = run(w, { earningsGate: false }); assert.equal(off.trades.length + off.open.length, 1, 'gate off: it buys');
});

test('the market gate holds entries when the S&P 500 is under its 50-day', () => {
  const w = world(30, breakoutOn(5)); w.spy.c.fill(380);
  const r = simulate(w, { gates: true });
  assert.equal(r.trades.length + r.open.length, 0);
  assert.equal(r.stats.heldByGate, 1);
});

test('point in time: no entry on a day the stock was not in the index; "today" universe ignores that', () => {
  const w = world(30, (set, member) => { breakoutOn(5)(set); member.fill(0, 0, 10); });
  const n = (r) => r.trades.length + r.open.length;
  assert.equal(n(run(w)), 0);
  assert.equal(n(run(w, { universe: 'today' })), 1);
});

test('mean reversion: 2-day RSI under 10 above the 200-day, out on the first close above the 5-day', () => {
  const r = run(world(30, (set) => { set(5, { rsi2: 5, c: 97 }); set(6, { o: 97, c: 98, ma5: 99 }); set(7, { c: 100, ma5: 99 }); }));
  const t = r.trades[0];
  assert.equal(t.strategy, 'meanrev'); assert.equal(t.exitRule, 'meanrev_exit'); assert.equal(t.exitDate, day(8), 'decided on day 7 close, filled day 8 open');
});

test('metrics compare with SPY held over the same days', () => {
  const w = world(30); w.spy.a = Float64Array.from({ length: 30 }, (_, k) => 400 + k);
  const m = run(w).metrics;
  assert.equal(m.returnPct, 0); assert.equal(m.trades, 0);
  assert.equal(m.spyReturnPct, +((429 / 400 - 1) * 100).toFixed(1));
});

test('nextEarningsFrom returns the first filing on or after the day, or null with no record', () => {
  assert.deepEqual(nextEarningsFrom(['2020-01-10', '2020-04-10'], '2020-01-11'), { date: '2020-04-10', daysAway: 90 });
  assert.equal(nextEarningsFrom([], '2020-01-01'), null);
  assert.equal(nextEarningsFrom(['2019-01-01'], '2020-01-01'), null);
});

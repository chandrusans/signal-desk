import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankScreen, pickReasons, pickLevels, moatWord, PROFILES } from '../screen.js';

const row = (t, o = {}) => ({ t, name: t, sector: 'Information Technology', price: 100, score: 60, setup: 'PULLBACK', rs: 2, atrPct: 2, entry: 100, stop: 95, target: 112.5, pe: 20, revCagr: 10, epsCagr: 12, gm: 50, om: 25, roic: 20, de: 0.5, ndEbitda: 0.5, fcfYield: 4, premium: 0, fairLow: 90, fairHigh: 130, divFcfPct: 30, cash: 'REAL', moat: 7, credibility: 8, maxDd: -30, risk: 3, yieldPct: 1.5, ...o });
const U = [
  row('QUAL', { roic: 40, gm: 70, moat: 10, cash: 'REAL', fcfYield: 3 }),
  row('CHEAP', { pe: 10, fcfYield: 9, premium: -30, score: 50, rs: -1 }),
  row('GROW', { revCagr: 40, epsCagr: 50, pe: 45, fcfYield: 1, risk: 6, maxDd: -55, setup: 'BREAKOUT', score: 85, rs: 9 }),
  row('RISKY', { risk: 9, maxDd: -80, atrPct: 7, cash: 'MANUFACTURED?', moat: 2 }),
  row('EARN', { setup: 'EARNINGS' }),
  row('BROKE', { setup: 'BROKEN', score: 20, rs: -8 }),
  row('BANK', { sector: 'Financials', gm: null, roic: null, moat: null, cash: 'N/A', pe: 12 }),
];

test('profiles exclude what they should: risk cap, manufactured profits, earnings and broken setups', () => {
  const c = rankScreen(U, { tolerance: 'conservative' });
  const names = c.picks.map((p) => p.t);
  assert.ok(!names.includes('RISKY') && !names.includes('EARN') && !names.includes('BROKE'), names.join(','));
  assert.ok(c.excluded.some(([t, why]) => t === 'RISKY' && /risk/.test(why)));
  const a = rankScreen(U, { tolerance: 'aggressive' });
  assert.ok(a.picks.map((p) => p.t).includes('RISKY'), 'aggressive keeps high-risk names');
});
test('weights follow the profile and horizon, and sum to one', () => {
  for (const tol of Object.keys(PROFILES)) for (const h of ['swing', 'months', 'years']) {
    const w = rankScreen(U, { tolerance: tol, horizon: h }).weights;
    assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
  assert.ok(rankScreen(U, { tolerance: 'balanced', horizon: 'swing' }).weights.momentum > rankScreen(U, { tolerance: 'balanced', horizon: 'years' }).weights.momentum);
});
test('conservative ranks quality ahead of growth; aggressive does the reverse', () => {
  const c = rankScreen(U, { tolerance: 'conservative' }).picks.map((p) => p.t);
  const a = rankScreen(U, { tolerance: 'aggressive' }).picks.map((p) => p.t);
  assert.equal(c[0], 'QUAL', `conservative ${c}`);                       // GROW (risk 6) is filtered out entirely for this profile
  assert.ok(a.indexOf('GROW') < a.indexOf('QUAL'), `aggressive ${a}`);
});
test('sector filter, yield floor and sector-relative P/E', () => {
  const r = rankScreen(U, { tolerance: 'balanced', sectors: ['Financials'] });
  assert.deepEqual(r.picks.map((p) => p.t), ['BANK']);
  const y = rankScreen(U, { tolerance: 'balanced', minYieldPct: 2 });
  assert.equal(y.picks.length, 0);
  const b = rankScreen(U, { tolerance: 'balanced' }).picks.find((p) => p.t === 'CHEAP');
  assert.ok(b.peRel < 1, `CHEAP P/E relative ${b.peRel}`);
});
test('reasons and levels are built from the row\'s own numbers', () => {
  const p = rankScreen(U, { tolerance: 'balanced' }).picks.find((x) => x.t === 'QUAL');
  const rs = pickReasons(p);
  assert.ok(rs.some((x) => /ROIC 40%/.test(x)) && rs.some((x) => /strong moat/.test(x)) && rs.some((x) => /D\/E 0.50/.test(x)));
  const lv = pickLevels(p);
  assert.ok(lv.entryLow < 100 && lv.entryHigh > 100 && lv.stop === 95 && lv.bull12m === 130 && lv.bear12m === 90);
  assert.equal(moatWord(8), 'strong'); assert.equal(moatWord(5), 'moderate'); assert.equal(moatWord(2), 'weak');
});

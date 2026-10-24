import { test } from 'node:test';
import assert from 'node:assert/strict';
import { riskBudget, journalStats, closeTrade, LIMITS, todayISO } from '../risk.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('limits are the documented ones', () => {
  assert.deepEqual(LIMITS, { riskPerTradePct: 1, dailyLossPct: 3, maxOpenRiskPct: 5, maxPositions: 6, maxSingleNamePct: 25 });
});
test('closeTrade: R from the initial stop even after trailing; options multiply by 100', () => {
  const t = closeTrade({ id: 'a', ticker: 'NVDA', qty: 10, buyPrice: 100, buyDate: '2026-01-05', planStop: 95, stop: 100 }, { exitPrice: 104, exitDate: '2026-01-20' });
  assert.equal(t.r, 0.8); assert.equal(t.pl, 40);
  const o = closeTrade({ id: 'o', ticker: 'X', qty: 2, buyPrice: 6.85, buyDate: '2026-01-05', isOption: true, multiplier: 100 }, { exitPrice: 3.4, exitDate: '2026-01-10' });
  assert.equal(o.pl, -690);
});
test('journalStats: expectancy, profit factor by sign, nulls on empty', () => {
  const s = journalStats([{ r: 2, pl: 100 }, { r: -1, pl: -50 }, { r: 2.5, pl: 125 }, { r: 0, pl: 0 }]);
  assert.equal(s.n, 4); assert.equal(s.winRate, 50); assert.equal(s.expectancyR, 0.88); assert.equal(s.profitFactor, 4.5);
  assert.equal(journalStats([]).expectancyR, null);
});
test('riskBudget: heat, daily loss, position cap, concentration, capital guard', () => {
  const P = [{ id: 'a', ticker: 'NVDA', qty: 10, buyPrice: 100, buyDate: '2026-01-05', stop: 95 }, { id: 'b', ticker: 'AAPL', qty: 20, buyPrice: 200, buyDate: '2026-01-05', planStop: 190 }];
  const b = riskBudget({ capital: 10000, positions: P, prices: { a: 100, b: 204 }, journal: [] });
  assert.equal(b.openRiskPct, 3.3); assert.equal(b.gate, 'OPEN'); assert.ok(b.warnings.some((w) => w.rule === 'concentration'));
  assert.equal(riskBudget({ capital: 10000, positions: P, prices: { a: 100, b: 204 }, journal: [{ exitDate: todayISO(), pl: -250 }] }).sizeMult, 0.5);
  assert.equal(riskBudget({ capital: 10000, positions: [], journal: [{ exitDate: todayISO(), pl: -300 }] }).gate, 'BLOCKED');
  assert.equal(riskBudget({ capital: 10000, positions: Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, ticker: 'T' + i, qty: 1, buyPrice: 100, buyDate: '2026-01-05', stop: 99 })), journal: [] }).breaches[0].rule, 'positions');
  assert.equal(riskBudget({ capital: 0, positions: [], journal: [] }).breaches[0].rule, 'capital');
});
test('todayISO is the New York trading date', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

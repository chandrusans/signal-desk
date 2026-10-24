import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultAssumptions, runDcf, sensitivity, breakers } from '../dcf.js';

const years = [2021, 2022, 2023, 2024, 2025].map((fy, i) => ({ fy: String(fy), revenue: 100e9 * 1.1 ** i, opIncome: 30e9 * 1.1 ** i, ebitda: 34e9 * 1.1 ** i, capex: 5e9 * 1.1 ** i, pretax: 29e9 * 1.1 ** i, tax: 5.8e9 * 1.1 ** i, debt: 20e9, cash: 30e9, interest: 0.8e9, shares: 1e9 }));

test('defaults come from the filed history and sane market inputs', () => {
  const a = defaultAssumptions({ years, price: 300, marketCap: 300e9, beta: 1.2, riskFreePct: 4.5, medianEvEbitda: 18 });
  assert.equal(a.basis.revenueCagrPct, 10);
  assert.equal(a.growthStart, 0.1);
  assert.ok(Math.abs(a.operatingMargin - 0.3) < 1e-6);
  assert.ok(Math.abs(a.taxRate - 0.2) < 1e-6);
  assert.ok(a.wacc > 0.08 && a.wacc < 0.12, `wacc ${a.wacc}`);
  assert.equal(a.exitMultiple, 18);
  assert.equal(a.netDebt, -10e9);
});
test('the model is internally consistent: FCF, discounting, both terminal methods, per-share bridge', () => {
  const a = defaultAssumptions({ years, price: 300, marketCap: 300e9, beta: 1.0, riskFreePct: 4.0, medianEvEbitda: 15 });
  const r = runDcf(a, 300);
  assert.equal(r.rows.length, 5);
  const y1 = r.rows[0];
  const expectedFcf = y1.nopat + y1.da - y1.capex - y1.dNwc;
  assert.ok(Math.abs(y1.fcf - expectedFcf) < 1, 'FCF identity');
  assert.ok(Math.abs(y1.pv - y1.fcf / (1 + a.wacc)) < 1, 'year-1 discounting');
  assert.ok(r.terminal.perpetuity > 0 && r.terminal.exitMultiple > 0);
  assert.ok(Math.abs(r.perShare.perpetuity - (r.enterpriseValue.perpetuity - a.netDebt) / a.shares) < 1e-6);
  assert.ok(['UNDERVALUED', 'FAIRLY VALUED', 'OVERVALUED'].includes(r.verdict));
  assert.ok(r.terminalShareOfValue > 0.4 && r.terminalShareOfValue < 0.95, 'terminal value dominates, as in every DCF');
});
test('higher WACC lowers value; higher terminal growth raises it; the grid is monotone', () => {
  const a = defaultAssumptions({ years, price: 300, marketCap: 300e9, beta: 1.0, riskFreePct: 4.0 });
  const s = sensitivity(a, 300);
  for (const row of s.grid) for (let j = 1; j < row.length; j++) assert.ok(row[j] >= row[j - 1], 'value rises with terminal growth');
  for (let i = 1; i < s.grid.length; i++) assert.ok(s.grid[i][2] <= s.grid[i - 1][2], 'value falls with WACC');
});
test('breakers rank the assumptions by how much they swing the answer', () => {
  const a = defaultAssumptions({ years, price: 300, marketCap: 300e9, beta: 1.0, riskFreePct: 4.0 });
  const b = breakers(a, 300);
  assert.ok(b.length >= 5 && b[0].swingPct >= b[b.length - 1].swingPct);
  assert.ok(['discount rate (WACC)', 'operating margin', 'terminal growth'].includes(b[0].label), b[0].label);
});

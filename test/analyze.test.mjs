import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, regime } from '../analyze.js';
import { LIMITS } from '../risk.js';

const bars = (n, start = 100, drift = 0.3) => Array.from({ length: n }, (_, i) => { const c = start + i * drift; return { t: Date.UTC(2025, 0, 1) + i * 864e5, o: c - 0.5, h: c + 1, l: c - 1, c, v: 1e6 + (i % 7) * 1e5 }; });

test('regime bands follow the handbook', () => {
  assert.equal(regime(12).level, 'calm'); assert.equal(regime(19).level, 'normal'); assert.equal(regime(27).level, 'stress'); assert.equal(regime(40).level, 'crisis');
});
test('plan: stop below entry, target = entry + 2.5R, sizing uses the risk engine percentage', () => {
  const a = analyze(bars(260));
  assert.ok(!a.insufficient);
  const p = a.plan;
  assert.ok(p.stop < p.entry);
  assert.ok(Math.abs(p.target - (p.entry + 2.5 * (p.entry - p.stop))) < 1e-6);
  assert.equal(p.riskPct, LIMITS.riskPerTradePct);
  assert.equal(p.shares10k, Math.floor((10000 * LIMITS.riskPerTradePct / 100) / (p.entry - p.stop)));
});
test('insufficient history is reported, not guessed', () => {
  assert.ok(analyze(bars(30)).insufficient);
});

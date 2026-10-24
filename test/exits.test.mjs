import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionVerdict, initialStop, defaultStop, alertKey } from '../exits.js';

const pos = (o = {}) => ({ id: 'p', ticker: 'NVDA', qty: 10, buyPrice: 100, buyDate: '2026-01-05', planStop: 95, ...o });

test('R is defined by the initial stop, not a trailed one', () => {
  const v = positionVerdict(pos({ stop: 100 }), { price: 104 });
  assert.equal(v.R, 5); assert.equal(v.stop0, 95); assert.equal(v.stop, 100); assert.equal(v.target, 112.5);
});
test('active stop triggers the sell', () => {
  assert.equal(positionVerdict(pos({ stop: 99 }), { price: 98 }).rule, 'stop');
});
test('initialStop falls back to plan stop, then class default; a stop at/above entry is treated as trailed', () => {
  assert.equal(initialStop(pos({ stop: 101 })), 95);
  assert.equal(initialStop({ ticker: 'BTC', buyPrice: 100, assetClass: 'crypto' }), 93);
  assert.equal(defaultStop({ ticker: 'X', buyPrice: 100, stop: 97 }), 97);
});
test('regime: crisis sells; stress sells losers and watches winners; metals exempt', () => {
  assert.equal(positionVerdict(pos({ stop: 95 }), { price: 103, regime: { level: 'crisis', vix: 40 } }).rule, 'regime');
  assert.equal(positionVerdict(pos({ stop: 95 }), { price: 97, regime: { level: 'stress', vix: 28 } }).rule, 'regime');
  assert.equal(positionVerdict(pos({ stop: 95 }), { price: 103, regime: { level: 'stress', vix: 28 } }).rule, 'regime_stress');
  assert.notEqual(positionVerdict(pos({ ticker: 'GC=F', assetClass: 'metal', stop: 98 }), { price: 103, regime: { level: 'crisis', vix: 40 } }).rule, 'regime');
});
test('time stop counts trading sessions and only fires when the trade went nowhere', () => {
  const old = pos({ buyDate: '2025-06-02', stop: 95 });
  assert.equal(positionVerdict(old, { price: 101 }).rule, 'time_stop');
  assert.notEqual(positionVerdict(old, { price: 108 }).rule, 'time_stop');   // +1.6R is not "nowhere"
  const fresh = pos({ buyDate: new Date().toISOString().slice(0, 10), stop: 95 });
  assert.notEqual(positionVerdict(fresh, { price: 101 }).rule, 'time_stop');
});
test('options: premium stop, 7-day rule, +50% / +100% targets', () => {
  const far = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10), near = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const o = { id: 'o', ticker: 'NVDA260117C00100000', qty: 1, buyPrice: 10, buyDate: '2026-01-05', isOption: true, multiplier: 100, expiration: far };
  assert.equal(positionVerdict(o, { price: 4.9 }).rule, 'option_stop');
  assert.equal(positionVerdict({ ...o, expiration: near }, { price: 11 }).rule, 'option_dte');
  assert.equal(positionVerdict(o, { price: 15 }).rule, 'option_target_1');
  assert.equal(positionVerdict(o, { price: 20 }).rule, 'option_target_2');
});
test('alert keys: SELL/TRIM once per rule per trading day, WATCH once', () => {
  const sell = positionVerdict(pos({ stop: 99 }), { price: 98 });
  assert.match(alertKey(pos(), sell), /^p:stop:\d{4}-\d{2}-\d{2}$/);
  assert.equal(alertKey(pos(), { action: 'HOLD', rule: 'hold' }), null);
});

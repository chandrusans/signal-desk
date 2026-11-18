import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluatePositions, recordAlerts, entryAlert, useStore, memoryStore, getHistory, DEFAULT_SETTINGS, TYPES, watchUnion, bookUnion, setSwingWatch, setSwingBook, getSwingBook } from '../alerts.js';
import { signalFor } from '../strategies.js';
import { regime } from '../analyze.js';

const row = (o = {}) => ({ t: 'KMI', p: 34.43, c: 1.2, sc: 92, su: 'BREAKOUT', rs: 13.4, r20: 9, a50: true, a200: true, rsi2: 70, ma5: 34, atr: 2.5, vr: 1.4, stop: 32.71, tgt: 38.73, cls: 'stock', ...o });
const gateOpen = { vix: 17, spyAbove50: true, macroLevel: 'clear' };
const far = { KMI: { date: '2027-03-01', daysAway: 60 } };
const S = DEFAULT_SETTINGS;
const fresh = () => { const m = memoryStore({ 'sd-alerts-seen-v1': { __init: 1 } }); useStore(m); return m; };
const data = (o = {}) => ({ scan: { KMI: row() }, news: {}, gate: gateOpen, next: far, ...o });

test('a buy alert fires once per strategy per day when a watched stock meets an entry rule with the gates open', () => {
  fresh();
  const a = evaluate(['KMI'], data(), S).filter((x) => x.type === 'entry');
  assert.equal(a.length, 1);
  assert.match(a[0].title, /Buy signal: KMI — breakout/);
  assert.match(a[0].body, /Entry near \$34\.43, stop \$32\.71 \(−5\.0%\), target \$38\.73, 15-session time stop/);
  assert.equal(a[0].link, '/swing'); assert.equal(a[0].strategy, 'breakout');
  assert.equal(evaluate(['KMI'], data(), S).filter((x) => x.type === 'entry').length, 0, 'not raised twice');
  assert.ok(TYPES.entry && S.enabled.entry === true);
});

test('no buy alert without the market gate, in a closed market, before earnings, or when the type is off', () => {
  fresh(); assert.equal(evaluate(['KMI'], data({ gate: null }), S).filter((x) => x.type === 'entry').length, 0, 'gate not loaded: stay silent');
  fresh(); assert.equal(evaluate(['KMI'], data({ gate: { ...gateOpen, vix: 28 } }), S).filter((x) => x.type === 'entry').length, 0, 'stress regime');
  fresh(); assert.equal(evaluate(['KMI'], data({ gate: { ...gateOpen, spyAbove50: false } }), S).filter((x) => x.type === 'entry').length, 0, 'index below its 50-day');
  fresh(); assert.equal(evaluate(['KMI'], data({ gate: { ...gateOpen, macroLevel: 'blocked' } }), S).filter((x) => x.type === 'entry').length, 0, 'macro release');
  fresh(); assert.equal(evaluate(['KMI'], data({ next: { KMI: { date: '2026-11-20', daysAway: 2 } } }), S).filter((x) => x.type === 'entry').length, 0, 'earnings in 2 days');
  fresh(); assert.equal(evaluate(['KMI'], data(), { ...S, enabled: { ...S.enabled, entry: false } }).filter((x) => x.type === 'entry').length, 0, 'switched off');
  fresh(); assert.equal(evaluate(['BTC'], data({ scan: { BTC: row({ t: 'BTC', cls: 'crypto' }) } }), S).filter((x) => x.type === 'entry').length, 0, 'coins are not swing stocks');
});

test('an unknown earnings date still alerts, and says so', () => {
  fresh();
  const a = evaluate(['KMI'], data({ next: { KMI: null } }), S).find((x) => x.type === 'entry');
  assert.ok(a); assert.match(a.body, /no next-earnings date/);
});

test('recordAlerts shares the seen-store, so the Swing tab and the engine never raise the same signal twice', () => {
  fresh();
  const sig = signalFor(row(), { regime: regime(17), macroLevel: 'clear', nextEarnings: far.KMI });
  const al = entryAlert('KMI', sig, new Date().toISOString().slice(0, 10));
  assert.equal(recordAlerts([al]).length, 1);
  assert.equal(recordAlerts([al]).length, 0);
  assert.equal(evaluate(['KMI'], data(), S).filter((x) => x.type === 'entry').length, 0, 'the engine sees it as already raised');
  assert.equal(getHistory()[0].id, al.id);
});

test('the Swing list and paper book join the alert engine: union for the watchlist, exit alerts linked to the tab', () => {
  fresh();
  setSwingWatch(['kmi', 'DIS', 'not a ticker!']); setSwingBook([{ id: 'p1', ticker: 'JNJ', qty: 0.366, buyPrice: 273.23, buyDate: '2026-11-18', stop: 259.57, planStop: 259.57, initialStop: 259.57, strategy: 'meanrev', book: 'swing', timeStopDays: 7, assetClass: 'stock' }]);
  assert.deepEqual(watchUnion(['AAPL', 'KMI']), ['AAPL', 'KMI', 'DIS', 'JNJ']);
  assert.equal(bookUnion([{ id: 'd1', ticker: 'MSFT', qty: 1, buyPrice: 500 }]).length, 2);
  const fired = evaluatePositions(getSwingBook(), { p1: { price: 250 } }, S);       // below the stop
  assert.equal(fired.length, 1); assert.equal(fired[0].action, 'SELL'); assert.equal(fired[0].link, '/swing');
});

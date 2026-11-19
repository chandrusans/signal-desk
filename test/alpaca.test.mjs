import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBroker, brokerStatus, keyProblem, entryOrder } from '../api/_alpaca.js';

const ENV = { ALPACA_KEY_ID: 'PKTESTKEY123', ALPACA_SECRET_KEY: 'test-secret-not-real' };
const TODAY = '2026-11-19';
/** A pretend Alpaca: just enough of the paper API to see what the bot asks of it. */
function alpaca({ open = true, equity = 100000, cash = 100000, positions = [], orders = [] } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); calls.push({ host: u.host, method: opts.method, path: u.pathname + u.search, body: opts.body ? JSON.parse(opts.body) : null, key: opts.headers['APCA-API-KEY-ID'] });
    const json = (o, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(o) });
    if (u.pathname === '/v2/clock') return json({ is_open: open });
    if (u.pathname === '/v2/account') return json({ equity: String(equity), cash: String(cash), status: 'ACTIVE' });
    if (u.pathname === '/v2/positions' && opts.method === 'GET') return json(positions);
    if (u.pathname === '/v2/orders' && opts.method === 'GET') return json(orders);
    if (u.pathname === '/v2/orders' && opts.method === 'POST') return json({ id: 'order-1' });
    return json({});
  };
  return { fetchFn, calls, sent: () => calls.filter((c) => c.method !== 'GET') };
}
const buy = (o = {}) => ({ type: 'entry', ticker: 'KMI', strategy: 'breakout', plan: { entry: 34.43, stop: 32.71, target: 38.73, timeStopDays: 15, sizeMult: 1 }, ...o });
const noCtx = async () => ({});

test('paper only: a live key is refused before any request, and every request goes to the paper host', async () => {
  assert.match(keyProblem({ ALPACA_KEY_ID: 'AKLIVEKEY999', ALPACA_SECRET_KEY: 'x' }), /not an Alpaca PAPER key/);
  assert.match(keyProblem({}), /No Alpaca keys/); assert.equal(keyProblem(ENV), null);
  const live = alpaca();
  const r = await runBroker({ env: { ALPACA_KEY_ID: 'AKLIVEKEY999', ALPACA_SECRET_KEY: 'x' }, entries: [buy()], contextFor: noCtx, fetchFn: live.fetchFn, today: TODAY });
  assert.equal(live.calls.length, 0, 'not one call with a live key'); assert.equal(r.broker.lastRun.ok, false);
  const a = alpaca(); await runBroker({ env: ENV, entries: [buy()], contextFor: noCtx, fetchFn: a.fetchFn, today: TODAY });
  assert.ok(a.calls.length > 4); assert.ok(a.calls.every((c) => c.host === 'paper-api.alpaca.markets'));
});

test('a buy alert becomes one bracket order: whole shares at 1% risk, stop and target attached', async () => {
  const a = alpaca();
  const r = await runBroker({ env: ENV, entries: [buy()], contextFor: noCtx, fetchFn: a.fetchFn, today: TODAY });
  const sent = a.sent(); assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { symbol: 'KMI', qty: '581', side: 'buy', type: 'market', time_in_force: 'gtc', order_class: 'bracket', stop_loss: { stop_price: '32.71' }, take_profit: { limit_price: '38.73' } });
  assert.ok(581 * (34.43 - 32.71) <= 1000, '1% of $100,000 at risk');
  assert.deepEqual({ ...r.broker.trades.KMI, orderId: undefined }, { buyDate: TODAY, qty: 581, stop: 32.71, initialStop: 32.71, target: 38.73, strategy: 'breakout', timeStopDays: 15, orderId: undefined });
  assert.match(r.actions[0].text, /paper order for 581 shares \(breakout\)/);
  // mean reversion has no target: stop only
  assert.deepEqual(entryOrder('XOM', 10, { stop: 95, target: null }), { symbol: 'XOM', qty: '10', side: 'buy', type: 'market', time_in_force: 'gtc', order_class: 'oto', stop_loss: { stop_price: '95' } });
});

test('no order when the market is closed, when it is already held or ordered, or when the limits are full', async () => {
  const closed = alpaca({ open: false });
  assert.equal((await runBroker({ env: ENV, entries: [buy()], contextFor: noCtx, fetchFn: closed.fetchFn, today: TODAY })).summary, 'market closed'); assert.equal(closed.sent().length, 0);
  const held = alpaca({ positions: [{ symbol: 'KMI', qty: '10', avg_entry_price: '34', current_price: '35' }] });
  await runBroker({ env: ENV, entries: [buy()], contextFor: noCtx, fetchFn: held.fetchFn, today: TODAY }); assert.equal(held.sent().length, 0);
  const pending = alpaca({ orders: [{ id: 'o1', symbol: 'KMI', side: 'buy', type: 'market', legs: [] }] });
  await runBroker({ env: ENV, entries: [buy()], contextFor: noCtx, fetchFn: pending.fetchFn, today: TODAY }); assert.equal(pending.sent().length, 0);
  const six = alpaca({ positions: ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => ({ symbol: s, qty: '10', avg_entry_price: '100', current_price: '100' })) });
  const r = await runBroker({ env: ENV, entries: [buy()], contextFor: noCtx, fetchFn: six.fetchFn, today: TODAY });
  assert.equal(six.sent().length, 0); assert.match(r.actions[0].text, /risk limits are full/);
  const tiny = alpaca({ equity: 100, cash: 100 });
  const t = await runBroker({ env: ENV, entries: [buy()], contextFor: noCtx, fetchFn: tiny.fetchFn, today: TODAY });
  assert.equal(tiny.sent().length, 0); assert.match(t.actions[0].text, /one share risks more/);
});

test('exits: a SELL verdict closes the position; +1R raises the stop; positions it did not open are left alone', async () => {
  const trade = { buyDate: '2026-11-10', qty: 100, stop: 95, initialStop: 95, target: 112.5, strategy: 'breakout', timeStopDays: 15 };
  const positions = [{ symbol: 'KMI', qty: '100', avg_entry_price: '100', current_price: '94' }, { symbol: 'MINE', qty: '5', avg_entry_price: '50', current_price: '40' }];
  const a = alpaca({ positions });
  const r = await runBroker({ env: ENV, broker: { trades: { KMI: trade } }, contextFor: async () => ({ KMI: { price: 94, analysis: null, regime: null, earnings: null } }), fetchFn: a.fetchFn, today: TODAY });
  assert.deepEqual(a.sent().map((c) => `${c.method} ${c.path}`), ['DELETE /v2/positions/KMI?cancel_orders=true'], 'only its own position, never MINE');
  assert.equal(r.broker.trades.KMI, undefined); assert.match(r.actions[0].text, /KMI: sold \(stop\)/);

  const up = alpaca({ positions: [{ symbol: 'KMI', qty: '100', avg_entry_price: '100', current_price: '106' }], orders: [{ id: 'parent', symbol: 'KMI', side: 'sell', type: 'limit', legs: [{ id: 'stop-leg', symbol: 'KMI', side: 'sell', type: 'stop' }] }] });
  const r2 = await runBroker({ env: ENV, broker: { trades: { KMI: { ...trade, buyDate: TODAY } } }, contextFor: async () => ({ KMI: { price: 106, analysis: null, regime: null, earnings: null } }), fetchFn: up.fetchFn, today: TODAY });
  assert.deepEqual(up.sent().map((c) => [c.method, c.path, c.body]), [['PATCH', '/v2/orders/stop-leg', { stop_price: '100' }]]);
  assert.equal(r2.broker.trades.KMI.stop, 100); assert.match(r2.actions[0].text, /stop raised to \$100 \(breakeven\)/);
});

test('a trade the broker closed (stop or target filled) is forgotten; the status never includes the keys', async () => {
  const a = alpaca({ positions: [] });
  const r = await runBroker({ env: ENV, broker: { trades: { KMI: { buyDate: '2026-11-10', qty: 10, stop: 95, initialStop: 95 } } }, contextFor: noCtx, fetchFn: a.fetchFn, today: TODAY });
  assert.equal(r.broker.trades.KMI, undefined); assert.match(r.actions[0].text, /closed at the broker/);
  const st = await brokerStatus({ env: ENV, broker: { enabled: true, trades: {}, log: [] }, fetchFn: alpaca({ positions: [{ symbol: 'KMI', qty: '3', avg_entry_price: '34', current_price: '35', unrealized_pl: '3' }] }).fetchFn });
  assert.equal(st.enabled, true); assert.equal(st.account.equity, 100000); assert.equal(st.positions[0].symbol, 'KMI');
  assert.ok(!JSON.stringify(st).includes('test-secret-not-real') && !JSON.stringify(st).includes('PKTESTKEY123'));
});

// Alpaca PAPER trading for the alert runner (used by api/notify.js; the underscore keeps Vercel
// from routing this as its own function).
//
// What it does, when the owner has added paper keys and switched it on: every buy alert the
// runner raises becomes a paper order at Alpaca, sized by the same risk rules as the Swing tab,
// with its stop (and target) attached; and every position it opened is checked against the exit
// rulebook on each run. It is the rules trading pretend money without anyone pressing a button,
// so their record builds by itself.
//
// PAPER ONLY, by construction:
//   • the only host this module ever calls is paper-api.alpaca.markets (hard-coded below);
//   • a key that is not a paper key (paper key ids start "PK") is refused before any call;
//   • there is no setting, parameter or environment variable that points it anywhere else.
// It never touches positions it did not open itself.
//
// Simplifications against the paper rulebook, stated rather than hidden: whole shares only
// (bracket orders cannot be fractional); the target sells the whole position rather than half;
// "trim" verdicts other than the target are not acted on. Stops are still moved to breakeven
// and to +1R as the rulebook says, and every SELL verdict closes the position.

import { positionVerdict } from '../exits.js';
import { sizePosition } from '../strategies.js';
import { riskBudget, LIMITS } from '../risk.js';
import { tradingDateISO } from '../ui.js';

const PAPER_HOST = 'https://paper-api.alpaca.markets';
const SYMBOL = /^[A-Z]{1,5}$/;                       // plain US tickers; share classes with dots are skipped
const cents = (x) => (x >= 1 ? Math.round(x * 100) / 100 : Math.round(x * 10000) / 10000);
const MAX_LOG = 40;

export const configured = (env) => !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY);
/** Why the broker cannot be used, or null when it can. */
export function keyProblem(env) {
  if (!configured(env)) return 'No Alpaca keys on the server. Add ALPACA_KEY_ID and ALPACA_SECRET_KEY (paper keys) in Vercel → Settings → Environment Variables, then redeploy.';
  if (!/^PK[A-Z0-9]+$/.test(String(env.ALPACA_KEY_ID))) return 'The key on the server is not an Alpaca PAPER key (paper key ids start with "PK"). Live keys are refused: this app only trades pretend money.';
  return null;
}

/** Minimal client. Every request goes to the paper host; there is no way to pass another. */
export function client(env, fetchFn = (...a) => fetch(...a)) {
  const headers = { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY, 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    if (!path.startsWith('/v2/')) throw new Error('bad path');
    const r = await fetchFn(PAPER_HOST + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!r.ok) throw Object.assign(new Error(`Alpaca ${r.status}${data?.message ? ': ' + String(data.message).slice(0, 120) : ''}`), { status: r.status });
    return data;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

/** The order for a buy signal: market entry with the stop attached, and the target when the strategy has one. */
export function entryOrder(symbol, qty, plan) {
  const o = { symbol, qty: String(qty), side: 'buy', type: 'market', time_in_force: 'gtc', order_class: plan.target ? 'bracket' : 'oto', stop_loss: { stop_price: String(cents(plan.stop)) } };
  if (plan.target) o.take_profit = { limit_price: String(cents(plan.target)) };
  return o;
}

/**
 * One pass. `entries` are the buy alerts raised this run ({ ticker, strategy, plan }); `contextFor`
 * returns the exit-rule inputs for a list of positions ({ [id]: { price, analysis, regime, earnings } }).
 * Returns { broker, actions, summary }: the state to persist, what was done, and a status line.
 */
export async function runBroker({ env, broker = {}, entries = [], contextFor, fetchFn, today = tradingDateISO(), riskPct = LIMITS.riskPerTradePct }) {
  const out = { ...broker, trades: { ...(broker.trades || {}) }, log: [...(broker.log || [])] };
  const actions = [];
  const note = (kind, symbol, text) => { const a = { at: Date.now(), kind, symbol, text }; actions.push(a); out.log = [a, ...out.log].slice(0, MAX_LOG); };
  const problem = keyProblem(env);
  if (problem) return { broker: { ...out, lastRun: { at: Date.now(), ok: false, note: problem } }, actions, summary: problem };
  const api = client(env, fetchFn);
  let clock, account, positions, orders;
  try { [clock, account, positions, orders] = await Promise.all([api.get('/v2/clock'), api.get('/v2/account'), api.get('/v2/positions'), api.get('/v2/orders?status=open&nested=true&limit=200')]); }
  catch (e) { const m = `Alpaca did not answer (${e.message}). Nothing was traded.`; return { broker: { ...out, lastRun: { at: Date.now(), ok: false, note: m } }, actions, summary: m }; }
  const equity = +account.equity || 0, cash = +account.cash || 0;
  const held = Object.fromEntries((positions || []).map((p) => [p.symbol, p]));
  const flat = (orders || []).flatMap((o) => [o, ...(o.legs || [])]);
  const openFor = (sym) => flat.filter((o) => o.symbol === sym);

  // 1. Trades of ours that Alpaca has closed (stop or target filled): forget them.
  for (const sym of Object.keys(out.trades)) {
    if (!held[sym] && !openFor(sym).some((o) => o.side === 'buy')) { note('closed', sym, `${sym}: closed at the broker (stop or target filled).`); delete out.trades[sym]; }
  }
  if (!clock?.is_open) return { broker: { ...out, account: { equity, cash }, lastRun: { at: Date.now(), ok: true, note: 'Market closed: no orders sent.' } }, actions, summary: 'market closed' };

  // 2. Exits for the positions this bot opened.
  const mine = Object.keys(out.trades).filter((sym) => held[sym]).map((sym) => {
    const m = out.trades[sym], p = held[sym];
    return { id: sym, ticker: sym, qty: Math.abs(+p.qty), buyPrice: +p.avg_entry_price, buyDate: m.buyDate, stop: m.stop, initialStop: m.initialStop, target: m.target || undefined, strategy: m.strategy, timeStopDays: m.timeStopDays, book: 'swing', assetClass: 'stock' };
  });
  if (mine.length) {
    const ctx = (await contextFor(mine).catch(() => ({}))) || {};
    for (const pos of mine) {
      const c = ctx[pos.id]; if (!c || !(c.price > 0)) continue;
      const v = positionVerdict(pos, c), sym = pos.ticker;
      try {
        if (v.action === 'SELL') {
          await api.del(`/v2/positions/${sym}?cancel_orders=true`);
          note('sell', sym, `${sym}: sold (${v.rule.replace(/_/g, ' ')}) at about $${cents(c.price)}, ${v.gainR >= 0 ? '+' : ''}${v.gainR.toFixed(1)}R.`);
          delete out.trades[sym];
        } else if (v.rule === 'trail_1r' || v.rule === 'trail_be' || v.rule === 'regime_stress') {
          const want = cents(v.rule === 'trail_1r' ? pos.buyPrice + v.R : pos.buyPrice);
          const leg = openFor(sym).find((o) => o.side === 'sell' && (o.type === 'stop' || o.order_type === 'stop'));
          if (want > pos.stop && leg && want < c.price) { await api.patch(`/v2/orders/${leg.id}`, { stop_price: String(want) }); out.trades[sym] = { ...out.trades[sym], stop: want }; note('stop', sym, `${sym}: stop raised to $${want} (${v.rule === 'trail_1r' ? '+1R' : 'breakeven'}).`); }
        }
      } catch (e) { note('error', sym, `${sym}: could not act on ${v.action} (${e.message}).`); }
    }
  }

  // 3. Entries: one order per buy alert, if there is room in the risk limits and nothing is already there.
  const book = (positions || []).map((p) => ({ id: p.symbol, ticker: p.symbol, qty: Math.abs(+p.qty), buyPrice: +p.avg_entry_price, stop: out.trades[p.symbol]?.stop || +p.avg_entry_price * 0.95, assetClass: 'stock' }));
  const prices = Object.fromEntries((positions || []).map((p) => [p.symbol, +p.current_price || +p.avg_entry_price]));
  let cashLeft = cash;
  for (const e of entries) {
    const sym = String(e.ticker || '').toUpperCase(), plan = e.plan;
    if (!plan || !(plan.entry > plan.stop) || !SYMBOL.test(sym)) continue;
    if (held[sym] || openFor(sym).length || out.trades[sym]) { note('skip', sym, `${sym}: buy signal, but a position or order is already there.`); continue; }
    const rb = riskBudget({ capital: equity, positions: book, prices, journal: [], today, limits: { ...LIMITS, riskPerTradePct: riskPct } });
    if (rb.gate === 'BLOCKED') { note('skip', sym, `${sym}: buy signal, but the risk limits are full (${rb.breaches.map((b) => b.rule).join(', ') || 'no room'}).`); continue; }
    const size = sizePosition({ capital: equity, cash: cashLeft, riskPct: Math.min(riskPct, rb.roomRiskPct), entry: plan.entry, stop: plan.stop, sizeMult: plan.sizeMult ?? 1, fractional: false });
    if (!size || !size.feasible || size.qty < 1) { note('skip', sym, `${sym}: buy signal, but one share risks more than the budget allows.`); continue; }
    try {
      const order = await api.post('/v2/orders', entryOrder(sym, size.qty, plan));
      out.trades[sym] = { buyDate: today, qty: size.qty, stop: cents(plan.stop), initialStop: cents(plan.stop), target: plan.target ? cents(plan.target) : null, strategy: e.strategy, timeStopDays: plan.timeStopDays, orderId: order?.id || null };
      book.push({ id: sym, ticker: sym, qty: size.qty, buyPrice: plan.entry, stop: plan.stop, assetClass: 'stock' }); prices[sym] = plan.entry; cashLeft -= size.notional;
      note('buy', sym, `${sym}: paper order for ${size.qty} share${size.qty === 1 ? '' : 's'} (${e.strategy}), about $${Math.round(size.notional).toLocaleString('en-US')}, stop $${cents(plan.stop)}${plan.target ? `, target $${cents(plan.target)}` : ''}.`);
    } catch (err) { note('error', sym, `${sym}: the order was not accepted (${err.message}).`); }
  }
  const did = actions.filter((a) => ['buy', 'sell', 'stop'].includes(a.kind)).length;
  return { broker: { ...out, account: { equity, cash }, lastRun: { at: Date.now(), ok: true, note: did ? `${did} action${did === 1 ? '' : 's'}` : 'Nothing to do.' } }, actions, summary: did ? `${did} action(s)` : 'nothing to do' };
}

/** What the status panel shows: the account, the bot's open trades and its recent log. Never the keys. */
export async function brokerStatus({ env, broker = {}, fetchFn }) {
  const problem = keyProblem(env);
  const base = { configured: configured(env), problem, enabled: !!broker.enabled, trades: broker.trades || {}, log: (broker.log || []).slice(0, 20), lastRun: broker.lastRun || null };
  if (problem) return base;
  try {
    const api = client(env, fetchFn);
    const [account, positions] = await Promise.all([api.get('/v2/account'), api.get('/v2/positions')]);
    return { ...base, account: { equity: +account.equity, cash: +account.cash, status: account.status },
      positions: (positions || []).map((p) => ({ symbol: p.symbol, qty: +p.qty, entry: +p.avg_entry_price, price: +p.current_price, pl: +p.unrealized_pl, mine: !!(broker.trades || {})[p.symbol] })) };
  } catch (e) { return { ...base, problem: `Alpaca did not answer (${e.message}).` }; }
}

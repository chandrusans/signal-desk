// Signal Desk — the historical REPLAY: a small cash account run day by day through the live rules.
//
// The older engine (backtest.js) tests a setup on a handful of tickers. This one answers the
// question a user actually has: "if I had followed the Swing tab every day for ten years, with
// $1,000, what would have happened?" So every decision goes through the SAME functions the app
// uses today, not a re-implementation of them:
//
//   entries   signalFor()          (strategies.js)  score bars, earnings gate, regime allow-list
//   gate      regime() + breadth   (analyze.js) and applySpyTrend() (strategies.js)
//   exits     positionVerdict()    (exits.js)       stop, regime cuts, time stop, earnings exit, trims
//   sizing    sizePosition()       (strategies.js)  risk-first, 25% name cap, cash cap, fractions
//   limits    riskBudget()         (risk.js)        6 positions, 5% open risk, 3% daily loss
//
// Mechanics: decisions are made on each day's CLOSE and filled at the NEXT session's OPEN
// (cfg.exec = 'close' fills at the signal close instead, as a sensitivity check). Stops trigger
// intraday; an open below the stop fills at the open. Costs are charged per side in basis points.
//
// Input is the columnar table built by tools/replay-data.mjs; this module does no I/O.

import { signalFor, applySpyTrend, sizePosition, STRATEGIES } from './strategies.js';
import { positionVerdict } from './exits.js';
import { regime } from './analyze.js';
import { riskBudget, LIMITS } from './risk.js';

export const SETUPS = ['BREAKOUT', 'PULLBACK', 'EARLY', 'EXTENDED', 'BROKEN', 'EARNINGS', 'AVOID'];

export const REPLAY_DEFAULTS = {
  capital: 1000, riskPct: 1, fractional: true, maxNamePct: 25, costBps: 7,
  exec: 'open',                 // 'open' = next session's open (default) | 'close' = the signal day's close
  gates: true,                  // market gate: VIX regime + breadth + S&P 500 vs its 50-day
  earningsGate: true,           // the 5-day earnings gate on entries and the swing earnings exit
  universe: 'pit',              // 'pit' = members on each day | 'today' = today's members throughout (biased)
  strategies: ['breakout', 'pullback', 'meanrev'],
  minScore: null,               // { breakout, pullback } override
  stopAtr: null,                // ATR multiple for the stop instead of the plan's 1.5 (bounded 5–10% as live)
  targetR: null,                // target in R instead of 2.5
  timeStop: null,               // sessions, instead of the strategy's own
  from: null, to: null,         // ISO dates inside the data window
};

const DAY = 864e5;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/** First earnings filing on or after `d`, as the live feed's { date, daysAway }; null when the name has no record. */
export function nextEarningsFrom(dates, d) {
  if (!dates || !dates.length) return null;
  let lo = 0, hi = dates.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (dates[m] < d) lo = m + 1; else hi = m; }
  if (lo >= dates.length) return null;
  return { date: dates[lo], daysAway: daysBetween(d, dates[lo]) };
}

/**
 * The market gate on every day of the data, exactly as the live pages compute it: the VIX regime,
 * breadth (the share of that day's index members above their 50-day) and the S&P 500 against its
 * own 50-day. Returns an array aligned to data.days; each entry is the regime object the app shows.
 */
export function gateSeries(data, { universe = 'pit', k0 = 0, kEnd = data.days.length - 1 } = {}) {
  const { days, spy, vix, tickers } = data, names = Object.keys(tickers), last = days.length - 1;
  const out = new Array(days.length).fill(null);
  for (let k = k0; k <= kEnd; k++) {
    let n = 0, up = 0;
    for (const T of names) {
      if ((universe === 'today' ? tickers[T].member[last] : tickers[T].member[k]) !== 1) continue;
      const a = tickers[T].cols.a50[k]; if (a === a) { n++; if (a === 1) up++; }
    }
    const rg = regime(vix[k] > 0 ? vix[k] : null, n > 50 ? { pctAbove50: (up / n) * 100 } : null);
    out[k] = applySpyTrend(rg, spy.c[k] > spy.ma50[k]);
  }
  return out;
}

export function simulate(data, opts = {}) {
  const cfg = { ...REPLAY_DEFAULTS, ...opts };
  const { days, spy, vix, tickers, earnings } = data;
  const names = Object.keys(tickers);
  const k0 = cfg.from ? Math.max(0, days.findIndex((d) => d >= cfg.from)) : 0;
  const kEnd = cfg.to ? days.findLastIndex((d) => d <= cfg.to) : days.length - 1;
  const last = days.length - 1;
  const isMember = cfg.universe === 'today' ? (T) => tickers[T].member[last] === 1 : (T, k) => tickers[T].member[k] === 1;
  const C = (T, f, k) => tickers[T].cols[f][k];
  const has = (T, k) => C(T, 'c', k) > 0;
  const buyFill = (px) => px * (1 + cfg.costBps / 1e4), sellFill = (px) => px * (1 - cfg.costBps / 1e4);
  const limits = { ...LIMITS, riskPerTradePct: cfg.riskPct };

  const gates = cfg.gates ? gateSeries(data, { universe: cfg.universe, k0, kEnd }) : null;
  const gateOn = (k) => (gates ? gates[k] : null);
  const ne = (T, d) => (cfg.earningsGate ? nextEarningsFrom(earnings[T], d) : undefined);

  const rowAt = (T, k) => {
    const p = C(T, 'c', k), su = C(T, 'su', k), atr = C(T, 'atr', k);
    let stop = C(T, 'stop', k), tgt = C(T, 'tgt', k);
    if (cfg.stopAtr && atr > 0) { const dist = Math.min(p * 0.10, Math.max(cfg.stopAtr * atr, p * 0.05)); stop = p - dist; tgt = p + 2.5 * dist; }
    if (cfg.targetR && stop < p) tgt = p + cfg.targetR * (p - stop);
    const b = (x) => (x === x ? x === 1 : null), n = (x) => (x === x ? x : null);
    return { t: T, p, sc: n(C(T, 'sc', k)), su: su === su ? SETUPS[su] : null, rs: n(C(T, 'rs', k)), r20: n(C(T, 'r20', k)), a50: b(C(T, 'a50', k)), a200: b(C(T, 'a200', k)), rsi2: n(C(T, 'rsi2', k)), ma5: n(C(T, 'ma5', k)), stop: n(stop), tgt: n(tgt), cls: 'stock' };
  };

  // State
  let cash = cfg.capital;
  const book = [];                    // open positions
  let pendingIn = [], pendingOut = []; // orders for the next open: { T, ... } / { pos, frac, rule }
  const trades = [], journal = [], curve = [];
  const lastClose = {};
  const stats = { gateClosedDays: 0, setupsSeen: 0, heldByGate: 0, heldByEarnings: 0, buySignals: 0, taken: 0, skippedFull: 0, skippedSize: 0, skippedGap: 0, rules: {} };
  let id = 0;

  const equityAt = () => cash + book.reduce((s, p) => s + p.qty * (lastClose[p.T] ?? p.buy), 0);
  const close = (pos, px, k, rule, frac = 1, gapped = false) => {
    const q = frac >= 1 ? pos.qty : (cfg.fractional ? Math.floor(pos.qty * frac * 1000) / 1000 : Math.floor(pos.qty * frac));
    if (!(q > 0)) return false;
    const fill = sellFill(px), pl = q * (fill - pos.buyFill);
    cash += q * fill; pos.qty = +(pos.qty - q).toFixed(6); pos.pl += pl;
    journal.push({ exitDate: days[k], pl });
    if (pos.qty <= 1e-9) {
      book.splice(book.indexOf(pos), 1);
      trades.push({ t: pos.T, strategy: pos.strategy, entryDate: pos.buyDate, exitDate: days[k], entry: +pos.buyFill.toFixed(4), qty: pos.qty0, R: pos.R, pl: +pos.pl.toFixed(4),
        rMultiple: +(pos.pl / (pos.R * pos.qty0)).toFixed(3), sessions: k - pos.k, rule: pos.trimmed ? `${pos.trimRule}+${rule}` : rule, exitRule: rule, gapped, trimmed: !!pos.trimmed });
      stats.rules[rule] = (stats.rules[rule] || 0) + 1;
    } else { pos.trimmed = true; pos.trimRule = rule; }
    return true;
  };

  const enter = (o, px, k) => {
    if (book.some((p) => p.T === o.T)) return;
    if (!(px > o.stop) || (o.target && px >= o.target)) { stats.skippedGap++; return; }
    const equity = equityAt();
    const rb = riskBudget({ capital: equity, positions: book.map((p) => ({ id: p.id, ticker: p.T, qty: p.qty, buyPrice: p.buy, stop: p.stop, assetClass: 'stock' })),
      prices: Object.fromEntries(book.map((p) => [p.T, lastClose[p.T] ?? p.buy])), journal, today: days[k], limits });
    if (rb.gate === 'BLOCKED') { stats.skippedFull++; return; }
    const fill = buyFill(px);
    const s = sizePosition({ capital: equity, cash, riskPct: Math.min(cfg.riskPct, rb.roomRiskPct), entry: fill, stop: o.stop, sizeMult: o.sizeMult, fractional: cfg.fractional, maxNamePct: cfg.maxNamePct });
    if (!s || !s.feasible) { stats.skippedSize++; return; }
    cash -= s.qty * fill;
    book.push({ id: ++id, T: o.T, k, qty: s.qty, qty0: s.qty, buy: fill, buyFill: fill, buyDate: days[k], stop: o.stop, stop0: o.stop, R: fill - o.stop,
      target: o.target, strategy: o.strategy, timeStop: o.timeStop, pl: 0 });
    stats.taken++;
  };

  for (let k = k0; k <= kEnd; k++) {
    const d = days[k];
    // ── 1. The open: yesterday's decisions fill here ──
    if (cfg.exec === 'open') {
      for (const o of pendingOut) if (book.includes(o.pos)) { if (has(o.pos.T, k)) close(o.pos, C(o.pos.T, 'o', k), k, o.rule, o.frac); }
      for (const o of pendingIn) if (has(o.T, k)) enter(o, C(o.T, 'o', k), k);
      pendingOut = []; pendingIn = [];
    }
    // ── 2. During the day: stops, then targets (stop first: the conservative order) ──
    for (const pos of [...book]) {
      const T = pos.T;
      if (!has(T, k)) {                                     // no print: delisted or halted; after 10 sessions, out at the last close
        if (k - (pos.lastSeen ?? pos.k) > 10) close(pos, lastClose[T] ?? pos.buy, k, 'data_end');
        continue;
      }
      pos.lastSeen = k;
      const o = C(T, 'o', k), l = C(T, 'l', k), h = C(T, 'h', k);
      if (pos.k < k && o <= pos.stop) { close(pos, o, k, 'stop', 1, true); continue; }
      if (l <= pos.stop) { close(pos, pos.stop, k, 'stop'); continue; }
      if (pos.target && !pos.trimmed && h >= pos.target) { close(pos, Math.max(o, pos.target), k, 'target', 0.5); pos.stop = Math.max(pos.stop, pos.buy + pos.R); }
    }
    for (const T of names) { const c = C(T, 'c', k); if (c > 0) lastClose[T] = c; }

    // ── 3. The close: the live exit rulebook on every open position ──
    const rg = gateOn(k);
    for (const pos of [...book]) {
      const T = pos.T;
      if (!has(T, k)) continue;
      if (pos.trimmed) { const m20 = C(T, 'ma20', k); if (m20 < C(T, 'c', k)) pos.stop = Math.max(pos.stop, m20); }   // trail the rest under the 20-day
      const su = C(T, 'su', k);
      const v = positionVerdict(
        { id: pos.id, ticker: T, qty: pos.qty, buyPrice: pos.buy, buyDate: pos.buyDate, stop: pos.stop, initialStop: pos.stop0, target: pos.target || undefined,
          strategy: pos.strategy, timeStopDays: pos.timeStop, book: 'swing', assetClass: 'stock' },
        { price: C(T, 'c', k), today: d, regime: rg ? { level: rg.level, vix: vix[k] } : null, earnings: cfg.earningsGate ? ne(T, d) : null,
          analysis: { setup: su === su ? SETUPS[su] : null, indicators: { ma5: C(T, 'ma5', k), rsi14: C(T, 'rsi14', k), ma20Slope: C(T, 'slope', k) } } });
      let order = null;
      if (v.action === 'SELL') order = { pos, frac: 1, rule: v.rule };
      else if (v.action === 'TRIM' && !pos.trimmed && v.rule !== 'target') { order = { pos, frac: 0.5, rule: v.rule }; pos.stop = Math.max(pos.stop, v.rule === 'overbought_winner' ? pos.buy + pos.R : pos.buy); }
      else if (v.rule === 'trail_1r') pos.stop = Math.max(pos.stop, pos.buy + pos.R);
      else if (v.rule === 'trail_be' || v.rule === 'regime_stress') pos.stop = Math.max(pos.stop, pos.buy);
      if (!order) continue;
      if (cfg.exec === 'close') close(pos, C(T, 'c', k), k, order.rule, order.frac); else pendingOut.push(order);
    }

    // ── 4. New entries, ranked by score then relative strength ──
    if (rg && !rg.allow.length && rg.sizeMult < 0.5) stats.gateClosedDays++;
    const cands = [];
    for (const T of names) {
      if (!isMember(T, k) || !has(T, k)) continue;
      const su = C(T, 'su', k), r2 = C(T, 'rsi2', k), a2 = C(T, 'a200', k);
      if (!(su === 0 || su === 1 || (a2 === 1 && r2 < 10))) continue;           // nothing signalFor could buy
      const row = rowAt(T, k);
      const sig = signalFor(row, { regime: rg, macroLevel: null, nextEarnings: ne(T, d), lastEarnings: null, today: d, minScore: cfg.minScore });
      const want = (sig.action === 'BUY' ? sig.all : []).filter((s) => cfg.strategies.includes(s));
      const rawWant = (sig.action === 'BUY' ? sig.all : sig.all || []).filter((s) => cfg.strategies.includes(s));
      if (!rawWant.length) continue;
      stats.setupsSeen++;
      if (!want.length) { if (sig.action === 'AVOID') stats.heldByEarnings++; else if (rawWant.length) stats.heldByGate++; continue; }
      const id2 = want[0], S = STRATEGIES[id2];
      const R = row.p - sig.stop;
      cands.push({ T, sc: row.sc ?? 0, rs: row.rs ?? -99, strategy: id2, stop: sig.stop,
        target: S.targetR ? (cfg.targetR ? row.p + cfg.targetR * R : row.tgt > row.p ? row.tgt : row.p + S.targetR * R) : null,
        timeStop: cfg.timeStop || S.timeStopDays, sizeMult: (sig.sizeMult / (STRATEGIES[sig.strategy].riskMult || 1)) * S.riskMult });
    }
    stats.buySignals += cands.length;
    cands.sort((a, b) => b.sc - a.sc || b.rs - a.rs);
    const pendingOutIds = new Set(pendingOut.filter((o) => o.frac >= 1).map((o) => o.pos.id));
    let room = limits.maxPositions - book.filter((p) => !pendingOutIds.has(p.id)).length;
    for (const c of cands) {
      if (room <= 0) break;
      if (book.some((p) => p.T === c.T)) continue;
      if (cfg.exec === 'close') enter(c, C(c.T, 'c', k), k); else pendingIn.push(c);
      room--;
    }
    curve.push({ d, eq: equityAt(), n: book.length });
  }
  // Mark anything still open at the last close and report it apart from the closed record.
  const open = book.map((p) => ({ t: p.T, strategy: p.strategy, entryDate: p.buyDate, entry: p.buy, last: lastClose[p.T], rNow: +(((lastClose[p.T] - p.buy) * p.qty + p.pl) / (p.R * p.qty0)).toFixed(2) }));
  return { cfg, trades, open, curve, stats, metrics: metrics({ curve, trades, spy, days, k0, kEnd, capital: cfg.capital }) };
}

/**
 * Index timing: hold the index (total-return series `adj`) while `signal` is on, cash otherwise.
 * The position carried from close k to close k+1 is the signal at close k − lag: lag 1 (default) acts
 * a day late, lag 0 acts on the close that produced the signal. It never reads a later signal.
 * `signal` may be fractional (0…1) for partial exposure. Cash earns nothing; `costBps` per unit switched.
 */
export function indexTiming(adj, signal, { lag = 1, costBps = 5, from = 0, to = adj.length - 1, capital = 1000 } = {}) {
  let eq = capital, pos = 0, switches = 0, inDays = 0, peak = capital, dd = 0;
  for (let k = from; k < to; k++) {
    const want = k - lag >= from ? signal[k - lag] : 0;
    if (want !== pos) { eq *= 1 - (Math.abs(want - pos) * costBps) / 1e4; switches++; pos = want; }
    eq *= 1 + pos * (adj[k + 1] / adj[k] - 1);
    if (pos > 0) inDays++;
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
  }
  return { final: eq, maxDdPct: dd * 100, inMarketPct: to > from ? (inDays / (to - from)) * 100 : 0, switches };
}

/** Headline numbers, the yearly table, and the same for SPY held throughout with dividends reinvested. */
export function metrics({ curve, trades, spy, days, k0, kEnd, capital }) {
  if (!curve.length) return null;
  const yrs = Math.max((Date.parse(curve.at(-1).d) - Date.parse(curve[0].d)) / (365.25 * DAY), 1 / 365);
  const dd = (xs) => { let pk = -Infinity, m = 0; for (const x of xs) { pk = Math.max(pk, x); m = Math.min(m, x / pk - 1); } return m * 100; };
  const final = curve.at(-1).eq;
  const spyA = Array.from(spy.a.slice(k0, kEnd + 1));
  const spyFinal = capital * (spyA.at(-1) / spyA[0]);
  const wins = trades.filter((t) => t.pl > 0), losses = trades.filter((t) => t.pl <= 0);
  const gw = wins.reduce((s, t) => s + t.pl, 0), gl = -losses.reduce((s, t) => s + t.pl, 0);
  const byYear = {};
  for (let i = 0; i < curve.length; i++) {
    const y = curve[i].d.slice(0, 4);
    const prevEq = i ? curve[i - 1].eq : capital, prevSpy = i ? spyA[i - 1] : spyA[0];
    const b = (byYear[y] ||= { year: +y, start: prevEq, spyStart: prevSpy, trades: 0, sumR: 0 });
    b.end = curve[i].eq; b.spyEnd = spyA[i];
  }
  for (const t of trades) { const b = byYear[t.exitDate.slice(0, 4)]; if (b) { b.trades++; b.sumR += t.rMultiple; } }
  const per = (list) => ({ trades: list.length, winRate: list.length ? +((list.filter((t) => t.pl > 0).length / list.length) * 100).toFixed(0) : null,
    expectancyR: list.length ? +(list.reduce((s, t) => s + t.rMultiple, 0) / list.length).toFixed(3) : null, pl: +list.reduce((s, t) => s + t.pl, 0).toFixed(2) });
  const byStrategy = {};
  for (const s of new Set(trades.map((t) => t.strategy))) byStrategy[s] = per(trades.filter((t) => t.strategy === s));
  return {
    from: curve[0].d, to: curve.at(-1).d, years: +yrs.toFixed(2), capital,
    final: +final.toFixed(2), returnPct: +((final / capital - 1) * 100).toFixed(1), cagrPct: +((Math.pow(final / capital, 1 / yrs) - 1) * 100).toFixed(2),
    maxDdPct: +dd(curve.map((c) => c.eq)).toFixed(1),
    spyFinal: +spyFinal.toFixed(2), spyReturnPct: +((spyFinal / capital - 1) * 100).toFixed(1), spyCagrPct: +((Math.pow(spyFinal / capital, 1 / yrs) - 1) * 100).toFixed(2),
    spyMaxDdPct: +dd(spyA).toFixed(1),
    ...per(trades),
    profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : null,
    avgSessions: trades.length ? +(trades.reduce((s, t) => s + t.sessions, 0) / trades.length).toFixed(1) : null,
    gapStops: trades.filter((t) => t.gapped).length,
    exposurePct: +((curve.filter((c) => c.n > 0).length / curve.length) * 100).toFixed(0),
    avgPositions: +(curve.reduce((s, c) => s + c.n, 0) / curve.length).toFixed(2),
    byStrategy,
    byYear: Object.values(byYear).map((b) => ({ year: b.year, returnPct: +((b.end / b.start - 1) * 100).toFixed(1), spyPct: +((b.spyEnd / b.spyStart - 1) * 100).toFixed(1), trades: b.trades, expectancyR: b.trades ? +(b.sumR / b.trades).toFixed(2) : null })),
  };
}

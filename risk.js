// Signal Desk — the RISK ENGINE and the TRADE JOURNAL, shared by Today and the Dashboard.
//
// The exit rulebook (exits.js) decides when one position is sold. This module
// decides whether the BOOK can take another position at all, and keeps the
// record of closed trades that tells you whether the rulebook is working for
// you — your own win rate, average R and expectancy, not the backtest's.
//
// Limits (the "risk has the final say" rules):
//   riskPerTradePct   initial risk on a new position, % of capital        1%
//   dailyLossPct      realized loss today that closes the desk            3%
//   maxOpenRiskPct    portfolio heat: sum of (price − stop) × qty          5%
//   maxPositions      open positions                                      6
//   maxSingleNamePct  notional in one name, % of capital                  25%
//
// Nothing here is advice; these are the limits most systematic desks run and
// the handbook explains each one. Change them in one place.

import { classOf, defaultStop } from './exits.js';

export const LIMITS = { riskPerTradePct: 1, dailyLossPct: 3, maxOpenRiskPct: 5, maxPositions: 6, maxSingleNamePct: 25 };
export const JOURNAL_KEY = 'sd-journal-v1';
const DAY = 86400000;
const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Journal storage (localStorage by default; any {getItem,setItem} works) ──
export function loadJournal(store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return [];
  try { const a = JSON.parse(s.getItem(JOURNAL_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
export function saveJournal(trades, store) {
  const s = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return;
  try { s.setItem(JOURNAL_KEY, JSON.stringify(trades)); } catch {}
}

/** Turn an open position into a closed-trade record. `stop` is the INITIAL stop (defines 1R). */
export function closeTrade(pos, { exitPrice, exitDate = todayISO(), stop = null, rule = null, note = null } = {}) {
  const cls = classOf(pos);
  const mult = pos.multiplier || 1;
  const initialStop = stop > 0 ? stop : (pos.planStop > 0 ? pos.planStop : defaultStop(pos, null));
  const R = Math.max(1e-9, pos.buyPrice - initialStop);
  const pl = (exitPrice - pos.buyPrice) * pos.qty * mult;
  return {
    id: `${pos.id || pos.ticker}-x${Date.now()}`,
    ticker: pos.ticker, label: pos.label || pos.underlying || pos.ticker, cls,
    qty: pos.qty, mult, buyPrice: pos.buyPrice, buyDate: pos.buyDate, exitPrice, exitDate,
    stop: +initialStop.toFixed(4), target: pos.target > 0 ? pos.target : pos.planTarget > 0 ? pos.planTarget : null,
    pl: +pl.toFixed(2), plPct: +(((exitPrice - pos.buyPrice) / pos.buyPrice) * 100).toFixed(2),
    r: +((exitPrice - pos.buyPrice) / R).toFixed(2),
    daysHeld: Math.max(0, Math.round((Date.parse(exitDate) - Date.parse(pos.buyDate)) / DAY)),
    rule, note,
  };
}

/** Win rate, expectancy and friends over a list of closed trades. */
export function journalStats(trades) {
  const t = (trades || []).filter((x) => x && isFinite(x.r));
  const n = t.length;
  const wins = t.filter((x) => x.r > 0.05), losses = t.filter((x) => x.r < -0.05);
  const avg = (a, k) => (a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : null);
  const grossWin = wins.reduce((s, x) => s + Math.max(0, x.pl), 0), grossLoss = losses.reduce((s, x) => s + Math.max(0, -x.pl), 0);
  const expectancyR = n ? t.reduce((s, x) => s + x.r, 0) / n : null;
  const byKey = (key) => {
    const m = {};
    for (const x of t) { const k = x[key] || 'other'; (m[k] = m[k] || []).push(x); }
    return Object.fromEntries(Object.entries(m).map(([k, a]) => [k, { n: a.length, winRate: +((a.filter((x) => x.r > 0.05).length / a.length) * 100).toFixed(0), expectancyR: +(a.reduce((s, x) => s + x.r, 0) / a.length).toFixed(2), pl: +a.reduce((s, x) => s + x.pl, 0).toFixed(2) }]));
  };
  let streak = 0; for (let i = t.length - 1; i >= 0; i--) { const w = t[i].r > 0.05; if (i === t.length - 1) streak = w ? 1 : -1; else if ((w && streak > 0) || (!w && streak < 0)) streak += w ? 1 : -1; else break; }
  const last20 = t.slice(-20);
  return {
    n, wins: wins.length, losses: losses.length, scratches: n - wins.length - losses.length,
    winRate: n ? +((wins.length / n) * 100).toFixed(1) : null,
    avgWinR: avg(wins, 'r') != null ? +avg(wins, 'r').toFixed(2) : null,
    avgLossR: avg(losses, 'r') != null ? +avg(losses, 'r').toFixed(2) : null,
    expectancyR: expectancyR != null ? +expectancyR.toFixed(2) : null,
    last20ExpectancyR: last20.length ? +(last20.reduce((s, x) => s + x.r, 0) / last20.length).toFixed(2) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? Infinity : null,
    totalPL: +t.reduce((s, x) => s + x.pl, 0).toFixed(2),
    avgDays: avg(t, 'daysHeld') != null ? +avg(t, 'daysHeld').toFixed(1) : null,
    streak,
    byClass: byKey('cls'), byRule: byKey('rule'),
    // Enough trades to believe the number? ±1.96·σ/√n on expectancy.
    expectancySE: n >= 2 ? +(Math.sqrt(t.reduce((s, x) => s + Math.pow(x.r - expectancyR, 2), 0) / (n - 1)) / Math.sqrt(n)).toFixed(2) : null,
  };
}

/** Risk the book is carrying now, and whether it can take one more trade. */
export function riskBudget({ capital, positions = [], prices = {}, stops = {}, journal = [], today = todayISO(), limits = LIMITS }) {
  const cap = capital > 0 ? capital : 1;
  const rows = positions.map((pos) => {
    const mult = pos.multiplier || 1;
    const price = prices[pos.ticker] ?? prices[pos.id] ?? pos.buyPrice;
    const stop = stops[pos.id] ?? stops[pos.ticker] ?? (pos.stop > 0 ? pos.stop : pos.planStop > 0 ? pos.planStop : defaultStop(pos, null));
    const riskNow = Math.max(0, price - stop) * pos.qty * mult;      // what a stop-out from here would cost
    const notional = price * pos.qty * mult;
    return { id: pos.id, ticker: pos.ticker, cls: classOf(pos), price, stop, riskNow, notional, pctOfCapital: (notional / cap) * 100 };
  });
  const openRisk = rows.reduce((s, r) => s + r.riskNow, 0);
  const notional = rows.reduce((s, r) => s + r.notional, 0);
  const largest = rows.reduce((m, r) => (!m || r.notional > m.notional ? r : m), null);
  const realizedToday = journal.filter((t) => t.exitDate === today).reduce((s, t) => s + (t.pl || 0), 0);
  // Round once, here, so every message and meter prints the same figure.
  const openRiskPct = +((openRisk / cap) * 100).toFixed(2), realizedTodayPct = +((realizedToday / cap) * 100).toFixed(2);
  const breaches = [], warnings = [];
  if (rows.length >= limits.maxPositions) breaches.push({ rule: 'positions', text: `${rows.length} open positions — the limit is ${limits.maxPositions}. Close one before opening another.` });
  if (realizedTodayPct <= -limits.dailyLossPct) breaches.push({ rule: 'daily_loss', text: `Down ${Math.abs(realizedTodayPct).toFixed(1)}% today on closed trades — the ${limits.dailyLossPct}% daily limit. The desk is closed until tomorrow.` });
  if (openRiskPct >= limits.maxOpenRiskPct) breaches.push({ rule: 'heat', text: `Open risk at stops is ${openRiskPct.toFixed(1)}% of capital — the limit is ${limits.maxOpenRiskPct}%. If every stop hit tonight you would lose more than the book allows.` });
  if (largest && largest.pctOfCapital > limits.maxSingleNamePct) warnings.push({ rule: 'concentration', text: `${largest.ticker} is ${largest.pctOfCapital.toFixed(0)}% of capital (limit ${limits.maxSingleNamePct}%). Do not add to it.` });
  if (realizedTodayPct < 0 && realizedTodayPct > -limits.dailyLossPct && realizedTodayPct <= -limits.dailyLossPct / 2) warnings.push({ rule: 'daily_loss_half', text: `Down ${Math.abs(realizedTodayPct).toFixed(1)}% today — half the daily limit is gone. Size down.` });
  // Room for ONE more trade, as % of capital at risk
  let room = limits.riskPerTradePct;
  room = Math.min(room, limits.maxOpenRiskPct - openRiskPct);
  if (realizedTodayPct < 0) room = Math.min(room, limits.dailyLossPct + realizedTodayPct);
  room = Math.max(0, room);
  const gate = breaches.length || room < 0.1 ? 'BLOCKED' : room < limits.riskPerTradePct - 1e-9 ? 'REDUCED' : 'OPEN';
  return {
    gate, breaches, warnings, rows, limits,
    openCount: rows.length, slots: Math.max(0, limits.maxPositions - rows.length),
    openRisk: +openRisk.toFixed(2), openRiskPct,
    notional: +notional.toFixed(2), exposurePct: +((notional / cap) * 100).toFixed(1),
    largest: largest ? { ticker: largest.ticker, pct: +largest.pctOfCapital.toFixed(1) } : null,
    realizedToday: +realizedToday.toFixed(2), realizedTodayPct,
    roomRiskPct: +room.toFixed(2), roomRiskDollars: +((room / 100) * cap).toFixed(2),
    sizeMult: +(Math.min(1, room / limits.riskPerTradePct)).toFixed(2),
  };
}

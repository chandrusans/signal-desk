// Signal Desk — the swing STRATEGIES, as data and pure functions.
//
// The Swing tab, the alert engine (browser and server) and the tests all read
// this one module, so "is this a buy?" has a single answer everywhere.
//
// A strategy is an entry rule on a scan row plus the exit profile a position
// opened under it carries (time stop, target, how much risk). Four of them:
//
//   breakout   new 20-day high on volume in an uptrend               backtested
//   pullback   dip to the 10-day average inside an uptrend            backtested
//   meanrev    2-day RSI below 10 while above the 200-day average     backtested
//   pead       post-earnings drift after a clear beat                 NOT backtested here
//
// Nothing here is advice. The first three have a measured (thin) record in the
// engine's backtest; the fourth has none in this app and is sized at half risk
// until the paper journal says otherwise.

import { weekdaysBetween, tradingDateISO } from './ui.js';

export const STRATEGIES = {
  breakout: {
    id: 'breakout', name: 'Breakout', riskMult: 1, timeStopDays: 15, targetR: 2.5, tested: true, needs: 'BREAKOUT',
    entry: 'New 20-day high on volume at least 1.2× its average, RSI 55–72, price above rising 20 and 50-day averages, score 65 or better.',
    exit: 'Stop at the larger of 1.5 ATR or 5% (never more than 10%). Stop to breakeven at +1R, sell half at 2.5R and trail the rest, out after 15 sessions if it has gone nowhere.',
  },
  pullback: {
    id: 'pullback', name: 'Pullback', riskMult: 1, timeStopDays: 15, targetR: 2.5, tested: true, needs: 'PULLBACK',
    entry: 'Uptrend intact, price within 2% of its 10-day average, RSI cooled to 40–58, still up more than 3% over 20 days, score 60 or better.',
    exit: 'Same as a breakout: ATR stop, breakeven at +1R, half off at 2.5R, 15-session time stop.',
  },
  meanrev: {
    id: 'meanrev', name: 'Mean reversion', riskMult: 1, timeStopDays: 7, targetR: null, tested: true, needs: null,
    entry: 'Price above its 200-day average with the 2-day RSI below 10: a sharp, short dip inside a long uptrend.',
    exit: 'Sell on the first close back above the 5-day average, or after 7 sessions, or at the stop. There is no profit target; the bounce is the trade.',
  },
  pead: {
    id: 'pead', name: 'Post-earnings drift', riskMult: 0.5, timeStopDays: 20, targetR: 2.5, tested: false, needs: 'BREAKOUT',
    entry: 'Reported 2 to 10 sessions ago with EPS at least 5% above consensus, still above its 50-day average and up over 20 days.',
    exit: 'ATR stop and 2.5R target as for a breakout, 20-session time stop. Half size, because this app has no backtest for it.',
  },
};
export const STRATEGY_ORDER = ['breakout', 'pullback', 'pead', 'meanrev'];

const r2 = (x) => (x == null || !isFinite(x) ? null : +(+x).toFixed(2));

/**
 * The index trend is a second market gate on top of the VIX regime: with the S&P 500 below
 * its own 50-day average, most long setups fail whatever their chart looks like. Returns a
 * copy of the regime with new longs switched off; `spyAbove50 == null` leaves it untouched.
 */
export function applySpyTrend(rg, spyAbove50) {
  if (!rg || spyAbove50 !== false) return rg;
  return { ...rg, allow: [], sizeMult: Math.min(rg.sizeMult ?? 1, 0.25), level: rg.level === 'crisis' || rg.level === 'stress' ? rg.level : 'index-down',
    note: `The S&P 500 is below its 50-day average. No new longs until it reclaims it. ${rg.note || ''}`.trim() };
}

/**
 * Is this scan row a buy right now, and under which strategy?
 *
 * @param row  a /api/scan row: { t, p, sc, su, rs, r20, a50, a200, rsi2, ma5, atr, stop, tgt }
 * @param ctx  { regime: { level, sizeMult, allow, note }, macroLevel: 'clear'|'caution'|'blocked'|'unknown' (calendar unreadable),
 *               nextEarnings: { date, daysAway } | null (feed had none) | undefined (not checked),
 *               lastEarnings: { dateReported, surprisePct } | null, today: 'YYYY-MM-DD' }
 * @returns { action: 'BUY'|'WAIT'|'AVOID', strategy, all, reason, entry, stop, target, timeStopDays, sizeMult, caveats }
 */
export function signalFor(row, ctx = {}) {
  const none = (action, reason, extra = {}) => ({ action, strategy: null, all: [], reason, entry: row?.p ?? null, stop: null, target: null, timeStopDays: null, sizeMult: 0, caveats: [], ...extra });
  if (!row || !(row.p > 0)) return none('WAIT', 'No price yet.');
  const today = ctx.today || tradingDateISO();
  const rg = ctx.regime || null;
  const ne = ctx.nextEarnings;

  // 1. What the chart says, before any gate.
  // ctx.minScore overrides the score bars; only the historical replay's sensitivity check uses it.
  const minBo = ctx.minScore?.breakout ?? 65, minPb = ctx.minScore?.pullback ?? 60;
  const raw = [];
  if (row.su === 'BREAKOUT' && (row.sc || 0) >= minBo) raw.push('breakout');
  if (row.su === 'PULLBACK' && (row.sc || 0) >= minPb) raw.push('pullback');
  const le = ctx.lastEarnings;
  if (le && le.dateReported && le.surprisePct >= 5) {
    const since = weekdaysBetween(le.dateReported, today);
    if (since >= 2 && since <= 10 && row.a50 && row.r20 > 0 && row.su !== 'BROKEN' && row.su !== 'AVOID') raw.push('pead');
  }
  if (row.a200 && row.rsi2 != null && row.rsi2 < 10) raw.push('meanrev');

  if (!raw.length) {
    if (row.su === 'BROKEN') return none('AVOID', 'Trend is broken: price is below its 50-day average. Not a buy until it reclaims it.');
    if (row.su === 'EXTENDED') return none('WAIT', 'Strong but extended, more than 6% above its 20-day average. Wait for a pullback to the 10 or 20-day.');
    if (row.su === 'EARLY') return none('WAIT', 'Uptrend forming, but no entry yet: needs a new 20-day high on volume or a dip to the 10-day average.');
    if (row.su === 'BREAKOUT' || row.su === 'PULLBACK') return none('WAIT', `${row.su === 'BREAKOUT' ? 'Breakout' : 'Pullback'} shape, but the score (${row.sc ?? '—'}) is under the bar for an entry.`);
    return none('WAIT', 'No clean setup on this bar.');
  }

  // 2. Gates that override every chart.
  if (ctx.macroLevel === 'blocked') return none('WAIT', 'A setup is there, but a high-impact US release is inside 48 hours. No new entries until it has printed.', { all: raw });
  if (ne && ne.daysAway != null && ne.daysAway >= 0 && ne.daysAway <= 5) return none('AVOID', `${ne.estimated ? 'Earnings expected in about' : 'Earnings in'} ${ne.daysAway} day${ne.daysAway === 1 ? '' : 's'} (${ne.estimated ? 'around ' : ''}${ne.date}${ne.estimated ? ', estimated from past reports' : ''}). No new entry; a gap goes through a stop, not to it.`, { all: raw });

  // 3. The market regime decides which strategies may trade today.
  const allow = rg ? rg.allow || [] : ['BREAKOUT', 'PULLBACK'];
  const rgMult = rg ? rg.sizeMult ?? 1 : 1;
  const ok = raw.filter((id) => {
    const S = STRATEGIES[id];
    if (S.needs) return allow.includes(S.needs);
    return rgMult >= 0.5;                               // mean reversion: any tape short of stress
  });
  if (!ok.length) return none('WAIT', `A setup is there (${raw.map((id) => STRATEGIES[id].name.toLowerCase()).join(', ')}), but the market regime does not allow it today${rg?.note ? `: ${rg.note}` : '.'}`, { all: raw });

  const id = STRATEGY_ORDER.find((x) => ok.includes(x));
  const S = STRATEGIES[id];
  const entry = row.p;
  const stop = row.stop > 0 && row.stop < entry ? row.stop : r2(entry * 0.95);
  const R = entry - stop;
  const target = S.targetR ? (id !== 'pead' && row.tgt > entry ? row.tgt : r2(entry + S.targetR * R)) : null;
  const sizeMult = +(Math.min(1, rgMult) * (ctx.macroLevel === 'caution' ? 0.5 : 1) * S.riskMult).toFixed(3);

  const caveats = [];
  if (ne === null) caveats.push('The feed has no next-earnings date for this name, so the 5-day earnings gate could not be applied. Confirm the report date before entering.');
  const holdCal = Math.ceil(S.timeStopDays * 1.45);     // sessions → calendar days
  if (ne && ne.daysAway > 5 && ne.daysAway <= holdCal) caveats.push(`${ne.estimated ? `Expected to report around ${ne.date} (estimated from past reports)` : `Reports on ${ne.date}`}, in ${ne.daysAway} days, inside the ${S.timeStopDays}-session holding window. Plan to be out, or at least half out, before the print.`);
  if (ctx.macroLevel === 'unknown') caveats.push('The economic calendar could not be read, so the macro gate was not applied. Check for a major US release (inflation, jobs, a Fed decision) in the next two days before entering.');
  if (!S.tested) caveats.push('This strategy is not backtested in this app. It is sized at half risk; the paper scorecard is its only record.');
  if (sizeMult < S.riskMult) caveats.push(`Size cut to ${Math.round((sizeMult / S.riskMult) * 100)}% of normal by the market regime${ctx.macroLevel === 'caution' ? ' and the macro calendar' : ''}.`);

  const why = id === 'breakout' ? `Breaking out: new 20-day high on rising volume, score ${row.sc}.`
    : id === 'pullback' ? `Pulling back in an uptrend to its 10-day average, score ${row.sc}.`
    : id === 'pead' ? `Beat consensus by ${le.surprisePct.toFixed(0)}% on ${le.dateReported} and has held its gains since.`
    : `2-day RSI ${row.rsi2.toFixed(0)} while above its 200-day average: a sharp dip in a long uptrend.`;
  return { action: 'BUY', strategy: id, all: ok, reason: why, entry, stop: r2(stop), target, timeStopDays: S.timeStopDays, sizeMult, caveats };
}

/**
 * Conviction grade: five yes/no checks, printed, so the ranking among several buys is not a feeling.
 * @param fund  the row for this ticker from data/screen.json (may be undefined)
 */
export function gradeFor(row, sig, fund, ctx = {}) {
  const stopPct = sig?.stop && sig.entry ? ((sig.entry - sig.stop) / sig.entry) * 100 : null;
  const ne = ctx.nextEarnings;
  const holdCal = Math.ceil(((sig && sig.timeStopDays) || 15) * 1.45);
  const checks = [
    { ok: row?.rs != null && row.rs >= 5, text: row?.rs != null ? `Beating the market by ${row.rs >= 0 ? '+' : ''}${row.rs.toFixed(1)}% over 20 days (needs +5%)` : 'Relative strength not available' },
    { ok: stopPct != null && stopPct <= 6, text: stopPct != null ? `Stop is ${stopPct.toFixed(1)}% away (tight is 6% or less)` : 'No stop distance' },
    { ok: fund?.cash === 'REAL', text: fund?.cash ? `Profits ${String(fund.cash).toLowerCase()} in the filings` : 'No filing data for the cash check' },
    { ok: fund?.risk != null && fund.risk <= 4, text: fund?.risk != null ? `Risk rating ${fund.risk}/10 (needs 4 or lower)` : 'No risk rating' },
    { ok: !!ne && ne.daysAway != null && ne.daysAway > holdCal, text: ne ? (ne.daysAway > holdCal ? `Next earnings ${ne.estimated ? 'around ' : ''}${ne.date}${ne.estimated ? ' (estimate)' : ''}, after the holding window` : `Earnings ${ne.estimated ? 'around ' : ''}${ne.date}${ne.estimated ? ' (estimate)' : ''} fall inside the holding window`) : 'Earnings date unknown' },
  ];
  const points = checks.filter((c) => c.ok).length;
  return { grade: points >= 4 ? 'A' : points === 3 ? 'B' : 'C', points, max: checks.length, checks };
}

/**
 * How many shares, for a small account. Risk-first, then three caps: one name's share of the
 * account, the cash actually free (a cash account cannot borrow), and whole shares when the
 * broker does not do fractions.
 */
export function sizePosition({ capital, cash = null, riskPct = 1, entry, stop, sizeMult = 1, fractional = true, maxNamePct = 25 } = {}) {
  const perShare = entry - stop;
  if (!(capital > 0) || !(perShare > 0) || !(entry > 0)) return null;
  const riskBudget = capital * (riskPct / 100) * sizeMult;
  let qty = riskBudget / perShare, cappedBy = 'risk';
  const maxNotional = capital * (maxNamePct / 100);
  if (qty * entry > maxNotional) { qty = maxNotional / entry; cappedBy = 'concentration'; }
  if (cash != null && qty * entry > cash) { qty = Math.max(0, cash) / entry; cappedBy = 'cash'; }
  qty = fractional ? Math.floor(qty * 1000 + 1e-9) / 1000 : Math.floor(qty + 1e-9);
  const notional = qty * entry;
  return {
    qty, notional: +notional.toFixed(2), risk: +(qty * perShare).toFixed(2), riskBudget: +riskBudget.toFixed(2),
    pctOfCapital: +((notional / capital) * 100).toFixed(1), cappedBy,
    feasible: qty > 0 && notional >= 1,                  // brokers that do fractions want at least $1 a ticket
    capitalForOneShare: +(perShare / ((riskPct / 100) * sizeMult || 1e-9)).toFixed(0),   // account size at which one WHOLE share is exactly this risk
  };
}

/**
 * Dollar accounting over a list of backtest trades for a given account size, so the same
 * strategy can be read at $1,000 with fractions, at $1,000 with whole shares, or at $10,000.
 * Trades are { entry, exit, R, rMultiple, exitDate }. Sized on the equity at the time, in
 * exit order (the engine's own convention); concurrent cash use is not modelled.
 */
export function accountTrades(trades, { capital = 1000, riskPct = 1, fractional = true, maxNamePct = 25 } = {}) {
  const list = [...(trades || [])].filter((t) => t && t.R > 0 && t.entry > 0).sort((a, b) => a.exitDate - b.exitDate);
  let equity = capital, peak = capital, maxDd = 0, taken = 0, skipped = 0, wins = 0, sumR = 0;
  for (const t of list) {
    const s = sizePosition({ capital: equity, riskPct, entry: t.entry, stop: t.entry - t.R, fractional, maxNamePct });
    if (!s || !s.feasible) { skipped++; continue; }
    const pnl = s.qty * (t.exit - t.entry);
    equity += pnl; taken++; sumR += t.rMultiple; if (t.rMultiple > 0) wins++;
    if (equity > peak) peak = equity;
    const dd = ((equity - peak) / peak) * 100; if (dd < maxDd) maxDd = dd;
  }
  return {
    capital, final: +equity.toFixed(2), returnPct: +(((equity - capital) / capital) * 100).toFixed(1),
    taken, skipped, winRate: taken ? +((wins / taken) * 100).toFixed(0) : null,
    expectancyR: taken ? +(sumR / taken).toFixed(2) : null, maxDdPct: +maxDd.toFixed(1),
  };
}

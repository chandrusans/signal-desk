// Signal Desk — the EXIT rulebook, shared by the Dashboard and the Alerts engine.
//
// There is exactly one copy of "when do I sell" so the two can never disagree:
// the Dashboard shows the verdict, the Alerts tab notifies on it, and both call
// positionVerdict() below with the same inputs.
//
// A position is the object the Dashboard stores (localStorage `sd-portfolio-v1`):
//   { id, ticker, qty, buyPrice, buyDate, stop?, target?, assetClass?,
//     isOption?, underlying?, strike?, expiration?, multiplier?, timeStopDays? }
// assetClass is 'stock' | 'metal' | 'crypto' | 'option'; legacy rows without it
// are stocks (or options when isOption is set).
//
// ctx carries what the caller has fetched:
//   price        current price (option: contract mid)
//   analysis     analyze() output for the underlying bars, or null
//   regime       { level, vix? } — VIX regime for equities/metals, cryptoRegime for crypto
//   earnings     { date, daysAway } for stocks, or null
//   underlying   current underlying price (options)
//
// Verdicts: SELL (act now) · TRIM (take partial / move stop) · WATCH (decision
// close) · HOLD. Every verdict carries the rule that produced it.

import { tradingDateISO, weekdaysBetween } from './ui.js';

const DAY = 86400000;

export function classOf(pos) {
  if (pos.assetClass) return pos.assetClass;
  return pos.isOption ? 'option' : 'stock';
}

/** Class-default stop distance, used when nothing was stored at entry. */
function classDefaultStop(pos, analysis) {
  const cls = classOf(pos);
  if (cls === 'option') return pos.buyPrice * 0.5;                       // -50% of premium
  if (analysis?.plan?.stop > 0 && analysis.plan.entry > 0) {
    // ATR-derived distance from the plan, re-anchored to the actual fill
    return pos.buyPrice * (analysis.plan.stop / analysis.plan.entry);
  }
  return pos.buyPrice * (cls === 'crypto' ? 0.93 : cls === 'metal' ? 0.98 : 0.95);
}

/** The ACTIVE stop — where a sell is triggered now. The user may have trailed it. */
export function defaultStop(pos, analysis) {
  if (pos.stop > 0) return pos.stop;
  if (pos.planStop > 0) return pos.planStop;
  return classDefaultStop(pos, analysis);
}

/** The INITIAL stop — what defined 1R at entry. Never moves, so R-multiples, the 2.5R
 *  target and the time stop stay meaningful after the stop is trailed to breakeven. */
export function initialStop(pos, analysis) {
  if (pos.initialStop > 0) return pos.initialStop;
  if (pos.planStop > 0) return pos.planStop;
  const s = pos.stop > 0 ? pos.stop : classDefaultStop(pos, analysis);
  // A stored stop at or above entry was trailed, not initial: fall back to the class default.
  return s < pos.buyPrice * 0.995 ? s : classDefaultStop(pos, analysis);
}

export function positionVerdict(pos, ctx = {}) {
  const cls = classOf(pos);
  const buy = pos.buyPrice;
  const price = ctx.price ?? buy;
  const stop = defaultStop(pos, ctx.analysis);                 // active stop: triggers the sell
  const stop0 = initialStop(pos, ctx.analysis);                // initial stop: defines 1R
  const R = Math.max(buy * 0.005, buy - stop0);                // never less than 0.5% of entry
  const gain = price - buy;
  const gainR = gain / R;
  const gainPct = (gain / buy) * 100;
  const daysHeld = Math.max(0, Math.floor((Date.now() - Date.parse(pos.buyDate)) / DAY));
  // The time stop counts TRADING sessions (weekdays), as the handbook says — 15 calendar
  // days is only ~11 sessions and sold positions four sessions early.
  const sessionsHeld = pos.buyDate ? weekdaysBetween(String(pos.buyDate).slice(0, 10)) : 0;
  const timeStop = pos.timeStopDays || 15;
  const target = pos.target > 0 ? pos.target : pos.planTarget > 0 ? pos.planTarget : buy + 2.5 * R;
  const a = ctx.analysis && !ctx.analysis.insufficient ? ctx.analysis : null;
  const rg = ctx.regime || null;
  const base = { cls, buy, price, stop, stop0, R, gain, gainR, gainPct, daysHeld, sessionsHeld, target };
  const V = (action, severity, reason, rule) => ({ action, severity, reason, rule, ...base });

  // ── Options: the contract has its own clock ─────────────────────────────
  if (cls === 'option') {
    // Days to expiry by CALENDAR DATE, not hours: with hours, "6 days left"
    // read as 7 until after the close, so the 7-day sell fired a day late.
    // …and by the NEW YORK calendar: after 8 pm Eastern the UTC date is already tomorrow,
    // which used to mark a contract expired a session early.
    const dte = pos.expiration ? Math.round((Date.parse(pos.expiration + 'T00:00:00Z') - Date.parse(tradingDateISO() + 'T00:00:00Z')) / DAY) : null;
    if (dte != null && dte <= 0) return V('SELL', 'high', `Expired ${pos.expiration}. Whatever is left is gone.`, 'option_expired');
    if (price <= stop) return V('SELL', 'high', `Premium $${price.toFixed(2)} is at or below the $${stop.toFixed(2)} stop (−${((1 - price / buy) * 100).toFixed(0)}%). That is half your money and it is the line — sell.`, 'option_stop');
    if (dte != null && dte < 7) return V('SELL', 'high', `${dte} day${dte === 1 ? '' : 's'} to expiry. Time decay accelerates from here; the rulebook never holds inside 7 days. Sell today.`, 'option_dte');
    // Targets honour the stored card level when present (the card prints a
    // rounded premium, e.g. $10.27 for +50% on $6.85, which is 49.93% — a
    // strict >= 50 would never fire at the printed level), with a half-point
    // tolerance otherwise.
    if (gainPct >= 99.5) return V('TRIM', 'high', `Premium up ${gainPct.toFixed(0)}% (+100% target). Sell the rest, or at minimum the second half.`, 'option_target_2');
    if (gainPct >= 49.5 || (pos.target > 0 && price >= pos.target)) return V('TRIM', 'medium', `Premium up ${gainPct.toFixed(0)}% (+50% target${pos.target > 0 ? `, $${pos.target.toFixed(2)}` : ''}). Sell half; raise the stop on the rest to your entry $${buy.toFixed(2)}.`, 'option_target_1');
    if (dte != null && dte <= 10) return V('WATCH', 'medium', `${dte} days to expiry. Plan the exit — the 7-day rule is close.`, 'option_dte_near');
    if (price < buy && price - stop < R * 0.3) return V('WATCH', 'medium', `Premium $${price.toFixed(2)}, ${(((price - stop) / stop) * 100).toFixed(0)}% above the stop. Decision close.`, 'option_near_stop');
    return V('HOLD', 'low', `${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(0)}% on the premium${dte != null ? `, ${dte} days left` : ''}. Hold; sell half at +50%.`, 'option_hold');
  }

  // ── Stocks, metals, crypto: the swing rulebook ──────────────────────────
  if (price <= stop) return V('SELL', 'high', `Hard stop hit ($${fmt(stop)}). Exit the full position — no averaging down.`, 'stop');
  // Regime: CRISIS (VIX ≥ 35) cuts the book. STRESS (25–35) happens several times a
  // year and often marks short-term lows, so it only cuts LOSING positions and tightens
  // the rest. Metals are exempt — gold is the hedge that stress is supposed to pay for.
  if (rg && cls !== 'metal' && rg.level === 'crisis') return V('SELL', 'high', `Regime is CRISIS${rg.vix != null ? ` (VIX ${rg.vix.toFixed(1)})` : ''}. The rulebook cuts the momentum book here regardless of the chart.`, 'regime');
  if (rg && cls !== 'metal' && rg.level === 'stress' && gainR < 0) return V('SELL', 'high', `Regime is STRESS${rg.vix != null ? ` (VIX ${rg.vix.toFixed(1)})` : ''} and this position is already losing (${gainR.toFixed(1)}R). Momentum losers in a stress tape get worse; cut it.`, 'regime');
  if (rg && cls !== 'metal' && rg.level === 'stress' && stop < buy) return V('WATCH', 'high', `Regime is STRESS${rg.vix != null ? ` (VIX ${rg.vix.toFixed(1)})` : ''}. Winners survive stress; losers do not — move the stop to breakeven ($${fmt(buy)}) now and let the stop decide.`, 'regime_stress');
  if (cls === 'stock' && ctx.earnings?.daysAway != null && ctx.earnings.daysAway >= 0 && ctx.earnings.daysAway <= 5) {
    return V(gainR >= 1 ? 'TRIM' : 'WATCH', 'high', `Earnings in ${ctx.earnings.daysAway} day${ctx.earnings.daysAway === 1 ? '' : 's'} (${ctx.earnings.date}). A gap fills through your stop, not at it — ${gainR >= 1 ? 'take at least half off before the print' : 'decide now whether you are holding through it, and size for a 10% gap if so'}.`, 'earnings_soon');
  }
  if (a?.setup === 'BROKEN' && gainR < 0.5) {
    // A fresh position that is not yet losing gets a warning, not a sell: the
    // stop decides. An established one, or one already underwater, is a sell.
    if (sessionsHeld < 3 && gainR > -0.5) return V('WATCH', 'medium', `Setup is BROKEN (price below its key moving averages) — the rulebook would not have entered here. The stop at $${fmt(stop)} decides; do not move it down.`, 'broken_fresh');
    return V('SELL', 'high', `Setup turned BROKEN — price below its key moving averages, trend over. Take the loss before it compounds.`, 'broken');
  }
  if (sessionsHeld >= timeStop && Math.abs(gainR) < 1) return V('SELL', 'medium', `Time stop: ${sessionsHeld} trading days held and the trade has gone nowhere (${gainR >= 0 ? '+' : ''}${gainR.toFixed(1)}R). Free the capital.`, 'time_stop');
  if (price >= target) return V('TRIM', 'high', `Target reached ($${fmt(target)}, +${gainR.toFixed(1)}R). Sell half; trail the stop on the rest under the 20-day average.`, 'target');
  if (a?.indicators?.rsi14 > 78 && gainR >= 2) return V('TRIM', 'medium', `RSI ${a.indicators.rsi14.toFixed(0)} with +${gainR.toFixed(1)}R. Overextended — sell half, move the stop to +1R ($${fmt(buy + R)}).`, 'overbought_winner');
  if (a?.setup === 'EXTENDED' && gainR >= 2) return V('TRIM', 'medium', `EXTENDED with +${gainR.toFixed(1)}R. Take partial; wait for a pullback to re-add.`, 'extended_winner');
  if (a?.indicators?.ma20Slope != null && a.indicators.ma20Slope < -0.005 && gainR >= 1) return V('TRIM', 'medium', `20-day average rolling over (${(a.indicators.ma20Slope * 100).toFixed(1)}%/5d) on a +${gainR.toFixed(1)}R winner. Protect the gain.`, 'trend_fading');
  if (gainR >= 2 && stop < buy + R) return V('HOLD', 'medium', `+${gainR.toFixed(1)}R. Move your stop up to +1R = $${fmt(buy + R)} now; let it run toward $${fmt(target)}.`, 'trail_1r');
  if (gainR >= 1 && stop < buy) return V('HOLD', 'medium', `+${gainR.toFixed(1)}R. Move your stop to breakeven ($${fmt(buy)}) — the trade can no longer lose.`, 'trail_be');
  if (sessionsHeld < 3) return V('HOLD', 'low', `Fresh position (session ${sessionsHeld}). Give it room; the stop is $${fmt(stop)}.`, 'fresh');
  if (price < buy && price - stop < R * 0.3) return V('WATCH', 'medium', `$${fmt(price)} is ${(((price - stop) / stop) * 100).toFixed(1)}% above the stop ($${fmt(stop)}). Decision imminent — do not move the stop down.`, 'near_stop');
  if (price > buy && target - price < R * 0.5) return V('WATCH', 'low', `Approaching target ($${fmt(target)}). Be ready to sell half.`, 'near_target');
  return V('HOLD', 'low', `Developing (${gainR >= 0 ? '+' : ''}${gainR.toFixed(1)}R, session ${sessionsHeld}${a ? `, setup ${a.setup}` : ''}). Stop $${fmt(stop)}, target $${fmt(target)}.`, 'hold');
}

function fmt(x) { return x >= 1000 ? Math.round(x).toLocaleString('en-US') : x >= 1 ? x.toFixed(2) : Number(x).toPrecision(3); }

/** Which verdicts are worth a notification, and how often. SELL/TRIM: once per rule per day. WATCH: once per rule. */
export function alertKey(pos, v) {
  const day = tradingDateISO();
  if (v.action === 'SELL' || v.action === 'TRIM') return `${pos.id}:${v.rule}:${day}`;
  if (v.action === 'WATCH') return `${pos.id}:${v.rule}`;
  if (v.rule === 'trail_1r' || v.rule === 'trail_be') return `${pos.id}:${v.rule}`;   // "move your stop" is worth saying once
  return null;
}

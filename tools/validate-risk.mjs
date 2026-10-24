// Re-runnable check of the risk engine and journal arithmetic (risk.js).
// Pure functions, no network:  npm run validate:risk
import { riskBudget, journalStats, closeTrade, LIMITS } from '../risk.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const today = new Date().toISOString().slice(0, 10);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

// ── closeTrade: R-multiple, P&L, options multiplier ──
const t1 = closeTrade({ id: 'a', ticker: 'NVDA', qty: 10, buyPrice: 100, buyDate: '2026-10-01', stop: 95 }, { exitPrice: 110, exitDate: '2026-10-23', rule: 'target' });
check('R-multiple = (exit − entry) / (entry − stop)', t1.r === 2 && t1.pl === 100 && t1.daysHeld === 22, `r=${t1.r} pl=${t1.pl} days=${t1.daysHeld}`);
const t2 = closeTrade({ id: 'o', ticker: 'NVDA260117C00200000', qty: 2, buyPrice: 6.85, buyDate: '2026-10-01', isOption: true, multiplier: 100 }, { exitPrice: 3.4, exitDate: '2026-10-10' });
check('Option close: −50% premium ≈ −1R, P&L × 100 multiplier', near(t2.r, -1.01, 0.02) && near(t2.pl, -690, 0.01), `r=${t2.r} pl=${t2.pl}`);
const t3 = closeTrade({ id: 'c', ticker: 'BTC', qty: 0.1, buyPrice: 60000, buyDate: '2026-10-01', assetClass: 'crypto' }, { exitPrice: 55800, exitDate: '2026-10-05' });
check('Crypto default stop −7% → exit at −7% is −1R', near(t3.r, -1, 0.01), `r=${t3.r}`);

// ── journalStats ──
const J = [t1, { ...t1, id: 'b', r: -1, pl: -50 }, { ...t1, id: 'c', r: 2.5, pl: 125 }, { ...t1, id: 'd', r: 0, pl: 0 }];
const s = journalStats(J);
check('Win rate counts only |R| > 0.05 as win/loss', s.wins === 2 && s.losses === 1 && s.scratches === 1 && s.winRate === 50, JSON.stringify({ wins: s.wins, losses: s.losses, scratches: s.scratches }));
check('Expectancy = mean R', near(s.expectancyR, (2 - 1 + 2.5 + 0) / 4, 0.01), `${s.expectancyR}`);
check('Profit factor = gross win / gross loss', near(s.profitFactor, 225 / 50, 0.01), `${s.profitFactor}`);
check('Standard error reported for the confidence note', s.expectancySE > 0, `±${s.expectancySE}`);
check('Empty journal → nulls, not NaN', journalStats([]).expectancyR === null && journalStats([]).winRate === null);

// ── riskBudget ──
const P = [{ id: 'a', ticker: 'NVDA', qty: 10, buyPrice: 100, buyDate: '2026-10-01', stop: 95 }, { id: 'b', ticker: 'AAPL', qty: 20, buyPrice: 200, buyDate: '2026-10-20', planStop: 190 }];
const b0 = riskBudget({ capital: 10000, positions: [], journal: [] });
check('Empty book: OPEN, 6 slots, 1% room', b0.gate === 'OPEN' && b0.slots === 6 && b0.roomRiskPct === 1 && b0.roomRiskDollars === 100);
const b1 = riskBudget({ capital: 10000, positions: P, prices: { a: 100, b: 204 }, journal: [] });
check('Heat = Σ(price − stop) × qty: (5×10 + 14×20) = 330 = 3.3%', near(b1.openRiskPct, 3.3), `${b1.openRiskPct}%`);
check('Heat 3.3% of 5% → room capped at 1% → OPEN', b1.gate === 'OPEN' && b1.roomRiskPct === 1);
check('Largest-name warning at 40.8% notional', b1.warnings.some(w => w.rule === 'concentration') && b1.largest.ticker === 'AAPL');
const b2 = riskBudget({ capital: 10000, positions: P, prices: { a: 100, b: 204 }, journal: [{ exitDate: today, pl: -250 }] });
check('−2.5% day: room = 3 − 2.5 = 0.5% → REDUCED, sizeMult 0.5', b2.gate === 'REDUCED' && near(b2.roomRiskPct, 0.5) && near(b2.sizeMult, 0.5), `${b2.gate} room ${b2.roomRiskPct} mult ${b2.sizeMult}`);
check('Half-daily-limit warning fires at −2.5%', b2.warnings.some(w => w.rule === 'daily_loss_half'));
const b3 = riskBudget({ capital: 10000, positions: [], journal: [{ exitDate: today, pl: -300 }] });
check('−3.0% day → BLOCKED (daily_loss)', b3.gate === 'BLOCKED' && b3.breaches[0]?.rule === 'daily_loss');
const b4 = riskBudget({ capital: 10000, positions: Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, ticker: 'T' + i, qty: 1, buyPrice: 100, buyDate: '2026-10-20', stop: 99 })), journal: [] });
check('6 positions → BLOCKED (positions)', b4.gate === 'BLOCKED' && b4.breaches[0]?.rule === 'positions');
const b5 = riskBudget({ capital: 10000, positions: [{ id: 'h', ticker: 'X', qty: 100, buyPrice: 100, buyDate: '2026-10-20', stop: 95 }], prices: { h: 100 }, journal: [] });
check('Heat 5% → BLOCKED (heat)', b5.gate === 'BLOCKED' && b5.breaches[0]?.rule === 'heat', `${b5.openRiskPct}%`);
const b6 = riskBudget({ capital: 10000, positions: [{ id: 'h', ticker: 'X', qty: 100, buyPrice: 100, buyDate: '2026-10-20', stop: 95 }], prices: { h: 94 }, journal: [] });
check('Price below stop → that position carries 0 risk (it should already be sold)', b6.openRisk === 0);
check('Yesterday\'s loss does not count toward today', riskBudget({ capital: 10000, positions: [], journal: [{ exitDate: '2026-01-01', pl: -900 }] }).gate === 'OPEN');
check('LIMITS exported and sane', LIMITS.riskPerTradePct === 1 && LIMITS.dailyLossPct === 3 && LIMITS.maxOpenRiskPct === 5 && LIMITS.maxPositions === 6);

// ── The initial stop defines R even after the stop is trailed (the critical review finding) ──
{
  const { positionVerdict } = await import('../exits.js');
  const pos = { id: 't', ticker: 'NVDA', qty: 10, buyPrice: 100, buyDate: '2026-10-01', planStop: 95, stop: 100 };   // trailed to breakeven
  const v = positionVerdict(pos, { price: 104 });
  check('Trailed-to-breakeven stop: R still 5 (from the initial stop), target still 112.5', near(v.R, 5, 0.01) && near(v.target, 112.5, 0.01) && v.action !== 'TRIM', `R=${v.R} target=${v.target} ${v.action}`);
  const tj = closeTrade(pos, { exitPrice: 104, exitDate: today });
  check('Journal R after trailing = +0.8R, not +∞', near(tj.r, 0.8, 0.01), `r=${tj.r}`);
  const v2 = positionVerdict({ ...pos, stop: 99 }, { price: 98 });
  check('Active (trailed) stop still triggers the SELL', v2.action === 'SELL' && v2.rule === 'stop');
  const stress = { level: 'stress', vix: 28 };
  check('STRESS regime: losing position → SELL', positionVerdict({ ...pos, stop: 95 }, { price: 97, regime: stress }).rule === 'regime');
  check('STRESS regime: winning position → WATCH, move stop to breakeven', positionVerdict({ ...pos, stop: 95 }, { price: 103, regime: stress }).rule === 'regime_stress');
  check('CRISIS regime → SELL regardless', positionVerdict({ ...pos, stop: 95 }, { price: 103, regime: { level: 'crisis', vix: 40 } }).rule === 'regime');
  check('Metals exempt from the regime rule', positionVerdict({ ...pos, ticker: 'GC=F', assetClass: 'metal', stop: 98 }, { price: 103, regime: { level: 'crisis', vix: 40 } }).rule !== 'regime');
  check('No capital set → BLOCKED with a reason, not an explosion', riskBudget({ capital: 0, positions: [], journal: [] }).breaches[0]?.rule === 'capital');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

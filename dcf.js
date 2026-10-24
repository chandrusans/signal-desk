// Signal Desk — a forward DCF whose every assumption is visible and editable.
//
// The Research tab already runs the DCF backwards (what growth today's price implies).
// This runs it forwards, the way a banker's model does: five years of revenue and
// margin, free cash flow year by year, a WACC built from the risk-free rate, the stock's
// beta and its cost of debt, a terminal value by BOTH perpetuity growth and exit multiple,
// and a sensitivity grid. Defaults come from the company's own filed history; the user
// can change any of them and the page recomputes. It is arithmetic, not a forecast: the
// verdict is only as good as the assumptions printed next to it.

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const cagr = (a, b, n) => (a > 0 && b > 0 && n > 0 ? Math.pow(b / a, 1 / n) - 1 : null);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** Build default assumptions from the forensic module's `years` (oldest → latest) and market inputs. */
export function defaultAssumptions({ years = [], price, marketCap, beta, riskFreePct, medianEvEbitda } = {}) {
  const Y = years.filter((y) => y.revenue > 0);
  const last = Y[Y.length - 1] || {};
  const first = Y[0] || {};
  const n = Y.length - 1;
  const revCagr = cagr(first.revenue, last.revenue, n);
  // Growth: start at the trailing CAGR (capped at 25%, floored at −5%), fade linearly to the terminal rate.
  const g1 = revCagr == null ? 0.05 : clamp(revCagr, -0.05, 0.25);
  const om = avg(Y.slice(-3).map((y) => (y.opIncome != null ? y.opIncome / y.revenue : null)).filter((x) => x != null)) ?? 0.15;
  const taxRate = (() => { const v = Y.slice(-3).map((y) => (y.pretax > 0 && y.tax != null ? y.tax / y.pretax : null)).filter((x) => x != null && x >= 0 && x <= 0.5); return v.length ? avg(v) : 0.21; })();
  const daPct = avg(Y.slice(-3).map((y) => (y.ebitda != null && y.opIncome != null ? (y.ebitda - y.opIncome) / y.revenue : null)).filter((x) => x != null)) ?? 0.04;
  const capexPct = avg(Y.slice(-3).map((y) => (y.capex != null ? y.capex / y.revenue : null)).filter((x) => x != null)) ?? 0.05;
  const nwcPct = 0.02;                                   // working capital tied up per $ of NEW revenue — a conservative default
  const rf = riskFreePct != null ? riskFreePct / 100 : 0.045;
  const b = beta != null && isFinite(beta) && beta > 0 ? clamp(beta, 0.5, 2.5) : 1.1;
  const erp = 0.05;                                      // equity risk premium — the long-run US figure most practitioners use
  const costEquity = rf + b * erp;
  const debt = last.debt || 0, cash = last.cash || 0;
  const costDebt = debt > 0 && last.interest > 0 ? clamp(last.interest / debt, rf, rf + 0.06) : rf + 0.015;
  const E = marketCap || (price && last.shares ? price * last.shares : 0);
  const wD = E + debt > 0 ? debt / (E + debt) : 0;
  const wacc = clamp((1 - wD) * costEquity + wD * costDebt * (1 - taxRate), 0.06, 0.15);
  return {
    years: 5,
    revenue0: last.revenue, growthStart: +g1.toFixed(4), growthTerminal: 0.03,
    operatingMargin: +clamp(om, -0.2, 0.6).toFixed(4), taxRate: +taxRate.toFixed(4), daPct: +daPct.toFixed(4), capexPct: +capexPct.toFixed(4), nwcPct,
    riskFree: +rf.toFixed(4), beta: +b.toFixed(2), equityRiskPremium: erp, costOfDebt: +costDebt.toFixed(4), debtWeight: +wD.toFixed(4), wacc: +wacc.toFixed(4),
    exitMultiple: medianEvEbitda != null && medianEvEbitda > 0 ? +clamp(medianEvEbitda, 4, 25).toFixed(1) : 12,
    netDebt: debt - cash, shares: last.shares || null,
    basis: { revenueCagrPct: revCagr != null ? +(revCagr * 100).toFixed(1) : null, historyYears: n },
  };
}

/** Run the model. Returns the year table, both terminal values, per-share values and a verdict. */
export function runDcf(a, price) {
  const N = a.years || 5;
  const rows = [];
  let rev = a.revenue0;
  const fcfs = [];
  for (let t = 1; t <= N; t++) {
    const g = a.growthStart + (a.growthTerminal - a.growthStart) * ((t - 1) / Math.max(1, N - 1));   // linear fade
    const prev = rev; rev = prev * (1 + g);
    const ebit = rev * a.operatingMargin;
    const nopat = ebit * (1 - a.taxRate);
    const da = rev * a.daPct, capex = rev * a.capexPct, dNwc = (rev - prev) * a.nwcPct;
    const fcf = nopat + da - capex - dNwc;
    const df = 1 / Math.pow(1 + a.wacc, t);
    rows.push({ year: t, growth: g, revenue: rev, ebit, nopat, da, capex, dNwc, fcf, discountFactor: df, pv: fcf * df });
    fcfs.push(fcf);
  }
  const lastRow = rows[N - 1];
  const pvFcf = rows.reduce((s, r) => s + r.pv, 0);
  const tvPerp = a.wacc > a.growthTerminal ? (lastRow.fcf * (1 + a.growthTerminal)) / (a.wacc - a.growthTerminal) : null;
  const ebitdaN = lastRow.ebit + lastRow.da;
  const tvExit = ebitdaN * a.exitMultiple;
  const dfN = lastRow.discountFactor;
  const ev = (tv) => (tv == null ? null : pvFcf + tv * dfN);
  const perShare = (evv) => (evv == null || !a.shares ? null : (evv - a.netDebt) / a.shares);
  const evPerp = ev(tvPerp), evExit = ev(tvExit);
  const psPerp = perShare(evPerp), psExit = perShare(evExit);
  const mid = psPerp != null && psExit != null ? (psPerp + psExit) / 2 : psPerp ?? psExit;
  const upside = mid != null && price > 0 ? (mid / price - 1) * 100 : null;
  const verdict = upside == null ? 'N/A' : upside > 20 ? 'UNDERVALUED' : upside < -20 ? 'OVERVALUED' : 'FAIRLY VALUED';
  const tvShare = evPerp ? (tvPerp * dfN) / evPerp : null;
  return {
    rows, pvFcf, terminal: { perpetuity: tvPerp, exitMultiple: tvExit, impliedExitMultipleFromPerp: tvPerp != null && ebitdaN > 0 ? tvPerp / ebitdaN : null, impliedGrowthFromExit: lastRow.fcf > 0 && tvExit > 0 ? (tvExit * a.wacc - lastRow.fcf) / (tvExit + lastRow.fcf) : null },
    enterpriseValue: { perpetuity: evPerp, exitMultiple: evExit }, perShare: { perpetuity: psPerp, exitMultiple: psExit, midpoint: mid },
    price, upsidePct: upside, verdict, terminalShareOfValue: tvShare,
  };
}

/** Fair value per share across a WACC × terminal-growth grid (perpetuity method). */
export function sensitivity(a, price, { waccSteps = [-0.02, -0.01, 0, 0.01, 0.02], gSteps = [-0.01, -0.005, 0, 0.005, 0.01] } = {}) {
  const waccs = waccSteps.map((d) => +(a.wacc + d).toFixed(4));
  const gs = gSteps.map((d) => +(a.growthTerminal + d).toFixed(4));
  const grid = waccs.map((w) => gs.map((g) => { const r = runDcf({ ...a, wacc: w, growthTerminal: g }, price); return r.perShare.perpetuity; }));
  return { waccs, gs, grid };
}

/** Which assumptions move the answer most: ±10% relative shock on each, midpoint value change. */
export function breakers(a, price) {
  const base = runDcf(a, price).perShare.midpoint;
  if (base == null) return [];
  const keys = [['growthStart', 'revenue growth (year 1)'], ['operatingMargin', 'operating margin'], ['wacc', 'discount rate (WACC)'], ['growthTerminal', 'terminal growth'], ['exitMultiple', 'exit multiple'], ['capexPct', 'capex % of revenue'], ['taxRate', 'tax rate']];
  return keys.map(([k, label]) => {
    const up = runDcf({ ...a, [k]: a[k] * 1.1 }, price).perShare.midpoint, dn = runDcf({ ...a, [k]: a[k] * 0.9 }, price).perShare.midpoint;
    return { key: k, label, swingPct: up != null && dn != null ? +((Math.abs(up - dn) / 2 / base) * 100).toFixed(1) : null };
  }).filter((x) => x.swingPct != null).sort((x, y) => y.swingPct - x.swingPct);
}

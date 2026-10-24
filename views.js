// Signal Desk — Research sub-views: peer comparison, dividend blueprint, allocation plan.
// Pure rendering + arithmetic; data arrives from the page. Every rule used is printed.
import { esc, money, pct, num, big, parseNum } from './ui.js';

const r1 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(1));

// ── Compare ──────────────────────────────────────────────────────────────────
/** rows: [{ticker, forensic, summary, profile}] */
export function renderCompare(rows) {
  const ok = rows.filter((r) => r.forensic && !r.forensic.error);
  if (!ok.length) return `<div class="sec"><p class="na">None of the tickers returned filings.</p></div>`;
  const L = (r) => r.forensic.years[r.forensic.years.length - 1] || {};
  const metric = (label, fn, fmt, best = 'high', note = '') => {
    const vals = ok.map((r) => { try { return fn(r); } catch { return null; } });
    const valid = vals.filter((v) => v != null && isFinite(v));
    const bestV = valid.length ? (best === 'high' ? Math.max(...valid) : Math.min(...valid)) : null;
    return `<tr><td>${esc(label)}${note ? `<br/><span class="na">${esc(note)}</span>` : ''}</td>${vals.map((v) => `<td class="${v != null && v === bestV && valid.length > 1 ? 'up' : ''}">${v == null ? '—' : fmt(v)}</td>`).join('')}</tr>`;
  };
  const text = (label, fn) => `<tr><td>${esc(label)}</td>${ok.map((r) => { let v; try { v = fn(r); } catch { v = null; } return `<td>${v == null ? '—' : esc(v)}</td>`; }).join('')}</tr>`;
  const rnd = (r) => { const y = L(r), a = r.forensic.allocation?.years?.slice(-1)[0]; return y.revenue > 0 && a?.rnd ? (a.rnd / y.revenue) * 100 : null; };
  const nde = (r) => { const y = L(r); return y.debt != null && y.ebitda > 0 ? (y.debt - (y.cash || 0)) / y.ebitda : null; };
  // "Best by the numbers": rank sum across the measurable quality + value metrics
  const score = ok.map((r) => {
    const y = L(r), V = r.forensic.valuation;
    const parts = [
      { v: y.roic ?? y.roce, high: true }, { v: y.gm, high: true }, { v: V.current.fcfYieldPct, high: true }, { v: V.revenueCagr, high: true },
      { v: r.forensic.moat?.score, high: true }, { v: nde(r), high: false }, { v: r.forensic.credibility?.score, high: true },
    ];
    return { r, parts };
  });
  const ranks = score.map(() => 0);
  for (let p = 0; p < 7; p++) {
    const col = score.map((s, i) => ({ i, v: s.parts[p].v })).filter((x) => x.v != null && isFinite(x.v));
    col.sort((a, b) => (score[0].parts[p].high ? b.v - a.v : a.v - b.v));
    col.forEach((x, pos) => { ranks[x.i] += pos; });
    score.forEach((s, i) => { if (s.parts[p].v == null) ranks[i] += col.length; });
  }
  const order = score.map((s, i) => ({ t: s.r.ticker, rank: ranks[i] })).sort((a, b) => a.rank - b.rank);
  const win = ok.find((r) => r.ticker === order[0].t);
  const wy = L(win), wV = win.forensic.valuation;
  return `<div class="sec"><div class="step"><span class="n">8</span><h3>Competitive landscape</h3><span class="sub">${ok.length} companies side by side from their own filings</span></div>
    <div class="tbl-wrap"><table class="r"><thead><tr><th>Metric</th>${ok.map((r) => `<th>${esc(r.ticker)}<br/><span class="na" style="font-style:normal">${esc((r.profile?.name || r.forensic.name || '').slice(0, 22))}</span></th>`).join('')}</tr></thead><tbody>
      ${metric('Market cap', (r) => r.summary?.marketCapRaw ?? r.forensic.valuation.marketCap, big)}
      ${metric('Revenue (latest FY)', (r) => L(r).revenue, big)}
      ${metric('Revenue CAGR', (r) => r.forensic.valuation.revenueCagr, (v) => pct(v), 'high', '5 yrs')}
      ${metric('Gross margin', (r) => L(r).gm, (v) => pct(v, 1, false))}
      ${metric('Operating margin', (r) => L(r).om, (v) => pct(v, 1, false))}
      ${metric('ROIC', (r) => L(r).roic ?? L(r).roce, (v) => pct(v, 1, false), 'high', 'ROCE where ROIC undefined')}
      ${metric('R&D % revenue', rnd, (v) => pct(v, 1, false))}
      ${metric('Free cash flow', (r) => L(r).fcf, big)}
      ${metric('Net debt / EBITDA', nde, (v) => v.toFixed(1) + '×', 'low')}
      ${metric('P/E (GAAP)', (r) => r.forensic.valuation.current.pe, (v) => v.toFixed(1) + '×', 'low')}
      ${metric('EV / EBITDA', (r) => r.forensic.valuation.current.evEbitda, (v) => v.toFixed(1) + '×', 'low')}
      ${metric('FCF yield', (r) => r.forensic.valuation.current.fcfYieldPct, (v) => pct(v, 2, false))}
      ${metric('Moat score', (r) => r.forensic.moat?.score, (v) => v + '/10')}
      ${metric('Credibility', (r) => r.forensic.credibility?.score, (v) => v + '/10', 'high', 'beats vs consensus')}
      ${text('Profits', (r) => r.forensic.cash.verdict)}
      ${text('Capital allocation', (r) => r.forensic.allocation.verdict)}
      ${text('Valuation vs own history', (r) => r.forensic.valuation.verdict)}
      ${text('Share count 5 yrs', (r) => (r.forensic.allocation.shareChangePct != null ? pct(r.forensic.allocation.shareChangePct) : null))}
    </tbody></table></div>
    <h4>Ranked by the numbers</h4>
    <p class="plain">${order.map((o, i) => `${i + 1}. <strong>${esc(o.t)}</strong>`).join(' · ')} — rank sum across ROIC, gross margin, FCF yield, revenue growth, moat, leverage and credibility (lower is better; a missing metric ranks last).</p>
    <p class="plain"><strong>${esc(win.ticker)}</strong> leads on the measurable set: ${wy.roic != null ? `ROIC ${r1(wy.roic)}%` : `ROCE ${r1(wy.roce)}%`}, gross margin ${r1(wy.gm)}%, revenue compounding ${pct(wV.revenueCagr)}/yr, ${wV.current.fcfYieldPct != null ? `FCF yield ${wV.current.fcfYieldPct}%` : 'FCF yield n/a'}, moat ${win.forensic.moat?.score ?? '—'}/10. That is "best business by the filings", which is not the same as "best stock to buy": price enters through FCF yield and EV/EBITDA above, and the catalysts, market-share trends, SWOT and management narrative are judgment calls the prompt below asks with these figures attached.</p>
    <button class="copy" data-copy="compare">Copy the comparison as a prompt</button></div>`;
}

export function comparePrompt(rows) {
  const ok = rows.filter((r) => r.forensic && !r.forensic.error);
  const L = (r) => r.forensic.years[r.forensic.years.length - 1] || {};
  const lines = ok.map((r) => { const y = L(r), V = r.forensic.valuation; return `${r.ticker} (${r.profile?.name || r.forensic.name}): mcap ${big(r.summary?.marketCapRaw ?? V.marketCap)}, revenue ${big(y.revenue)} (CAGR ${V.revenueCagr}%), GM ${y.gm}%, OM ${y.om}%, ROIC ${y.roic ?? y.roce}%, FCF ${big(y.fcf)}, net debt/EBITDA ${y.debt != null && y.ebitda > 0 ? ((y.debt - (y.cash || 0)) / y.ebitda).toFixed(1) : '?'}, P/E ${V.current.pe}, EV/EBITDA ${V.current.evEbitda}, FCF yield ${V.current.fcfYieldPct}%, moat ${r.forensic.moat?.score}/10, profits ${r.forensic.cash.verdict}, allocation ${r.forensic.allocation.verdict}, credibility ${r.forensic.credibility?.score}/10.`; });
  return `DATA (SEC 10-K filings, NASDAQ, as of ${new Date().toISOString().slice(0, 10)}):\n${lines.join('\n')}\n\nYou are analysing this competitive set for an investor. Using the data above plus what you know of these businesses: (1) market share trends over the last 3 years; (2) moat type for each — brand, cost, network, switching; (3) management quality from the capital-allocation record; (4) innovation pipeline versus R&D spend; (5) the biggest threats to the sector — regulation, disruption, macro; (6) SWOT for the top two; (7) your single best pick with a clear rationale and the catalysts that could move it in 12 months. State every assumption and say where the data does not support a conclusion.`;
}

// ── Dividends ─────────────────────────────────────────────────────────────────
export const DIVIDEND_UNIVERSE = ['JNJ', 'PG', 'KO', 'PEP', 'MCD', 'WMT', 'ABT', 'ABBV', 'XOM', 'CVX', 'MMM', 'CAT', 'ITW', 'EMR', 'GD', 'LMT', 'HD', 'LOW', 'TGT', 'COST', 'CL', 'KMB', 'CLX', 'GIS', 'HRL', 'SYY', 'ADP', 'PAYX', 'MSFT', 'AAPL', 'AVGO', 'TXN', 'QCOM', 'IBM', 'CSCO', 'VZ', 'T', 'PFE', 'MRK', 'LLY', 'AMGN', 'BMY', 'MDT', 'UNH', 'CVS', 'JPM', 'BAC', 'BLK', 'SPGI', 'MCO', 'TROW', 'BEN', 'O', 'PLD', 'AMT', 'DUK', 'SO', 'NEE', 'D', 'ED', 'WEC', 'PM', 'MO', 'UPS', 'UNP', 'APD', 'LIN', 'SHW', 'ECL', 'NUE', 'ADM', 'WM', 'RSG', 'HSY', 'MDLZ', 'KHC', 'GPC', 'SWK', 'AFL', 'CINF', 'CB', 'TRV', 'PNC', 'USB'];

/** Safety score 1–10 from payout ratio, yield sanity, earnings and valuation. Rules printed on the page. */
export function dividendSafety({ yieldPct, price, eps, pe, fcfPayoutPct, growthYears }) {
  if (!(yieldPct > 0) || !(price > 0)) return null;
  const dps = (yieldPct / 100) * price;
  const payout = eps > 0 ? (dps / eps) * 100 : null;
  let s = 5;
  if (payout == null) s -= 3; else if (payout <= 40) s += 3; else if (payout <= 60) s += 2; else if (payout <= 80) s += 0; else if (payout <= 100) s -= 2; else s -= 4;
  if (yieldPct > 7) s -= 2; else if (yieldPct > 5) s -= 1;
  if (eps != null && eps <= 0) s -= 3;
  if (pe != null && pe > 0 && pe < 30) s += 1;
  if (fcfPayoutPct != null) s += fcfPayoutPct <= 70 ? 1 : fcfPayoutPct > 100 ? -2 : 0;
  if (growthYears != null) s += growthYears >= 5 ? 1 : growthYears === 0 ? -1 : 0;
  return { score: Math.max(1, Math.min(10, Math.round(s))), payoutPct: payout != null ? r1(payout) : null, dps: +dps.toFixed(2) };
}

/** Consecutive fiscal years of rising dividends per share, from forensic allocation years (needs shares). */
export function dividendGrowthYears(forensic) {
  const ys = (forensic?.allocation?.years || []).map((y) => (y.dividends > 0 && y.shares > 0 ? y.dividends / y.shares : null));
  let n = 0;
  for (let i = ys.length - 1; i > 0; i--) { if (ys[i] != null && ys[i - 1] != null && ys[i] > ys[i - 1] * 1.001) n++; else break; }
  const first = ys.find((x) => x != null), last = [...ys].reverse().find((x) => x != null);
  const span = ys.filter((x) => x != null).length - 1;
  const cagr = first > 0 && last > 0 && span > 0 ? (Math.pow(last / first, 1 / span) - 1) * 100 : null;
  return { consecutive: n, dpsCagrPct: r1(cagr), measuredOver: ys.filter((x) => x != null).length };
}

export function renderDividends(picks, { amount = 100000, account = 'taxable', bracket = 22, incomeGoal = 0 } = {}) {
  const valid = picks.filter((p) => p.safety).sort((a, b) => b.safety.score - a.safety.score || b.yieldPct - a.yieldPct);
  if (!valid.length) return `<div class="sec"><p class="na">No dividend data returned.</p></div>`;
  const chosen = valid.slice(0, 20);
  const w = 1 / chosen.length;
  const portYield = chosen.reduce((s, p) => s + w * p.yieldPct, 0);
  const growth = (() => { const g = chosen.map((p) => p.growth?.dpsCagrPct).filter((x) => x != null && isFinite(x)); g.sort((a, b) => a - b); return g.length ? Math.max(0, Math.min(10, g[g.length >> 1])) : 5; })();
  const annual = amount * portYield / 100, monthly = annual / 12;
  const sectors = {}; for (const p of chosen) sectors[p.sector || 'Other'] = (sectors[p.sector || 'Other'] || 0) + w * 100;
  // DRIP: dividends reinvested, dividend grows at `growth`, price assumed to grow with dividends (yield constant) — stated
  let value = amount, income = annual; const drip = [];
  for (let y = 1; y <= 10; y++) { value = value * (1 + growth / 100) + income; income = value * portYield / 100; drip.push({ year: y, value, income }); }
  const qualifiedRate = bracket <= 12 ? 0 : bracket >= 35 ? 20 : 15;
  const tax = account === 'roth' ? 'Roth IRA: qualified dividends are not taxed, now or at withdrawal.' : account === 'ira' ? 'Traditional IRA / 401(k): no tax on dividends inside the account; withdrawals are taxed as ordinary income later.' : `Taxable: most of these pay QUALIFIED dividends, taxed at ${qualifiedRate}% for a ${bracket}% bracket (plus 3.8% NIIT above the income threshold). REITs (O, PLD, AMT) pay non-qualified income taxed at ${bracket}% — hold those in an IRA if you can.`;
  const needed = incomeGoal > 0 && portYield > 0 ? (incomeGoal * 12) / (portYield / 100) : null;
  return `<div class="sec"><div class="step"><span class="n">7</span><h3>Dividend blueprint</h3><span class="sub">${chosen.length} picks from a ${picks.length}-name quality-dividend universe, ranked safest first</span></div>
    <form id="div-form" style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 12px;" onsubmit="return false;">
      <label style="font-family:var(--mono);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;">investment $<input data-div="amount" type="number" step="1000" value="${amount}" style="width:120px;padding:6px;font-family:var(--mono);background:var(--ground);color:var(--ink);border:1px solid var(--rule);" /></label>
      <label style="font-family:var(--mono);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;">monthly income goal $<input data-div="incomeGoal" type="number" step="100" value="${incomeGoal}" style="width:120px;padding:6px;font-family:var(--mono);background:var(--ground);color:var(--ink);border:1px solid var(--rule);" /></label>
      <label style="font-family:var(--mono);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;">account<select data-div="account" style="padding:6px;font-family:var(--mono);background:var(--ground);color:var(--ink);border:1px solid var(--rule);"><option value="taxable" ${account === 'taxable' ? 'selected' : ''}>taxable</option><option value="ira" ${account === 'ira' ? 'selected' : ''}>IRA / 401(k)</option><option value="roth" ${account === 'roth' ? 'selected' : ''}>Roth</option></select></label>
      <label style="font-family:var(--mono);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;">tax bracket %<input data-div="bracket" type="number" step="1" value="${bracket}" style="width:80px;padding:6px;font-family:var(--mono);background:var(--ground);color:var(--ink);border:1px solid var(--rule);" /></label>
    </form>
    <div class="kv">
      <div class="c"><div class="l">Portfolio yield</div><div class="v">${portYield.toFixed(2)}%</div><div class="s">equal-weight across ${chosen.length} names</div></div>
      <div class="c"><div class="l">Income on ${money(amount, 0)}</div><div class="v">${money(monthly, 0)} / mo</div><div class="s">${money(annual, 0)} a year before tax</div></div>
      ${needed ? `<div class="c"><div class="l">Capital for ${money(incomeGoal, 0)} / mo</div><div class="v">${money(needed, 0)}</div><div class="s">at today's yield</div></div>` : ''}
      <div class="c"><div class="l">Dividend growth est.</div><div class="v">${growth.toFixed(1)}%/yr</div><div class="s">median filed DPS CAGR of the picks, capped 0–10%</div></div>
      <div class="c"><div class="l">Sectors</div><div class="v">${Object.keys(sectors).length}</div><div class="s">${Object.entries(sectors).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${esc(k)} ${v.toFixed(0)}%`).join(' · ')}</div></div>
    </div>
    <div class="tbl-wrap"><table class="r"><thead><tr><th>#</th><th>Ticker</th><th>Sector</th><th>Yield</th><th>Price</th><th>Payout (EPS)</th><th>Div / FCF 5y</th><th>Yrs of growth</th><th>DPS CAGR</th><th>P/E</th><th>Safety</th></tr></thead><tbody>
      ${chosen.map((p, i) => `<tr><td>${i + 1}</td><td><a href="?t=${esc(p.ticker)}" style="color:var(--accent)"><strong>${esc(p.ticker)}</strong></a></td><td>${esc(p.sector || '')}</td><td>${p.yieldPct.toFixed(2)}%</td><td>${money(p.price)}</td><td class="${p.safety.payoutPct > 80 ? 'down' : ''}">${p.safety.payoutPct != null ? p.safety.payoutPct + '%' : '—'}</td><td class="${p.fcfPayoutPct > 100 ? 'down' : ''}">${p.fcfPayoutPct != null ? p.fcfPayoutPct + '%' : '—'}</td><td>${p.growth ? `${p.growth.consecutive} of ${p.growth.measuredOver - 1}` : '—'}</td><td>${p.growth?.dpsCagrPct != null ? pct(p.growth.dpsCagrPct) : '—'}</td><td>${p.pe != null ? p.pe.toFixed(1) + '×' : '—'}</td><td style="color:${p.safety.score >= 8 ? 'var(--signal)' : p.safety.score >= 5 ? 'var(--caution)' : 'var(--risk)'}"><strong>${p.safety.score}/10</strong></td></tr>`).join('')}
    </tbody></table></div>
    <p class="na">Safety score: start at 5; payout of EPS ≤40% +3, ≤60% +2, ≤80% 0, ≤100% −2, above 100% −4; yield above 7% −2 (above 5% −1); negative earnings −3; P/E under 30 +1; dividends under 70% of free cash flow over five years +1 (over 100% −2); five or more consecutive years of DPS growth +1. "Years of growth" is counted from the company's own filings (dividends paid ÷ diluted shares), so it is capped by the six fiscal years read — a Dividend Aristocrat shows "5 of 5", not 40. Unsustainable flags: payout over 80% or dividends exceeding free cash flow.</p>
    <h4>Ten-year reinvestment projection (DRIP)</h4>
    <div class="tbl-wrap"><table class="r"><thead><tr><th>Year</th>${drip.map((d) => `<th>${d.year}</th>`).join('')}</tr></thead><tbody><tr><td>Portfolio value</td>${drip.map((d) => `<td>${money(d.value, 0)}</td>`).join('')}</tr><tr><td>Annual income</td>${drip.map((d) => `<td>${money(d.income, 0)}</td>`).join('')}</tr></tbody></table></div>
    <p class="na">Assumes dividends reinvested, dividends and prices both growing ${growth.toFixed(1)}%/yr so the yield stays ${portYield.toFixed(2)}%, no tax drag, no cuts. Every one of those is an assumption; the 2020 and 2008 dividend cuts are the reason the safety score exists.</p>
    <h4>Tax</h4><p class="plain">${esc(tax)}</p>
    <p class="na">This is a screen and a calculator over a fixed universe of long-record dividend payers, not a recommendation; yields come from NASDAQ as of now, payout from trailing GAAP EPS.</p>
    <button class="copy" data-copy="dividends">Copy as a prompt</button></div>`;
}

// ── Plan: allocation from stated rules ───────────────────────────────────────
const CLASSES = {
  usStock: { name: 'US total stock market', etf: 'VTI (or ITOT, SCHB)', ret: 10.0, sd: 17, worst: -37 },
  intlStock: { name: 'International developed + EM', etf: 'VXUS (or IXUS)', ret: 8.0, sd: 18, worst: -43 },
  bonds: { name: 'US aggregate bonds', etf: 'BND (or AGG)', ret: 4.5, sd: 5, worst: -13 },
  tips: { name: 'Inflation-protected Treasuries', etf: 'VTIP / SCHP', ret: 4.0, sd: 5, worst: -12 },
  cash: { name: 'T-bills / cash', etf: 'SGOV / BIL', ret: 3.0, sd: 1, worst: 0 },
  gold: { name: 'Gold', etf: 'IAU / GLDM', ret: 6.5, sd: 16, worst: -28 },
  momentum: { name: 'Signal Desk momentum sleeve (satellite)', etf: 'the Today tab picks, risk-engine sized', ret: 8.0, sd: 22, worst: -45 },
};
export function buildPlan({ age = 40, horizonYears = 20, tolerance = 'balanced', account = 'taxable', monthly = 1000, savings = 100000 } = {}) {
  let equity = Math.max(30, Math.min(90, 110 - age));
  equity += tolerance === 'aggressive' ? 10 : tolerance === 'conservative' ? -15 : 0;
  if (horizonYears < 5) equity = Math.min(equity, 40); else if (horizonYears < 10) equity = Math.min(equity, 60);
  equity = Math.max(20, Math.min(95, equity));
  const sat = tolerance === 'aggressive' ? 10 : tolerance === 'balanced' ? 5 : 0;
  const gold = tolerance === 'conservative' ? 5 : 5;
  const core = equity - sat;
  const alloc = { usStock: +(core * 0.7).toFixed(0), intlStock: +(core * 0.3).toFixed(0), momentum: sat, gold, bonds: 0, tips: 0, cash: 0 };
  const fixed = 100 - alloc.usStock - alloc.intlStock - alloc.momentum - alloc.gold;
  alloc.cash = Math.min(fixed, horizonYears < 5 ? 15 : 5);
  alloc.tips = Math.round((fixed - alloc.cash) * 0.3);
  alloc.bonds = fixed - alloc.cash - alloc.tips;
  const wsum = Object.values(alloc).reduce((a, b) => a + b, 0);
  const ret = Object.entries(alloc).reduce((s, [k, w]) => s + (w / 100) * CLASSES[k].ret, 0);
  const worst = Object.entries(alloc).reduce((s, [k, w]) => s + (w / 100) * CLASSES[k].worst, 0);
  const sd = Math.sqrt(Object.entries(alloc).reduce((s, [k, w]) => s + Math.pow((w / 100) * CLASSES[k].sd, 2), 0)) * 1.25;   // partial diversification, not zero correlation
  const bench = `${equity}% total-world stock index / ${100 - equity}% aggregate bond index`;
  return { alloc, equity, expectedReturnPct: +ret.toFixed(1), rangeLowPct: +(ret - sd).toFixed(1), rangeHighPct: +(ret + sd).toFixed(1), badYearPct: +worst.toFixed(0), benchmark: bench, wsum, inputs: { age, horizonYears, tolerance, account, monthly, savings } };
}
export function renderPlan(p) {
  const { alloc, inputs } = p;
  const rows = Object.entries(alloc).filter(([, w]) => w > 0).map(([k, w]) => ({ k, w, ...CLASSES[k] }));
  const coreSat = (k) => (k === 'momentum' ? 'satellite' : 'core');
  const loc = inputs.account === 'taxable' ? 'In a taxable account keep broad stock index funds here (low turnover, qualified dividends) and hold bonds, TIPS and the momentum sleeve in an IRA or 401(k) if you have one; harvest losses in down years.' : inputs.account === 'roth' ? 'A Roth is the best home for the highest-expected-growth sleeves (stocks, the momentum satellite); bonds belong in a traditional IRA or 401(k) if you also have one.' : 'Tax-deferred: hold the bond and TIPS sleeve and the momentum satellite here; rebalancing is free of tax consequences, so rebalance on the band rule without hesitation.';
  const ips = `INVESTMENT POLICY STATEMENT — ${new Date().toISOString().slice(0, 10)}
Purpose: grow ${money(inputs.savings, 0)} plus ${money(inputs.monthly, 0)}/month for a ${inputs.horizonYears}-year horizon with ${inputs.tolerance} risk tolerance, in a ${inputs.account} account.
Target allocation: ${rows.map((r) => `${r.w}% ${r.name} (${r.etf.split(' ')[0]})`).join('; ')}.
Rebalance: review quarterly; trade only when a sleeve drifts 5 points from target or on the annual date; new contributions go to the most underweight sleeve first.
Expected: ${p.expectedReturnPct}%/yr long-run average (range roughly ${p.rangeLowPct}% to ${p.rangeHighPct}% in a typical year); a bad year of about ${p.badYearPct}% is within plan and is not a reason to sell.
Benchmark: ${p.benchmark}.
Rules I will keep: no single stock above 5% of the whole; the momentum sleeve is capped at ${alloc.momentum}% and run only by the Signal Desk rulebook with its risk engine; I do not change this allocation because of a headline, only at the annual review or a change in my circumstances.`;
  return `<div class="sec"><div class="step"><span class="n">5</span><h3>Allocation plan</h3><span class="sub">a policy statement from stated rules — a template, not advice</span></div>
    <form id="plan-form" style="display:flex;flex-wrap:wrap;gap:10px;margin:0 0 12px;" onsubmit="return false;">
      ${[['age', 'age', 1], ['horizonYears', 'horizon (years)', 1], ['savings', 'savings $', 1000], ['monthly', 'monthly contribution $', 100]].map(([k, l, st]) => `<label style="font-family:var(--mono);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;">${l}<input data-plan="${k}" type="number" step="${st}" value="${inputs[k]}" style="width:120px;padding:6px;font-family:var(--mono);background:var(--ground);color:var(--ink);border:1px solid var(--rule);" /></label>`).join('')}
      <label style="font-family:var(--mono);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;">risk tolerance<select data-plan="tolerance" style="padding:6px;font-family:var(--mono);background:var(--ground);color:var(--ink);border:1px solid var(--rule);">${['conservative', 'balanced', 'aggressive'].map((x) => `<option ${x === inputs.tolerance ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label style="font-family:var(--mono);font-size:11px;color:var(--ink-3);display:flex;flex-direction:column;">account<select data-plan="account" style="padding:6px;font-family:var(--mono);background:var(--ground);color:var(--ink);border:1px solid var(--rule);">${[['taxable', 'taxable'], ['ira', 'IRA / 401(k)'], ['roth', 'Roth']].map(([v, l]) => `<option value="${v}" ${v === inputs.account ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </form>
    <div class="kv">
      <div class="c"><div class="l">Stocks / bonds / other</div><div class="v">${p.equity} / ${alloc.bonds + alloc.tips + alloc.cash} / ${alloc.gold}</div><div class="s">rule: 110 − age, ±10 for tolerance, capped by horizon</div></div>
      <div class="c"><div class="l">Expected return</div><div class="v">${p.expectedReturnPct}%</div><div class="s">long-run average · typical year ${p.rangeLowPct}% to ${p.rangeHighPct}%</div></div>
      <div class="c"><div class="l">Bad year</div><div class="v" style="color:var(--risk)">${p.badYearPct}%</div><div class="s">weighted worst calendar years of each sleeve</div></div>
      <div class="c"><div class="l">Benchmark</div><div class="v" style="font-size:12px">${esc(p.benchmark)}</div></div>
    </div>
    <div class="tbl-wrap"><table class="r"><thead><tr><th>Sleeve</th><th>Role</th><th>Weight</th><th>Example funds</th><th>Monthly $</th><th>Long-run return</th><th>Worst year</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${coreSat(r.k)}</td><td><strong>${r.w}%</strong></td><td>${esc(r.etf)}</td><td>${money(inputs.monthly * r.w / 100, 0)}</td><td>${r.ret}%</td><td class="down">${r.worst}%</td></tr>`).join('')}
    </tbody></table></div>
    <p class="plain"><strong>Pie:</strong> ${rows.map((r) => `${r.w}% ${esc(r.name.toLowerCase())}`).join(', ')}.</p>
    <h4>Rebalancing · tax · contributions</h4>
    <ul><li>Review quarterly, trade only when a sleeve is 5 points off target or at the annual date; send each month's ${money(inputs.monthly, 0)} to the most underweight sleeve first (that is the dollar-cost-averaging plan).</li><li>${esc(loc)}</li><li>The momentum satellite is the only active sleeve; it is sized by the risk engine (1% per trade, 5% heat) inside its ${alloc.momentum}% cap, and the Simulate tab shows what it has returned historically.</li></ul>
    <h4>One-page investment policy statement</h4>
    <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;border:1px solid var(--rule);padding:12px;background:var(--ground);">${esc(ips)}</pre>
    <p class="na">Return and worst-year figures are approximate long-run averages for each asset class (US stocks ~10%/yr, worst −37% in 2008; aggregate bonds ~4.5%, worst −13% in 2022; gold ~6.5%, worst −28%), blended by weight — history, not a forecast, and the blend's bad year could be worse when everything falls together as in 2022. This page builds a policy from rules you can see; it does not know your full situation and is not individual advice.</p>
    <button class="copy" data-copy="plan">Copy the policy statement</button></div>`;
}
export { CLASSES };

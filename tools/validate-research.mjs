// Re-runnable check of the Research tab's forensic module against real SEC filers.
//   npm run validate:research      (needs network; the wrapper sets the macOS CA bundle)
import { forensic, impliedGrowth } from '../api/_forensic.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

// ── Pure math: the implied-growth solver inverts the DCF ──
{
  const fcf = 1e9, mcap = 25e9;
  const g = impliedGrowth(fcf, mcap) / 100;
  let v = 0, f = fcf; for (let t = 1; t <= 10; t++) { f *= 1 + g; v += f / Math.pow(1.1, t); } v += (f * 1.03 / 0.07) / Math.pow(1.1, 10);
  check('Implied growth solver reproduces the market cap', near(v, mcap, mcap * 0.001), `g=${(g * 100).toFixed(2)}% → value ${(v / 1e9).toFixed(3)}B vs ${mcap / 1e9}B`);
  check('Zero/negative FCF → no implied growth', impliedGrowth(-5, 100) === null && impliedGrowth(0, 100) === null);
}

// ── Apple: numbers match the FY2025 10-K ──
const aapl = await forensic('AAPL', { sector: 'Information Technology' });
const a25 = aapl.years?.find((y) => y.fy === '2025');
check('AAPL FY2025 net income = $112.010B as filed', near(a25?.netIncome, 112010e6, 1e6), `${a25?.netIncome}`);
check('AAPL FY2025 operating cash flow = $111.482B as filed', near(a25?.cfo, 111482e6, 1e6), `${a25?.cfo}`);
check('AAPL FY2025 diluted EPS = 7.46 as filed', near(a25?.eps, 7.46, 0.005), `${a25?.eps}`);
check('AAPL gross margin computed from revenue and gross profit (46.9%)', near(a25?.gm, 46.9, 0.2), `${a25?.gm}%`);
check('AAPL cash verdict REAL (ΣCFO/ΣNI ≈ 1.17× over 6 yrs)', aapl.cash.verdict === 'REAL' && aapl.cash.avgRatio > 1.0, `${aapl.cash.verdict} ${aapl.cash.avgRatio}×`);
check('AAPL working capital: negative cash conversion cycle (pays suppliers after collecting)', aapl.workingCapital.years.slice(-1)[0]?.ccc < 0, `CCC ${aapl.workingCapital.years.slice(-1)[0]?.ccc}d`);
check('AAPL share count fell over the window (buybacks)', aapl.allocation.shareChangePct < -5, `${aapl.allocation.shareChangePct}%`);
check('AAPL historical P/E all in 10–80× range', aapl.valuation.years.every((y) => y.pe == null || (y.pe > 10 && y.pe < 80)), aapl.valuation.years.map((y) => `${y.fy}:${y.pe}`).join(' '));
check('AAPL fair value has three anchors (P/E, P/FCF, EV/EBITDA)', aapl.synthesis.fairValue?.anchors?.length === 3);
// NASDAQ rate-limits a machine that has queried it heavily (HTTP 403 for a while); that is the source, not the app.
if (aapl.credibility.quarters.length >= 4) check('AAPL credibility from NASDAQ surprises (≥4 quarters)', aapl.credibility.score != null);
else console.log('NOTE  AAPL credibility: NASDAQ earnings-surprise returned nothing from this machine (rate limit) — skipped, not failed');

// ── Nvidia: tag switch and 2021 / 2024 splits ──
const nvda = await forensic('NVDA', { sector: 'Information Technology' });
const nLast = nvda.years[nvda.years.length - 1];
check('NVDA revenue present in the latest FY despite the XBRL tag switch', nLast.revenue > 100e9, `${nLast.fy}: ${nLast.revenue}`);
check('NVDA share count split-adjusted: change within ±30% over the window (raw data shows +877%)', Math.abs(nvda.allocation.shareChangePct) < 30, `${nvda.allocation.shareChangePct}% · adjusted ${nvda.splitsAdjusted.join(', ')}`);
check('NVDA diluted shares consistent across years (max/min < 1.5)', Math.max(...nvda.years.map((y) => y.shares)) / Math.min(...nvda.years.map((y) => y.shares)) < 1.5);
check('NVDA working capital days computed (DSO present)', nvda.workingCapital.years.slice(-1)[0]?.dso > 0);
check('NVDA CEO pay read from the DEF 14A proxy tag', nvda.pay.latest?.ceoPay > 1e6, `$${(nvda.pay.latest?.ceoPay / 1e6).toFixed(1)}M = ${nvda.pay.latest?.pctOfNetIncome}% of NI`);

// ── JPMorgan: a bank degrades honestly ──
const jpm = await forensic('JPM', { sector: 'Financials' });
check('JPM flagged as financial; cash / working capital / moat / allocation = N/A', jpm.isFinancial && jpm.cash.verdict === 'N/A' && jpm.workingCapital.verdict === 'N/A' && jpm.moat.verdict === 'N/A' && jpm.allocation.verdict === 'N/A');
check('JPM still gets P/E history', jpm.valuation.median5y.pe > 5, `median P/E ${jpm.valuation.median5y.pe}`);
if (jpm.credibility.quarters.length >= 4) check('JPM credibility score present', jpm.credibility.score != null); else console.log('NOTE  JPM credibility: NASDAQ surprise table empty from this machine (rate limit) — skipped');
check('JPM question is about credit quality, not margins', /credit|reserve|charge-off/i.test(jpm.synthesis.question));

// ── Review fixes: debt tags, EV, banks, loss-makers, predecessors ──
const avgo = await forensic('AVGO', { sector: 'Information Technology' });
const aLast = avgo.years[avgo.years.length - 1];
check('AVGO debt read across the 2021 tag switch (LongTermDebtNoncurrent → …AndCapitalLeaseObligations): $55–75B', aLast.debt > 55e9 && aLast.debt < 75e9, `$${(aLast.debt / 1e9).toFixed(1)}B`);
check('AVGO both pre-split years scaled by the filed 10:1 ratio (heuristic missed FY2020)', avgo.splitsAdjusted.length === 2 && avgo.splitsAdjusted.every((x) => /×10/.test(x)), avgo.splitsAdjusted.join(', '));
check('AVGO cash verdict REAL — cash far above profit (amortisation) is not an accrual flag', avgo.cash.verdict === 'REAL', `${avgo.cash.verdict} ${avgo.cash.avgRatio}×`);
const ko = await forensic('KO', { sector: 'Consumer Staples' });
const kLast = ko.years[ko.years.length - 1];
check('KO debt across its 2024 tag switch: $38–48B, current portion not double-counted', kLast.debt > 38e9 && kLast.debt < 48e9, `$${(kLast.debt / 1e9).toFixed(1)}B`);
check('KO working-capital note caveats payables-plus-accruals', /accrued/i.test(ko.workingCapital.note), ko.workingCapital.years.slice(-1)[0]?.dpo + 'd DPO');
check('AAPL EV nets noncurrent marketable securities (cash+securities > cash alone)', a25.cash > 50e9, `$${(a25.cash / 1e9).toFixed(1)}B`);
const ba = await forensic('BA', { sector: 'Industrials' });
check('BA (loss-making): cash verdict N/A, not MANUFACTURED? on one profitable year', ba.cash.verdict === 'N/A' && ba.valuation.verdict === 'N/A', `${ba.cash.verdict} / ${ba.valuation.verdict}`);
check('JPM valuation uses P/E only (no P/FCF or EV/EBITDA for a bank)', jpm.valuation.current.pfcf == null && jpm.valuation.current.evEbitda == null && jpm.valuation.median5y.pe > 5);
const xom = await forensic('XOM', { sector: 'Energy' });
check('XOM resolves to the predecessor filer when the mapped entity has no annual history', !xom.error && xom.predecessor && xom.years.length >= 5, xom.predecessor?.name || xom.error);
check('XOM EBIT derived from pre-tax income + interest (no operating-income tag)', xom.years.slice(-1)[0]?.opIncome > 0 && xom.valuation.current.evEbitda > 0, `EV/EBITDA ${xom.valuation.current.evEbitda}`);
check('ROIC uses average capital and is null where equity is depleted (never 500%)', [aapl, nvda, avgo, ko].every((f) => f.years.every((y) => y.roic == null || y.roic < 200)));
check('Historical price is the fiscal-year-end month close (AAPL FY2025 ends Sep-27 → Sep close ≈ $255, not Oct)', a25.price > 240 && a25.price < 275, `$${a25.price}`);

// ── Shape ──
for (const [t, f] of [['AAPL', aapl], ['NVDA', nvda], ['JPM', jpm]]) {
  check(`${t} response shape: verdicts, synthesis, sources, notAvailable`, ['cash', 'workingCapital', 'moat', 'allocation', 'valuation', 'credibility', 'pay', 'multibagger', 'synthesis'].every((k) => f[k]) && f.sources.length === 3 && f.notAvailable.length >= 4 && typeof f.synthesis.question === 'string');
}
check('Unknown ticker → explicit error, not a throw', (await forensic('ZZZZZZ')).error != null);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

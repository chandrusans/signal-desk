// Forensic fundamentals for one US-listed company, from primary sources only.
//
//   • SEC XBRL "companyfacts" — every number the company itself filed in its
//     10-Ks: revenue, net income, operating cash flow, capex, receivables,
//     inventory, payables, gross profit, D&A, dividends, buybacks,
//     acquisitions, debt, cash, equity, diluted EPS and share count, and
//     (since 2023) the CEO's total compensation.
//   • Yahoo monthly closes (6y) — to put a price next to each fiscal year so
//     the stock's OWN historical P/E, EV/EBITDA and P/FCF can be computed.
//   • NASDAQ summary — current market cap and trailing / forward P/E.
//   • NASDAQ earnings-surprise — the last eight quarters of EPS vs consensus,
//     the only free, structured proxy for management credibility.
//
// Everything below is arithmetic on filed numbers. The verdict words
// ("profits are real", "consuming cash", "value creators") are rules whose
// thresholds are stated in the handbook, not opinions.
//
// Not available free, and therefore NOT faked: earnings-call transcripts,
// customer-concentration percentages (10-K text, not tagged), segment detail,
// insider ownership percentages, peer ROCE tables.

const UA = 'Signal Desk research tool (contact: chandru.sans@gmail.com)';
const DAY = 86400000;

// ── Tag fallbacks: companies tag the same concept differently across years ──
const TAGS = {
  revenue:     ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense'],
  netIncome:   ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  cfo:         ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex:       ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'],
  cogs:        ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'],
  grossProfit: ['GrossProfit'],
  opIncome:    ['OperatingIncomeLoss'],
  da:          ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'Depreciation'],
  dividends:   ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock', 'PaymentsOfOrdinaryDividends'],
  buybacks:    ['PaymentsForRepurchaseOfCommonStock'],
  acquisitions:['PaymentsToAcquireBusinessesNetOfCashAcquired', 'PaymentsToAcquireBusinessesGross'],
  rnd:         ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'],
  sbc:         ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
  eps:         ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
  shares:      ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted', 'WeightedAverageNumberOfSharesOutstandingBasic'],
  tax:         ['IncomeTaxExpenseBenefit'],
  pretax:      ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  interest:    ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt'],
  // balance sheet (instant)
  ar:          ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
  inventory:   ['InventoryNet', 'InventoryFinishedGoodsNetOfReserves'],
  ap:          ['AccountsPayableCurrent', 'AccountsPayableAndAccruedLiabilitiesCurrent'],
  debtLT:      ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'],
  debtST:      ['DebtCurrent', 'LongTermDebtCurrent', 'ShortTermBorrowings', 'CommercialPaper'],
  cash:        ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'],
  stInvest:    ['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  assets:      ['Assets'],
  curLiab:     ['LiabilitiesCurrent'],
  equity:      ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  goodwill:    ['Goodwill'],
};
const INSTANT = new Set(['ar', 'inventory', 'ap', 'debtLT', 'debtST', 'cash', 'stInvest', 'assets', 'curLiab', 'equity', 'goodwill']);
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT', '20-F', '40-F']);

let cikCache = null, cikAt = 0;
async function cikFor(ticker) {
  if (!cikCache || Date.now() - cikAt > 6 * 3600e3) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`SEC ticker map ${r.status}`);
    const d = await r.json();
    const m = {};
    for (const v of Object.values(d)) m[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, '0');
    cikCache = m; cikAt = Date.now();
  }
  return cikCache[ticker] || cikCache[ticker.replace('.', '-')] || cikCache[ticker.replace('-', '.')] || null;
}

/** Fiscal-year values keyed by period end. All fallback tags are MERGED (companies
 *  switch tags between years — Nvidia moved from RevenueFromContract… to Revenues in
 *  2022), and for each year the latest-filed value wins, so restatements and
 *  split-adjusted comparatives replace the originals. */
function series(facts, tags, instant, forms = ANNUAL_FORMS) {
  const byEnd = new Map();
  const used = new Set();
  for (const tag of tags) {
    const units = facts[tag]?.units; if (!units) continue;
    const unit = Object.keys(units).find((k) => /^USD|shares/.test(k)) || Object.keys(units)[0];
    for (const r of units[unit]) {
      if ((forms && !forms.has(r.form)) || r.val == null) continue;
      if (instant) { if (r.fp !== 'FY') continue; }
      else {
        if (!r.start) continue;
        const span = (Date.parse(r.end) - Date.parse(r.start)) / DAY;
        if (span < 350 || span > 380) continue;
      }
      const prev = byEnd.get(r.end);
      if (!prev || r.filed > prev.filed) { byEnd.set(r.end, r); used.add(tag); }
    }
  }
  return byEnd.size >= 2 ? { tag: [...used].join('+'), map: byEnd } : null;
}

/** Older 10-Ks report share counts and EPS before later stock splits. Walking back
 *  from the latest year, a jump of ≥1.8× between adjacent years is a split; the
 *  older years are scaled by the nearest plausible split ratio so share counts,
 *  EPS and (split-adjusted) prices line up. */
function adjustSplits(Y) {
  const RATIOS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 50];
  let f = 1;
  for (let i = Y.length - 2; i >= 0; i--) {
    const raw = Y[i].shares, next = Y[i + 1].shares;
    if (raw > 0 && next > 0) {
      const jump = next / (raw * f);
      if (jump >= 1.8) { const r = RATIOS.reduce((b, x) => (Math.abs(x - jump) < Math.abs(b - jump) ? x : b), RATIOS[0]); f *= r; Y[i].splitAdjusted = r; }
    }
    if (f !== 1) { if (Y[i].shares != null) Y[i].shares *= f; if (Y[i].eps != null) Y[i].eps /= f; }
  }
  return Y;
}

function nearest(map, end, tolDays = 12) {
  if (!map) return null;
  if (map.has(end)) return map.get(end).val;
  const t = Date.parse(end);
  let best = null, bd = Infinity;
  for (const [k, v] of map) { const d = Math.abs(Date.parse(k) - t) / DAY; if (d <= tolDays && d < bd) { bd = d; best = v.val; } }
  return best;
}

const r1 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(1));
const r2 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(2));
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const median = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const cagr = (a, b, n) => (a > 0 && b > 0 && n > 0 ? (Math.pow(b / a, 1 / n) - 1) * 100 : null);

async function fetchFacts(cik) {
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`SEC companyfacts ${r.status}`);
  return r.json();
}

async function fetchMonthly(ticker) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1mo&range=7y`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    const ts = res?.timestamp || [], c = res?.indicators?.quote?.[0]?.close || [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) if (c[i] != null) bars.push({ t: ts[i] * 1000, c: c[i] });
    return { bars, price: res?.meta?.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : null), name: res?.meta?.longName || res?.meta?.shortName || null };
  } catch { return null; }
}
function priceAt(monthly, end) {
  if (!monthly?.bars?.length) return null;
  const t = Date.parse(end);
  let best = null;
  for (const b of monthly.bars) { if (b.t <= t + 20 * DAY) best = b.c; else break; }
  return best;
}

async function fetchNasdaq(ticker) {
  const H = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'application/json' };
  const money = (s) => { if (s == null) return null; const n = parseFloat(String(s).replace(/[$,%]/g, '')); return isNaN(n) ? null : n; };
  const out = { marketCap: null, pe: null, forwardPE: null, eps: null, surprises: [] };
  await Promise.all([
    (async () => {
      try {
        const r = await fetch(`https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/summary?assetclass=stocks`, { headers: H });
        const s = (await r.json())?.data?.summaryData; if (!s) return;
        out.marketCap = money(s.MarketCap?.value); out.pe = money(s.PERatio?.value); out.forwardPE = money(s.ForwardPE1Yr?.value); out.eps = money(s.EarningsPerShare?.value);
      } catch {}
    })(),
    (async () => {
      try {
        const r = await fetch(`https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/earnings-surprise`, { headers: H });
        const rows = (await r.json())?.data?.earningsSurpriseTable?.rows || [];
        out.surprises = rows.slice(0, 8).map((x) => ({ q: x.fiscalQtrEnd, date: x.dateReported, eps: money(x.eps), est: money(x.consensusForecast), surprise: money(x.percentageSurprise) }));
      } catch {}
    })(),
  ]);
  return out;
}

/** Solve for the FCF growth rate that makes a 10-year DCF equal today's market cap. */
export function impliedGrowth(fcf, mcap, r = 0.10, gT = 0.03, N = 10) {
  if (!(fcf > 0) || !(mcap > 0)) return null;
  const value = (g) => { let v = 0, f = fcf; for (let t = 1; t <= N; t++) { f *= 1 + g; v += f / Math.pow(1 + r, t); } return v + (f * (1 + gT) / (r - gT)) / Math.pow(1 + r, N); };
  let lo = -0.5, hi = 1.5;
  if (value(lo) > mcap) return lo * 100;
  if (value(hi) < mcap) return hi * 100;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (value(mid) < mcap) lo = mid; else hi = mid; }
  return ((lo + hi) / 2) * 100;
}

export async function forensic(ticker, { sector = null } = {}) {
  const cik = await cikFor(ticker);
  if (!cik) return { ticker, error: 'not an SEC filer (no CIK) — foreign ADRs without 20-F/40-F and funds are not covered' };
  const [factsDoc, monthly, nasdaq] = await Promise.all([fetchFacts(cik), fetchMonthly(ticker), fetchNasdaq(ticker)]);
  const gaap = factsDoc.facts?.['us-gaap'] || {};
  const ecd = factsDoc.facts?.['ecd'] || {};
  const S = {};
  for (const [k, tags] of Object.entries(TAGS)) S[k] = series(gaap, tags, INSTANT.has(k));
  S.ceoPay = series(ecd, ['PeoTotalCompAmt'], false, null);      // filed on DEF 14A proxies, not 10-Ks

  const anchor = S.netIncome || S.cfo || S.revenue;
  if (!anchor) return { ticker, cik, error: 'no annual income or cash-flow facts in SEC XBRL for this filer' };
  const ends = [...anchor.map.keys()].sort().slice(-6);
  const raw = ends.map((end) => {
    const g = (k) => nearest(S[k]?.map, end, 12);
    const y = { fy: end.slice(0, 4), end };
    for (const k of Object.keys(TAGS)) y[k] = g(k);
    y.ceoPay = nearest(S.ceoPay?.map, end, 400);     // pay-vs-performance table covers the year; dates vary
    return y;
  });
  adjustSplits(raw);
  const years = raw.map((y) => {
    const end = y.end;
    if (y.grossProfit == null && y.revenue != null && y.cogs != null) y.grossProfit = y.revenue - y.cogs;
    if (y.cogs == null && y.revenue != null && y.grossProfit != null) y.cogs = y.revenue - y.grossProfit;
    y.fcf = y.cfo != null ? y.cfo - (y.capex || 0) : null;
    y.ebitda = y.opIncome != null ? y.opIncome + (y.da || 0) : null;
    y.debt = (y.debtLT || 0) + (y.debtST || 0) || (y.debtLT == null && y.debtST == null ? null : 0);
    y.cashAll = (y.cash || 0) + (y.stInvest || 0) || (y.cash == null ? null : 0);
    y.gm = y.revenue > 0 && y.grossProfit != null ? (y.grossProfit / y.revenue) * 100 : null;
    y.om = y.revenue > 0 && y.opIncome != null ? (y.opIncome / y.revenue) * 100 : null;
    y.capEmployed = y.assets != null && y.curLiab != null ? y.assets - y.curLiab : null;
    y.roce = y.opIncome != null && y.capEmployed > 0 ? (y.opIncome / y.capEmployed) * 100 : null;
    const taxRate = y.pretax > 0 && y.tax != null ? Math.min(0.5, Math.max(0, y.tax / y.pretax)) : 0.21;
    const invested = y.equity != null ? y.equity + (y.debt || 0) - (y.cashAll || 0) : null;
    y.roic = y.opIncome != null && invested > 0 ? (y.opIncome * (1 - taxRate) / invested) * 100 : null;
    y.dso = y.revenue > 0 && y.ar != null ? (y.ar / y.revenue) * 365 : null;
    y.dio = y.cogs > 0 && y.inventory != null ? (y.inventory / y.cogs) * 365 : null;
    y.dpo = y.cogs > 0 && y.ap != null ? (y.ap / y.cogs) * 365 : null;
    y.ccc = y.dso != null ? y.dso + (y.dio || 0) - (y.dpo || 0) : null;
    y.price = priceAt(monthly, end);
    y.mcap = y.price != null && y.shares ? y.price * y.shares : null;
    y.pe = y.price != null && y.eps > 0 ? y.price / y.eps : null;
    y.evEbitda = y.mcap != null && y.ebitda > 0 ? (y.mcap + (y.debt || 0) - (y.cashAll || 0)) / y.ebitda : null;
    y.pfcf = y.mcap != null && y.fcf > 0 ? y.mcap / y.fcf : null;
    return y;
  });
  const Y = years.filter((y) => y.netIncome != null || y.cfo != null);
  const last = Y[Y.length - 1], first = Y[0];
  const n = Y.length;
  const isFinancial = /financ|bank|insur/i.test(sector || '') || (S.grossProfit == null && S.cogs == null && S.inventory == null && S.opIncome == null);

  // ── 1. CFO vs PAT ─────────────────────────────────────────────────────────
  const cash = { years: [], verdict: null, note: null };
  for (let i = 0; i < n; i++) {
    const y = Y[i], p = Y[i - 1];
    cash.years.push({
      fy: y.fy, netIncome: y.netIncome, cfo: y.cfo, fcf: y.fcf,
      ratio: y.netIncome > 0 && y.cfo != null ? r2(y.cfo / y.netIncome) : null,
      gap: y.netIncome != null && y.cfo != null ? y.netIncome - y.cfo : null,
      patUpCfoDown: !!(p && y.netIncome > p.netIncome && y.cfo < p.cfo),
      cfoNegPatPos: !!(y.cfo < 0 && y.netIncome > 0),
      accrualPct: y.netIncome != null && y.cfo != null && y.assets > 0 ? r1(((y.netIncome - y.cfo) / y.assets) * 100) : null,
    });
  }
  const ratios = cash.years.map((c) => c.ratio).filter((x) => x != null);
  const gaps = cash.years.map((c) => (c.gap != null && Y.find((y) => y.fy === c.fy)?.revenue > 0 ? c.gap / Y.find((y) => y.fy === c.fy).revenue : null)).filter((x) => x != null);
  cash.avgRatio = r2(ratios.length ? sum(ratios) / ratios.length : null);
  cash.gapTrend = gaps.length >= 4 ? r2((sum(gaps.slice(-2)) / 2 - sum(gaps.slice(0, 2)) / 2) * 100) : null;   // pct of revenue, + = widening
  cash.divergentYears = cash.years.filter((c) => c.patUpCfoDown).map((c) => c.fy);
  cash.negativeYears = cash.years.filter((c) => c.cfoNegPatPos).map((c) => c.fy);
  if (isFinancial) { cash.verdict = 'N/A'; cash.note = 'Banks and insurers: operating cash flow swings with deposits, trading books and reserves, so CFO vs net income says nothing about earnings quality. Use the credibility and valuation sections.'; }
  else if (!ratios.length) { cash.verdict = 'N/A'; cash.note = 'No usable cash-flow facts.'; }
  else if (cash.avgRatio >= 0.9 && !cash.negativeYears.length && !(cash.gapTrend > 3)) { cash.verdict = 'REAL'; cash.note = `Operating cash flow averaged ${cash.avgRatio}× reported profit over ${n} years. The profits are backed by cash.`; }
  else if (cash.avgRatio < 0.7 || cash.negativeYears.length || (cash.divergentYears.length >= 2 && cash.gapTrend > 0)) { cash.verdict = 'MANUFACTURED?'; cash.note = `Cash flow averaged only ${cash.avgRatio}× reported profit${cash.negativeYears.length ? `, and was negative in ${cash.negativeYears.join(', ')} while profits were positive` : ''}. Profit that does not arrive as cash is the classic accrual red flag (Sloan 1996: high-accrual firms underperform).`; }
  else { cash.verdict = 'WATCH'; cash.note = `Cash flow averaged ${cash.avgRatio}× profit${cash.gapTrend > 3 ? ' and the gap is widening' : ''}${cash.divergentYears.length ? `; profit rose while cash fell in ${cash.divergentYears.join(', ')}` : ''}. Not damning, but worth asking where the difference sits (receivables, inventory, capitalised costs).`; }

  // ── 2. Working capital ───────────────────────────────────────────────────
  const wc = { years: Y.map((y) => ({ fy: y.fy, dso: r1(y.dso), dio: r1(y.dio), dpo: r1(y.dpo), ccc: r1(y.ccc) })), verdict: null, note: null };
  const cccs = Y.map((y) => y.ccc).filter((x) => x != null);
  if (isFinancial || cccs.length < 3) { wc.verdict = 'N/A'; wc.note = isFinancial ? 'Working-capital days have no meaning for a balance-sheet business.' : 'Receivables / inventory / payables are not tagged consistently for this filer.'; }
  else {
    const d = cccs[cccs.length - 1] - cccs[0];
    wc.change = r1(d);
    const dsoD = Y[n - 1].dso != null && Y[0].dso != null ? Y[n - 1].dso - Y[0].dso : null;
    if (d <= -5) { wc.verdict = 'MORE EFFICIENT'; wc.note = `Cash conversion cycle shortened ${Math.abs(d).toFixed(0)} days over ${n} years — the business turns sales into cash faster than it used to.`; }
    else if (d >= 10 || (dsoD != null && dsoD >= 10)) { wc.verdict = 'CONSUMING CASH'; wc.note = `Cash conversion cycle lengthened ${d.toFixed(0)} days${dsoD >= 10 ? ` and customers now take ${dsoD.toFixed(0)} more days to pay` : ''}. Growth is being financed by working capital, which is where manufactured profits usually hide.`; }
    else { wc.verdict = 'STABLE'; wc.note = `Cash conversion cycle moved ${d >= 0 ? '+' : ''}${d.toFixed(0)} days over ${n} years — neither squeezing suppliers nor stretching customers.`; }
  }

  // ── 3/4. Moat: margins, returns, inflation-cycle test ────────────────────
  const moat = { years: Y.map((y) => ({ fy: y.fy, gm: r1(y.gm), om: r1(y.om), roce: r1(y.roce), roic: r1(y.roic) })), score: null, verdict: null, note: null, factors: [] };
  const gms = Y.map((y) => y.gm).filter((x) => x != null), roces = Y.map((y) => y.roce).filter((x) => x != null);
  if (isFinancial) { moat.verdict = 'N/A'; moat.note = 'Gross margin and ROCE are not defined for banks and insurers; look at return on equity in the filings instead.'; }
  else if (gms.length < 3 && roces.length < 3) { moat.verdict = 'N/A'; moat.note = 'Not enough margin or return data tagged.'; }
  else {
    let s = 0;
    const gmNow = gms[gms.length - 1], gmFirst = gms[0];
    if (gmNow != null) { const pts = gmNow >= 50 ? 3 : gmNow >= 35 ? 2 : gmNow >= 20 ? 1 : 0; s += pts; moat.factors.push(`Gross margin ${gmNow.toFixed(0)}% → ${pts}/3`); }
    if (gmNow != null && gmFirst != null) { const d = gmNow - gmFirst; const pts = d >= -1 ? 2 : d >= -4 ? 1 : 0; s += pts; moat.factors.push(`Margin trend ${d >= 0 ? '+' : ''}${d.toFixed(1)} pts over ${gms.length} yrs → ${pts}/2`); }
    const roceNow = roces[roces.length - 1];
    if (roceNow != null) { const pts = roceNow >= 25 ? 3 : roceNow >= 15 ? 2 : roceNow >= 8 ? 1 : 0; s += pts; moat.factors.push(`ROCE ${roceNow.toFixed(0)}% → ${pts}/3`); }
    const y21 = Y.find((y) => y.fy === '2021'), y23 = Y.find((y) => y.fy === '2023');
    if (y21?.gm != null && y23?.gm != null) { const held = y23.gm >= y21.gm - 2; s += held ? 2 : 0; moat.held2223 = held; moat.factors.push(`2022–23 inflation cycle: margin ${held ? 'held' : 'gave way'} (${y21.gm.toFixed(0)}% → ${y23.gm.toFixed(0)}%) → ${held ? 2 : 0}/2`); }
    moat.score = Math.min(10, s);
    moat.verdict = s >= 8 ? 'WIDE' : s >= 5 ? 'NARROW' : 'NONE EVIDENT';
    moat.note = `${moat.verdict === 'WIDE' ? 'High, stable margins and high returns on capital — the numbers a durable advantage leaves behind.' : moat.verdict === 'NARROW' ? 'Some pricing power or capital efficiency, but not both, or not consistently.' : 'Margins or returns are thin or falling: competitors can evidently replicate this.'} Which KIND of moat (brand, switching cost, network, cost, regulatory) and how many competitors can copy it is a judgment the numbers cannot make — the prompt below asks that question with these figures attached.`;
  }

  // ── 5. Capital allocation ────────────────────────────────────────────────
  const tot = (k) => sum(Y.map((y) => y[k]));
  const alloc = {
    years: Y.map((y) => ({ fy: y.fy, fcf: y.fcf, dividends: y.dividends, buybacks: y.buybacks, capex: y.capex, acquisitions: y.acquisitions, rnd: y.rnd, sbc: y.sbc, debt: y.debt, shares: y.shares })),
    totals: { fcf: tot('fcf'), dividends: tot('dividends'), buybacks: tot('buybacks'), capex: tot('capex'), acquisitions: tot('acquisitions'), rnd: tot('rnd'), sbc: tot('sbc') },
    verdict: null, note: null, points: [],
  };
  const T = alloc.totals;
  alloc.payoutPctFcf = T.fcf > 0 ? r1(((T.dividends + T.buybacks) / T.fcf) * 100) : null;
  alloc.acqPctFcf = T.fcf > 0 ? r1((T.acquisitions / T.fcf) * 100) : null;
  alloc.shareChangePct = first.shares && last.shares ? r1(((last.shares - first.shares) / first.shares) * 100) : null;
  alloc.debtChange = first.debt != null && last.debt != null ? last.debt - first.debt : null;
  alloc.buybackOffsetBySbc = T.buybacks > 0 && T.sbc > 0 ? r1((T.sbc / T.buybacks) * 100) : null;
  if (isFinancial) {
    alloc.verdict = 'N/A'; alloc.payoutPctFcf = null; alloc.acqPctFcf = null;
    alloc.note = `Free cash flow is not meaningful for a bank, so no value-creation verdict. The filed numbers: $${(T.dividends / 1e9).toFixed(1)}B in dividends and $${(T.buybacks / 1e9).toFixed(1)}B in buybacks over ${n} years${alloc.shareChangePct != null ? `; share count ${alloc.shareChangePct >= 0 ? '+' : ''}${alloc.shareChangePct}%` : ''}.`;
    if (alloc.shareChangePct != null) alloc.points.push(alloc.note);
  }
  else {
    let good = 0, bad = 0;
    if (alloc.shareChangePct != null) { if (alloc.shareChangePct <= -2) { good++; alloc.points.push(`Share count fell ${Math.abs(alloc.shareChangePct)}% — buybacks actually shrank the float.`); } else if (alloc.shareChangePct >= 2 && T.buybacks > 0) { bad++; alloc.points.push(`Spent $${(T.buybacks / 1e9).toFixed(1)}B on buybacks yet the share count ROSE ${alloc.shareChangePct}% — buybacks only mopped up stock compensation.`); } }
    if (alloc.payoutPctFcf != null) { if (alloc.payoutPctFcf > 110 && alloc.debtChange > 0) { bad++; alloc.points.push(`Paid out ${alloc.payoutPctFcf}% of free cash flow while debt rose $${(alloc.debtChange / 1e9).toFixed(1)}B — shareholder returns are being borrowed.`); } else if (alloc.payoutPctFcf <= 100) { good++; alloc.points.push(`Dividends + buybacks = ${alloc.payoutPctFcf}% of free cash flow: funded from operations.`); } }
    if (alloc.acqPctFcf != null && alloc.acqPctFcf > 0) { const roicFirst = Y.map((y) => y.roic).find((x) => x != null), roicLast = [...Y].reverse().map((y) => y.roic).find((x) => x != null); if (alloc.acqPctFcf > 60 && roicLast != null && roicFirst != null && roicLast < roicFirst - 3) { bad++; alloc.points.push(`Acquisitions consumed ${alloc.acqPctFcf}% of free cash flow and ROIC fell ${(roicFirst - roicLast).toFixed(0)} pts — the deals diluted returns.`); } else if (alloc.acqPctFcf > 60) { alloc.points.push(`Acquisitions consumed ${alloc.acqPctFcf}% of free cash flow; returns on capital did not deteriorate, so no evidence yet of value destruction.`); } else { alloc.points.push(`Acquisitions were ${alloc.acqPctFcf}% of free cash flow — growth is mostly organic.`); } }
    if (T.rnd > 0 && T.capex >= 0) alloc.points.push(`Reinvested $${((T.rnd + T.capex) / 1e9).toFixed(1)}B in R&D and capex over ${n} years vs $${(T.acquisitions / 1e9).toFixed(1)}B on acquisitions — ${T.rnd + T.capex > T.acquisitions ? 'core business first' : 'buying growth rather than building it'}.`);
    const roicNow = [...Y].reverse().map((y) => y.roic).find((x) => x != null);
    if (roicNow != null) { if (roicNow >= 15) good++; else if (roicNow < 8) bad++; alloc.points.push(`Return on invested capital ${roicNow.toFixed(0)}% — ${roicNow >= 15 ? 'every retained dollar is compounding well above the cost of capital' : roicNow >= 8 ? 'roughly earning its cost of capital' : 'below the cost of capital: retained earnings are destroying value'}.`); }
    alloc.verdict = bad === 0 && good >= 2 ? 'VALUE CREATORS' : bad >= 2 || (bad >= 1 && good === 0) ? 'VALUE DESTROYERS' : 'MIXED';
    alloc.note = alloc.points[0] || 'Insufficient data.';
  }

  // ── 6. Valuation vs own history ──────────────────────────────────────────
  const price = monthly?.price ?? null;
  const mcap = nasdaq.marketCap ?? (price != null && last.shares ? price * last.shares : null);
  const ttmEps = nasdaq.eps ?? last.eps;
  const curPE = nasdaq.pe ?? (price != null && ttmEps > 0 ? price / ttmEps : null);
  const curEvEbitda = mcap != null && last.ebitda > 0 ? (mcap + (last.debt || 0) - (last.cashAll || 0)) / last.ebitda : null;
  const curPfcf = mcap != null && last.fcf > 0 ? mcap / last.fcf : null;
  const hist = { pe: Y.map((y) => y.pe).filter((x) => x != null && x > 0 && x < 500), evEbitda: Y.map((y) => y.evEbitda).filter((x) => x != null && x > 0 && x < 500), pfcf: Y.map((y) => y.pfcf).filter((x) => x != null && x > 0 && x < 500) };
  const valuation = {
    price, marketCap: mcap, ttmEps, forwardPE: nasdaq.forwardPE,
    current: { pe: r1(curPE), evEbitda: r1(curEvEbitda), pfcf: r1(curPfcf), fcfYieldPct: curPfcf ? r2(100 / curPfcf) : null },
    median5y: { pe: r1(median(hist.pe)), evEbitda: r1(median(hist.evEbitda)), pfcf: r1(median(hist.pfcf)) },
    years: Y.map((y) => ({ fy: y.fy, price: r2(y.price), eps: y.eps, pe: r1(y.pe), evEbitda: r1(y.evEbitda), pfcf: r1(y.pfcf) })),
    epsCagr: r1(cagr(first.eps, last.eps, n - 1)),
    revenueCagr: r1(cagr(first.revenue, last.revenue, n - 1)),
    impliedFcfGrowth: r1(impliedGrowth(last.fcf, mcap)),
    dcfAssumptions: '10-year DCF on last fiscal year free cash flow, 10% discount rate, 3% terminal growth. The growth shown is the rate at which that model equals today\'s market cap.',
    verdict: null, note: null, fairValue: null,
  };
  const prem = (cur, med) => (cur != null && med != null && med > 0 ? (cur / med - 1) * 100 : null);
  const pePrem = prem(curPE, valuation.median5y.pe), fcfPrem = prem(curPfcf, valuation.median5y.pfcf), evPrem = prem(curEvEbitda, valuation.median5y.evEbitda);
  const prems = [pePrem, fcfPrem, evPrem].filter((x) => x != null);
  valuation.premiumToOwnHistoryPct = r1(prems.length ? median(prems) : null);
  // Fair value range: the stock's own median multiples applied to today's earnings and cash flow
  const anchors = [];
  if (valuation.median5y.pe && ttmEps > 0) anchors.push({ basis: `5-yr median P/E ${valuation.median5y.pe}× × TTM EPS $${ttmEps}`, value: valuation.median5y.pe * ttmEps });
  if (valuation.median5y.pfcf && last.fcf > 0 && last.shares) anchors.push({ basis: `5-yr median P/FCF ${valuation.median5y.pfcf}× × FCF/share $${(last.fcf / last.shares).toFixed(2)}`, value: valuation.median5y.pfcf * last.fcf / last.shares });
  if (valuation.median5y.evEbitda && last.ebitda > 0 && last.shares) anchors.push({ basis: `5-yr median EV/EBITDA ${valuation.median5y.evEbitda}× − net debt`, value: (valuation.median5y.evEbitda * last.ebitda - (last.debt || 0) + (last.cashAll || 0)) / last.shares });
  if (anchors.length) {
    const vals = anchors.map((a) => a.value);
    valuation.fairValue = { low: r2(Math.min(...vals) * 0.9), high: r2(Math.max(...vals) * 1.1), anchors: anchors.map((a) => ({ ...a, value: r2(a.value) })), assumption: 'Fair value = the stock\'s own 5-year median multiples applied to its latest earnings and cash flow, ±10%. This assumes the last five years are a fair guide to what the market will pay; it is not a forecast.' };
  }
  if (valuation.premiumToOwnHistoryPct == null) { valuation.verdict = 'N/A'; valuation.note = 'Not enough history to compare the stock to itself.'; }
  else if (valuation.premiumToOwnHistoryPct <= -20) { valuation.verdict = 'CHEAP vs own history'; valuation.note = `Trading ${Math.abs(valuation.premiumToOwnHistoryPct).toFixed(0)}% below its own 5-year median multiples.`; }
  else if (valuation.premiumToOwnHistoryPct >= 25) { valuation.verdict = 'EXPENSIVE vs own history'; valuation.note = `Trading ${valuation.premiumToOwnHistoryPct.toFixed(0)}% above its own 5-year median multiples.`; }
  else { valuation.verdict = 'FAIR vs own history'; valuation.note = `Within ${Math.abs(valuation.premiumToOwnHistoryPct).toFixed(0)}% of its own 5-year median multiples.`; }
  if (valuation.impliedFcfGrowth != null && valuation.revenueCagr != null) valuation.note += ` Today's price needs free cash flow to grow ${valuation.impliedFcfGrowth}%/yr for a decade; revenue actually grew ${valuation.revenueCagr}%/yr over the last ${n - 1} years${valuation.epsCagr != null ? ` and EPS ${valuation.epsCagr}%/yr` : ''} — ${valuation.impliedFcfGrowth > (valuation.epsCagr ?? valuation.revenueCagr) + 5 ? 'the market is pricing acceleration' : valuation.impliedFcfGrowth < (valuation.epsCagr ?? valuation.revenueCagr) - 5 ? 'the market is pricing a slowdown' : 'the market is pricing more of the same'}.`;

  // ── 7. Credibility: EPS vs consensus, last 8 quarters ────────────────────
  const sp = nasdaq.surprises.filter((s) => s.surprise != null);
  const credibility = { quarters: nasdaq.surprises, beats: sp.filter((s) => s.surprise > 0).length, misses: sp.filter((s) => s.surprise < 0).length, inline: sp.filter((s) => s.surprise === 0).length, avgSurprisePct: r1(sp.length ? sum(sp.map((s) => s.surprise)) / sp.length : null), worstPct: r1(sp.length ? Math.min(...sp.map((s) => s.surprise)) : null), score: null, note: null };
  if (sp.length >= 4) {
    credibility.score = Math.max(0, Math.min(10, Math.round((credibility.beats / sp.length) * 8 + (credibility.worstPct > -10 ? 2 : credibility.worstPct > -25 ? 1 : 0))));
    credibility.note = `Beat consensus in ${credibility.beats} of the last ${sp.length} quarters (average surprise ${credibility.avgSurprisePct >= 0 ? '+' : ''}${credibility.avgSurprisePct}%, worst ${credibility.worstPct}%). This is the quantitative half of credibility — whether the numbers land where the Street was guided. The qualitative half (did the LANGUAGE change, were misses explained or deflected) needs the call transcripts, which no free source provides; the prompt below is pre-filled for that.`;
  } else credibility.note = 'Fewer than four quarters of consensus data.';

  // ── 8. Executive pay (US stand-in for "promoter salary as % of PAT") ─────
  const payYears = Y.filter((y) => y.ceoPay != null);
  const pay = { years: payYears.map((y) => ({ fy: y.fy, ceoPay: y.ceoPay, pctOfNetIncome: y.netIncome > 0 ? r2((y.ceoPay / y.netIncome) * 100) : null })), note: null };
  if (payYears.length) { const p = pay.years[pay.years.length - 1]; pay.latest = p; pay.note = `CEO total compensation $${(p.ceoPay / 1e6).toFixed(1)}M in FY${p.fy}${p.pctOfNetIncome != null ? ` = ${p.pctOfNetIncome}% of net income` : ''} (SEC pay-versus-performance disclosure). ${p.pctOfNetIncome > 5 ? 'High relative to what shareholders earned.' : p.pctOfNetIncome > 1 ? 'Material but ordinary for a US large-cap.' : 'Small next to the profit pool.'} Promoter pledging and related-party loans are Indian-market concepts; the US equivalents on this desk are the insider-trade alerts (Form 4) and the acquisitions line above.`; }
  else pay.note = 'No pay-versus-performance data tagged yet (required from FY2022 proxies).';

  // ── 9. Multibagger criteria, honestly adapted to a large-cap universe ────
  const roicSeries = Y.map((y) => y.roic).filter((x) => x != null);
  const multibagger = { criteria: [], score: 0, of: 5 };
  const push = (name, pass, detail) => { multibagger.criteria.push({ name, pass, detail }); if (pass) multibagger.score++; };
  push('Revenue compounding (TAM expanding)', valuation.revenueCagr != null && valuation.revenueCagr >= 10, valuation.revenueCagr != null ? `Revenue CAGR ${valuation.revenueCagr}%/yr over ${n - 1} yrs (test: ≥10%). Whether the ADDRESSABLE market is expanding is a judgment the filings do not make.` : 'No revenue series.');
  push('ROIC above 15% and not falling', roicSeries.length >= 2 && roicSeries[roicSeries.length - 1] >= 15 && roicSeries[roicSeries.length - 1] >= roicSeries[0] - 2, roicSeries.length ? `ROIC ${roicSeries[0].toFixed(0)}% → ${roicSeries[roicSeries.length - 1].toFixed(0)}%` : 'No ROIC series (financials or missing tags).');
  push('Owner-operator alignment', null, 'Insider ownership % is not in free structured data; promoter pledging does not exist in the US. Stand-in: the Form 4 insider-trade feed on the Alerts tab, where officer SELLS have measured as noise and BUYS are too rare to score.');
  push('Under-covered by analysts', false, 'Every S&P 500 name has 15–50 analysts. By construction this universe fails the "fewer than 5 reports" test — true multibagger hunting happens in small caps this desk does not screen.');
  push('Profits reinvested in the core', T.rnd + T.capex > T.acquisitions, `R&D + capex $${((T.rnd + T.capex) / 1e9).toFixed(1)}B vs acquisitions $${(T.acquisitions / 1e9).toFixed(1)}B over ${n} years.`);
  multibagger.of = multibagger.criteria.filter((c) => c.pass !== null).length;

  // ── 10. Synthesis ────────────────────────────────────────────────────────
  const bull = [], flags = [];
  if (cash.verdict === 'REAL') bull.push(`Profits are cash: CFO/net income ${cash.avgRatio}× over ${n} years.`);
  if (moat.verdict === 'WIDE') bull.push(`Wide-moat numbers: ${last.gm != null ? `gross margin ${r1(last.gm)}%, ` : ''}ROCE ${r1(last.roce)}%.`);
  if (alloc.verdict === 'VALUE CREATORS') bull.push(alloc.points.find((p) => /Share count fell|compounding/.test(p)) || 'Capital allocation creates value.');
  if (valuation.verdict?.startsWith('CHEAP')) bull.push(valuation.note.split('.')[0] + '.');
  if (valuation.revenueCagr >= 15) bull.push(`Revenue compounding at ${valuation.revenueCagr}%/yr.`);
  if (credibility.score >= 8) bull.push(`Guidance credibility: beat ${credibility.beats}/${sp.length} quarters.`);
  if (wc.verdict === 'MORE EFFICIENT') bull.push(wc.note);
  if (cash.verdict === 'MANUFACTURED?') flags.push(`Earnings quality: ${cash.note}`);
  if (cash.verdict === 'WATCH') flags.push(`Earnings quality: ${cash.note}`);
  if (wc.verdict === 'CONSUMING CASH') flags.push(`Working capital: ${wc.note}`);
  if (alloc.verdict === 'VALUE DESTROYERS') flags.push(`Capital allocation: ${alloc.points.find((p) => /ROSE|borrowed|diluted|destroying/.test(p)) || alloc.note}`);
  if (valuation.verdict?.startsWith('EXPENSIVE')) flags.push(`Valuation: ${valuation.note}`);
  if (moat.verdict === 'NONE EVIDENT') flags.push(`Moat: ${moat.note.split('.')[0]}.`);
  if (credibility.score != null && credibility.score <= 4) flags.push(`Credibility: missed consensus in ${credibility.misses} of ${sp.length} quarters.`);
  if (last.gm != null && first.gm != null && last.gm < first.gm - 4) flags.push(`Gross margin down ${(first.gm - last.gm).toFixed(1)} pts since FY${first.fy}.`);
  if (alloc.debtChange > 0 && last.ebitda > 0 && last.debt / last.ebitda > 3) flags.push(`Leverage: debt ${(last.debt / last.ebitda).toFixed(1)}× EBITDA and rising.`);
  if (pay.latest?.pctOfNetIncome > 5) flags.push(`CEO pay is ${pay.latest.pctOfNetIncome}% of net income.`);
  const question =
    cash.verdict === 'MANUFACTURED?' || cash.verdict === 'WATCH' ? `Operating cash flow has lagged reported profit (${cash.avgRatio}× on average). Where exactly is the difference sitting — receivables, inventory, capitalised costs — and when does it convert?` :
    wc.verdict === 'CONSUMING CASH' ? `The cash conversion cycle lengthened ${wc.change} days. Are customers paying slower by choice (financing growth) or by necessity (pricing power gone)?` :
    valuation.verdict?.startsWith('EXPENSIVE') && valuation.impliedFcfGrowth != null ? `The price implies ${valuation.impliedFcfGrowth}% free-cash-flow growth for a decade; revenue grew ${valuation.revenueCagr}%/yr and EPS ${valuation.epsCagr ?? '?'}%/yr over the last ${n - 1} years, the EPS part helped by buybacks. Which of the two does the next decade look like, and why?` :
    alloc.verdict === 'VALUE DESTROYERS' ? `Buybacks have not reduced the share count and payouts exceed free cash flow. Is the capital-return programme funded by operations or by the balance sheet?` :
    moat.verdict === 'NONE EVIDENT' ? `Gross margin is ${r1(last.gm)}% and ROCE ${r1(last.roce)}%. What stops a competitor from pricing you out?` :
    isFinancial ? `The filings tagged here do not show credit quality. What are the reserve build and net charge-off trends, and how much of the ${valuation.epsCagr != null ? valuation.epsCagr + '%/yr ' : ''}EPS growth came from the ${alloc.shareChangePct != null ? Math.abs(alloc.shareChangePct) + '% ' : ''}smaller share count rather than earnings?` :
    `Margins held and cash backs profit. What is the one input cost or customer whose change would break that?`;

  return {
    ticker, cik, name: factsDoc.entityName || monthly?.name || ticker, sector, isFinancial, asOf: Date.now(),
    fiscalYears: Y.map((y) => y.fy), latestFiscalEnd: last.end,
    splitsAdjusted: Y.filter((y) => y.splitAdjusted).map((y) => `${y.fy}: ×${y.splitAdjusted}`),
    years: Y.map((y) => ({ fy: y.fy, end: y.end, revenue: y.revenue, netIncome: y.netIncome, cfo: y.cfo, capex: y.capex, fcf: y.fcf, grossProfit: y.grossProfit, opIncome: y.opIncome, ebitda: y.ebitda, eps: y.eps, shares: y.shares, debt: y.debt, cash: y.cashAll, equity: y.equity, assets: y.assets, ar: y.ar, inventory: y.inventory, ap: y.ap, gm: r1(y.gm), om: r1(y.om), roce: r1(y.roce), roic: r1(y.roic), price: r2(y.price) })),
    cash, workingCapital: wc, moat, allocation: alloc, valuation, credibility, pay, multibagger,
    synthesis: { bull: bull.slice(0, 3), flags: flags.slice(0, 3), question, fairValue: valuation.fairValue },
    sources: ['SEC XBRL companyfacts (10-K)', 'Yahoo monthly closes', 'NASDAQ summary & earnings-surprise'],
    notAvailable: ['earnings-call transcripts', 'customer concentration %', 'segment P&L', 'insider ownership %', 'peer ROCE table'],
  };
}

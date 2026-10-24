// /api/intel?op=macrodata — the macro backdrop from FRED (St. Louis Fed), free, no key.
//
// Series (all official US statistics, republished by FRED):
//   CPIAUCSL  CPI, all items, SA (monthly)       → inflation YoY and 3-month annualised
//   UNRATE    unemployment rate (monthly)         → level and 12-month change (Sahm-style read)
//   PAYEMS    nonfarm payrolls (monthly, thousands) → 3-month average change
//   GDPC1     real GDP (quarterly, chained $)     → last quarter annualised growth
//   FEDFUNDS  effective fed funds rate (monthly)  → level and 6-month change
//   DGS10     10-year Treasury yield (daily)
//   T10Y2Y    10y−2y spread (daily)               → curve inverted or not
//
// The "read" is rule-based (thresholds in the handbook) and says which sectors have
// historically done better in that combination. It is context, never a forecast.

const UA = 'Mozilla/5.0';
async function fred(id) {
  const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`FRED ${id} ${r.status}`);
  const rows = (await r.text()).trim().split('\n').slice(1).map((l) => l.split(',')).filter((x) => x[1] !== '.' && x[1] !== '').map(([d, v]) => ({ d, v: +v }));
  return rows;
}
const last = (a, n = 1) => a[a.length - n];
const r1 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(1));
const r2 = (x) => (x == null || !isFinite(x) ? null : +x.toFixed(2));

export default async function handler(req, res) {
  const get = async (id) => { try { return await fred(id); } catch { return null; } };
  const [cpi, un, pay, gdp, ff, dgs10, spread] = await Promise.all(['CPIAUCSL', 'UNRATE', 'PAYEMS', 'GDPC1', 'FEDFUNDS', 'DGS10', 'T10Y2Y'].map(get));
  const out = { asOf: Date.now(), source: 'FRED (St. Louis Fed) — BLS, BEA and Treasury series' };

  if (cpi && cpi.length > 13) {
    const yoy = (last(cpi).v / last(cpi, 13).v - 1) * 100;
    const yoyPrev = (last(cpi, 4).v / last(cpi, 16).v - 1) * 100;
    const m3 = (Math.pow(last(cpi).v / last(cpi, 4).v, 4) - 1) * 100;
    out.inflation = { asOf: last(cpi).d, yoyPct: r1(yoy), yoy3mAgoPct: r1(yoyPrev), threeMonthAnnualisedPct: r1(m3), trend: m3 > yoy + 0.5 ? 'accelerating' : m3 < yoy - 0.5 ? 'cooling' : 'steady' };
  }
  if (un && un.length > 13) {
    const now = last(un).v, low12 = Math.min(...un.slice(-12).map((x) => x.v)), m3 = un.slice(-3).reduce((s, x) => s + x.v, 0) / 3;
    out.unemployment = { asOf: last(un).d, ratePct: now, yearAgoPct: last(un, 13).v, threeMonthAvgPct: r2(m3), riseFrom12mLowPts: r2(m3 - low12), sahmSignal: m3 - low12 >= 0.5 };
  }
  if (pay && pay.length > 4) {
    const d1 = last(pay).v - last(pay, 2).v, d2 = last(pay, 2).v - last(pay, 3).v, d3 = last(pay, 3).v - last(pay, 4).v;
    out.payrolls = { asOf: last(pay).d, lastChangeK: Math.round(d1), threeMonthAvgChangeK: Math.round((d1 + d2 + d3) / 3) };
  }
  if (gdp && gdp.length > 5) {
    const q = (Math.pow(last(gdp).v / last(gdp, 2).v, 4) - 1) * 100, prev = (Math.pow(last(gdp, 2).v / last(gdp, 3).v, 4) - 1) * 100, yoy = (last(gdp).v / last(gdp, 5).v - 1) * 100;
    out.gdp = { asOf: last(gdp).d, lastQuarterAnnualisedPct: r1(q), priorQuarterPct: r1(prev), yoyPct: r1(yoy) };
  }
  if (ff && ff.length > 7) out.fedFunds = { asOf: last(ff).d, ratePct: last(ff).v, sixMonthChangePts: r2(last(ff).v - last(ff, 7).v), direction: last(ff).v < last(ff, 7).v - 0.1 ? 'cutting' : last(ff).v > last(ff, 7).v + 0.1 ? 'hiking' : 'on hold' };
  if (dgs10 && dgs10.length > 22) out.tenYear = { asOf: last(dgs10).d, yieldPct: last(dgs10).v, oneMonthChangePts: r2(last(dgs10).v - last(dgs10, 22).v) };
  if (spread && spread.length) out.curve = { asOf: last(spread).d, tenMinusTwoPts: last(spread).v, inverted: last(spread).v < 0 };

  // ── Rule-based read: which regime, and the textbook sector tendencies for it ──
  const read = [], tilt = [];
  const inf = out.inflation, ue = out.unemployment, g = out.gdp, f = out.fedFunds;
  if (inf) read.push(`Inflation ${inf.yoyPct}% YoY and ${inf.trend} (3-month annualised ${inf.threeMonthAnnualisedPct}%).`);
  if (ue) read.push(`Unemployment ${ue.ratePct}%, ${ue.riseFrom12mLowPts >= 0 ? 'up' : 'down'} ${Math.abs(ue.riseFrom12mLowPts)} pts from its 12-month low${ue.sahmSignal ? ' — the Sahm recession rule (+0.5 pt) is TRIGGERED' : ''}.`);
  if (out.payrolls) read.push(`Payrolls ${out.payrolls.threeMonthAvgChangeK >= 0 ? '+' : ''}${out.payrolls.threeMonthAvgChangeK}K a month on average over three months.`);
  if (g) read.push(`Real GDP grew ${g.lastQuarterAnnualisedPct}% annualised last quarter (${g.yoyPct}% YoY).`);
  if (f) read.push(`Fed funds ${f.ratePct}%, ${f.direction}${f.sixMonthChangePts ? ` (${f.sixMonthChangePts > 0 ? '+' : ''}${f.sixMonthChangePts} pts in six months)` : ''}.`);
  if (out.curve) read.push(`Yield curve ${out.curve.inverted ? 'INVERTED' : 'positive'} (10y − 2y = ${out.curve.tenMinusTwoPts} pts).`);
  const growthWeak = (g && g.lastQuarterAnnualisedPct < 1) || (ue && ue.sahmSignal) || (out.payrolls && out.payrolls.threeMonthAvgChangeK < 50);
  const inflationHot = inf && (inf.yoyPct > 3.5 || inf.trend === 'accelerating');
  let regime;
  if (growthWeak && inflationHot) { regime = 'stagflation-risk'; tilt.push('energy, commodities and staples have tended to hold; long-duration growth and consumer discretionary have tended to lag'); }
  else if (growthWeak) { regime = 'slowdown'; tilt.push('defensives — staples, health care, utilities — and long Treasuries have tended to lead; cyclicals, small caps and banks have tended to lag'); }
  else if (inflationHot) { regime = 'reflation'; tilt.push('energy, materials, industrials and banks have tended to lead; bond proxies (utilities, REITs) and unprofitable growth have tended to lag'); }
  else { regime = 'expansion'; tilt.push('technology, discretionary, industrials and financials have tended to lead; defensives have tended to lag'); }
  if (f?.direction === 'cutting' && !growthWeak) tilt.push('rate cuts into a still-growing economy have historically favoured small caps, home builders and REITs');
  if (f?.direction === 'hiking') tilt.push('rate hikes compress long-duration valuations first — the highest P/E names are the most exposed');
  out.regime = regime;
  out.read = read;
  out.sectorTendencies = tilt;
  out.caveat = 'These are historical tendencies for a regime read from lagging official data; the next GDP print, Fed decision or geopolitical shock is not in them. Use as context for sizing, not as a signal.';
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  res.status(200).json(out);
}

// /api/intel?op=preview&ticker=NVDA — the pre-earnings brief, from primary sources:
//
//   • NASDAQ earnings-forecast   consensus EPS for the coming quarters, estimate count, 4-week revisions
//   • NASDAQ earnings-surprise   last reported quarters: EPS vs consensus (beat / miss)
//   • NASDAQ earnings-date       the next report date (estimated until confirmed)
//   • Yahoo daily bars (2y)      the stock's reaction after each of the last reports: gap at the
//                                open and close-to-close move, plus the 5-session drift after
//   • NASDAQ option chain        the options-implied move: the at-the-money straddle for the first
//                                expiry on or after the report date, as % of the stock price
//   • NASDAQ short-interest      shares short, days to cover, change since the prior settlement
//
// Everything is arithmetic on those tables. "Key metrics Wall Street is watching", segment
// trends and guidance language need the call transcript and the 10-Q text, which no free
// source provides; the Research page hands those to a prompt instead of guessing.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const H = { 'User-Agent': UA, Accept: 'application/json' };
const DAY = 86400000;
const num = (s) => { if (s == null || s === '') return null; const n = parseFloat(String(s).replace(/[$,%]/g, '')); return isNaN(n) ? null : n; };
const mdy = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };
const j = async (u, h = H) => { const r = await fetch(u, { headers: h }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };

async function forecast(t) {
  try {
    const d = (await j(`https://api.nasdaq.com/api/analyst/${t}/earnings-forecast`)).data;
    const rows = d?.quarterlyForecast?.rows || [];
    return rows.slice(0, 4).map((r) => ({ period: r.fiscalEnd, consensusEps: num(r.consensusEPSForecast), highEps: num(r.highEPSForecast), lowEps: num(r.lowEPSForecast), estimates: num(r.noOfEstimates), revisionsUp: num(r.up), revisionsDown: num(r.down) }));
  } catch { return []; }
}
async function surprises(t) {
  try {
    const rows = (await j(`https://api.nasdaq.com/api/company/${t}/earnings-surprise`)).data?.earningsSurpriseTable?.rows || [];
    return rows.slice(0, 8).map((x) => ({ quarter: x.fiscalQtrEnd, date: mdy(x.dateReported), eps: num(x.eps), consensus: num(x.consensusForecast), surprisePct: num(x.percentageSurprise) }));
  } catch { return []; }
}
async function nextDate(t) {
  try {
    const text = (await j(`https://api.nasdaq.com/api/analyst/${t}/earnings-date`)).data?.reportText || '';
    const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return null;
    const iso = `${m[3]}-${m[1]}-${m[2]}`;
    return { date: iso, daysAway: Math.round((Date.parse(iso + 'T00:00:00Z') - Date.now()) / DAY), estimated: /algorithm|estimated/i.test(text), timing: /after market|after the close|AMC/i.test(text) ? 'after close' : /before market|pre-market|BMO/i.test(text) ? 'before open' : null };
  } catch { return null; }
}
async function shortInterest(t) {
  try {
    const rows = (await j(`https://api.nasdaq.com/api/quote/${t}/short-interest?assetClass=stocks`)).data?.shortInterestTable?.rows || [];
    const r = rows.map((x) => ({ date: mdy(x.settlementDate), shares: num(x.interest), avgVolume: num(x.avgDailyShareVolume), daysToCover: num(x.daysToCover) })).filter((x) => x.shares != null);
    if (!r.length) return null;
    const [a, b] = r;
    return { latest: a, prior: b || null, changePct: b && b.shares ? +(((a.shares - b.shares) / b.shares) * 100).toFixed(1) : null, history: r.slice(0, 6) };
  } catch { return null; }
}
async function bars(t) {
  try {
    const res = (await j(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=2y`, { 'User-Agent': UA })).chart?.result?.[0];
    const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
    const out = [];
    for (let i = 0; i < ts.length; i++) if (q.close?.[i] != null) out.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), o: q.open[i], c: q.close[i] });
    return { bars: out, price: res?.meta?.regularMarketPrice ?? out[out.length - 1]?.c ?? null };
  } catch { return { bars: [], price: null }; }
}

/** How the stock moved around each past report: the session before → the first session after. */
function reactions(reports, bars) {
  const idx = new Map(bars.map((b, i) => [b.d, i]));
  const out = [];
  for (const r of reports) {
    if (!r.date) continue;
    // the first trading day strictly after the report date (reports land before the open or after the close)
    let i = bars.findIndex((b) => b.d > r.date);
    if (i < 1) continue;
    const before = bars[i - 1], after = bars[i], five = bars[Math.min(bars.length - 1, i + 4)];
    out.push({
      quarter: r.quarter, date: r.date, surprisePct: r.surprisePct,
      gapPct: +(((after.o - before.c) / before.c) * 100).toFixed(2),
      closePct: +(((after.c - before.c) / before.c) * 100).toFixed(2),
      fiveDayPct: +(((five.c - before.c) / before.c) * 100).toFixed(2),
    });
  }
  void idx;
  return out;
}

/** Options-implied move: ATM straddle mid for the first expiry on/after the report, as % of price. */
async function impliedMove(t, reportDate, price) {
  try {
    const raw = (await j(`https://api.nasdaq.com/api/quote/${t}/option-chain?assetclass=stocks&limit=10000&fromdate=all&todate=undefined&excode=oprac&callput=callput&money=at&type=all`)).data;
    const rows = raw?.table?.rows || [];
    const spot = price ?? num((String(raw?.lastTrade || '').match(/\$?([\d,]+\.?\d*)/) || [])[1]);
    if (!spot || !rows.length) return null;
    const target = reportDate || new Date().toISOString().slice(0, 10);
    let expiry = null, best = null;
    const groups = [];
    for (const r of rows) {
      if (r.expirygroup) { const d = new Date(r.expirygroup); expiry = isNaN(d) ? null : d.toISOString().slice(0, 10); groups.push({ expiry, rows: [] }); continue; }
      if (expiry && groups.length) groups[groups.length - 1].rows.push(r);
    }
    const g = groups.filter((x) => x.expiry && x.expiry >= target).sort((a, b) => a.expiry.localeCompare(b.expiry))[0] || groups[groups.length - 1];
    if (!g) return null;
    for (const r of g.rows) {
      const k = num(r.strike); if (!(k > 0)) continue;
      const cm = num(r.c_Bid) != null && num(r.c_Ask) != null ? (num(r.c_Bid) + num(r.c_Ask)) / 2 : num(r.c_Last);
      const pm = num(r.p_Bid) != null && num(r.p_Ask) != null ? (num(r.p_Bid) + num(r.p_Ask)) / 2 : num(r.p_Last);
      if (!(cm > 0) || !(pm > 0)) continue;
      if (!best || Math.abs(k - spot) < Math.abs(best.strike - spot)) best = { strike: k, call: cm, put: pm };
    }
    if (!best) return null;
    const straddle = best.call + best.put;
    return { expiry: g.expiry, strike: best.strike, straddle: +straddle.toFixed(2), impliedMovePct: +((straddle / spot) * 100).toFixed(2), spot, note: 'ATM straddle ÷ price — the move the market is paying for into that expiry, both directions. Roughly 85% of a straddle is the one-day expectation when the expiry is the report week.' };
  } catch { return null; }
}

export default async function handler(req, res) {
  const t = String((req.query && req.query.ticker) || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) { res.status(400).json({ error: 'Pass ?op=preview&ticker=NVDA' }); return; }
  const [fc, sp, nd, si, px] = await Promise.all([forecast(t), surprises(t), nextDate(t), shortInterest(t), bars(t)]);
  const im = await impliedMove(t, nd?.date, px.price);
  const rx = reactions(sp, px.bars);
  const beats = sp.filter((s) => s.surprisePct > 0).length;
  const absMoves = rx.map((r) => Math.abs(r.closePct));
  const avgAbs = absMoves.length ? +(absMoves.reduce((a, b) => a + b, 0) / absMoves.length).toFixed(2) : null;
  const upDays = rx.filter((r) => r.closePct > 0).length;
  // What the numbers say about the setup — rules, not opinion
  const read = [];
  if (nd) read.push(`Next report ${nd.date}${nd.timing ? ` (${nd.timing})` : ''}, ${nd.daysAway} days away${nd.estimated ? ' — date is an estimate until the company confirms' : ''}.`);
  if (fc[0]?.consensusEps != null) read.push(`Consensus for ${fc[0].period}: EPS $${fc[0].consensusEps} (range $${fc[0].lowEps}–$${fc[0].highEps}, ${fc[0].estimates} estimates; revisions last 4 weeks ${fc[0].revisionsUp} up / ${fc[0].revisionsDown} down).`);
  if (sp.length) read.push(`Beat consensus in ${beats} of the last ${sp.length} reports.`);
  if (rx.length) read.push(`The stock moved ${avgAbs}% on average the session after the last ${rx.length} reports, up ${upDays} of ${rx.length} times — a beat did ${rx.filter((r) => r.surprisePct > 0 && r.closePct > 0).length === rx.filter((r) => r.surprisePct > 0).length && rx.some((r) => r.surprisePct > 0) ? '' : 'not always '}translate into a gain.`);
  if (im) read.push(`Options price a ±${im.impliedMovePct}% move into ${im.expiry}${avgAbs != null ? ` versus ${avgAbs}% realised on average — options are ${im.impliedMovePct > avgAbs * 1.2 ? 'expensive' : im.impliedMovePct < avgAbs * 0.8 ? 'cheap' : 'fairly priced'} against history` : ''}.`);
  if (si?.latest) read.push(`Short interest ${(si.latest.shares / 1e6).toFixed(1)}M shares, ${(+si.latest.daysToCover).toFixed(1)} days to cover${si.changePct != null ? `, ${si.changePct >= 0 ? '+' : ''}${si.changePct}% since the prior settlement` : ''}${si.latest.daysToCover >= 5 ? ' — crowded enough that a beat can squeeze' : ''}.`);
  read.push('The desk\'s rule: no NEW position inside 5 days of the report; a holder with +1R or more trims before the print, otherwise sizes for a 10% gap. Buying "before" is a coin flip at options prices; the brief tells you the odds, it does not place the bet.');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  res.status(200).json({ asOf: Date.now(), ticker: t, next: nd, consensus: fc, history: sp, reactions: rx, avgAbsMovePct: avgAbs, impliedMove: im, shortInterest: si, read, notAvailable: ['segment revenue breakdown (10-Q text)', 'management guidance language (transcript)', 'key metrics the Street watches (judgment)'] });
}

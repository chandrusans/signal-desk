// Handler behind /api/intel?op=health
//
// "Is every source the signals depend on answering, from here?" — asked from the same Vercel
// egress the app itself uses, because that is the only vantage point that matters (NASDAQ, for
// one, treats it differently from a laptop). .github/workflows/health.yml calls this four times a
// day and fails when anything critical is down, which is what turns a quiet data failure into an
// email. Nothing here is cached for long, and nothing here needs a key.
//
// Levels:  critical — signals are wrong or blind without it (prices, VIX, the index list, the
//                     macro calendar, the nightly data files)
//          degraded — a feature loses detail but the rulebook still works (news, NASDAQ extras,
//                     SEC, crypto)

import { dataConfigured } from './_prices.js';
import { ownFetch } from './_gate.js';
import { lockOn } from '../gate.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const DAY = 864e5;

async function get(url, { headers = {}, as = 'json', ms = 9000 } = {}) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await ownFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctl.signal });   // own endpoints get the owner key; nothing else does
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return as === 'text' ? await r.text() : await r.json();
  } finally { clearTimeout(timer); }
}
const ageDays = (iso) => (Date.now() - Date.parse(iso)) / DAY;

// The critical checks go through the app's OWN endpoints: that is the request path a user's
// signal takes, with the same headers and the same edge cache, so a pass here means the app is
// being served that data — not merely that the upstream would answer a differently-shaped call.
function probes(origin) {
  return [
    { id: 'prices', label: 'Prices and VIX (Yahoo chart)', level: 'critical', run: async () => {
      const q = (await get(`${origin}/api/quotes?tickers=SPY,%5EVIX&range=1mo`)).quotes || {};
      const bars = q.SPY?.bars || [];
      if (bars.length < 5) throw new Error('no SPY bars');
      const age = (Date.now() - bars[bars.length - 1].t) / DAY;
      if (age > 5) throw new Error(`last SPY bar is ${age.toFixed(0)} days old`);
      if (!(q['^VIX']?.price > 0)) throw new Error('no VIX');
      return `SPY ${bars.length} bars, last ${age.toFixed(1)} days ago; VIX ${q['^VIX'].price.toFixed(1)}`; } },
    { id: 'scan', label: 'Scoring (index scan)', level: 'critical', run: async () => {
      const d = await get(`${origin}/api/scan?tickers=AAPL,MSFT,JPM,XOM`); const n = (d.rows || []).length;
      if (n < 3) throw new Error(`${n} of 4 names scored`); return `${n} of 4 names scored`; } },
    { id: 'universe', label: 'S&P 500 list', level: 'critical', run: async () => {
      const n = ((await get(`${origin}/api/universe`)).constituents || []).length;
      if (n < 450) throw new Error(`only ${n} names (the fallback list?)`); return `${n} constituents`; } },
    { id: 'macro', label: 'Economic calendar (FairEconomy)', level: 'critical', run: async () => {
      const d = await get(`${origin}/api/intel?op=macro`);
      if (d.error || !d.macroRisk) throw new Error(d.error || 'no verdict'); return `gate ${d.macroRisk.level}, ${d.counts?.total ?? 0} events ahead`; } },
    { id: 'screen', label: 'Nightly screen file', level: 'critical', run: async () => {
      const d = await get(`${origin}/data/screen.json`); const a = ageDays(d.builtAt);
      if (!(a < 4.6)) throw new Error(`built ${a.toFixed(1)} days ago`);
      const c = d.coverage || {}, n = (d.rows || []).length;
      if (n < 450 || c.scan < n * 0.9 || c.filings < n * 0.9) throw new Error(`coverage ${JSON.stringify(c)} of ${n}`);
      return `built ${a.toFixed(1)} days ago, ${n} names`; } },
    { id: 'earnings', label: 'Earnings calendar file', level: 'critical', run: async () => {
      const d = await get(`${origin}/data/earnings.json`); const a = ageDays(d.builtAt), c = d.counts || {};
      if (!(a < 4.6)) throw new Error(`built ${a.toFixed(1)} days ago`);
      if (!(c.sp500Covered >= c.sp500 * 0.9)) throw new Error(`covers ${c.sp500Covered} of ${c.sp500}`);
      return `built ${a.toFixed(1)} days ago, ${c.calendar} on the calendar, ${c.estimated} estimated`; } },
    { id: 'alpaca-data', label: 'Prices from Alpaca (licensed feed)', level: 'degraded', run: async () => {
      if (!dataConfigured()) return 'no Alpaca keys on the server: prices come from Yahoo';
      const d = await get(`${origin}/api/quotes?tickers=SPY,AAPL,MSFT,JPM&range=3mo`), src = d.source || {};
      if (!src.alpaca) throw new Error(`Alpaca returned nothing${src.note ? ` (${src.note})` : ''}; Yahoo is covering`);
      return `${src.alpaca} of ${src.alpaca + src.yahoo} test symbols, live feed ${src.feed === 'sip' ? 'SIP (all exchanges)' : 'IEX (free plan)'}`; } },
    { id: 'screen-nasdaq', label: 'Screen: NASDAQ yield / P/E coverage', level: 'degraded', run: async () => {
      const d = await get(`${origin}/data/screen.json`); const n = (d.rows || []).length, k = d.coverage?.nasdaq ?? 0;
      if (k < n * 0.8) throw new Error(`${k} of ${n} names`); return `${k} of ${n} names`; } },
    { id: 'news', label: 'News (Yahoo search)', level: 'degraded', run: async () => {
      const d = await get('https://query1.finance.yahoo.com/v1/finance/search?q=AAPL&newsCount=5&quotesCount=0', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SignalDesk/1.0)' } }); const n = (d.news || []).length; if (!n) throw new Error('no headlines'); return `${n} headlines`; } },
    { id: 'nasdaq-summary', label: 'NASDAQ quote summary', level: 'degraded', run: async () => {
      const d = await get('https://api.nasdaq.com/api/quote/AAPL/summary?assetclass=stocks'); if (!d?.data?.summaryData) throw new Error('no summary'); return 'answering'; } },
    { id: 'nasdaq-earnings', label: 'NASDAQ earnings results', level: 'degraded', run: async () => {
      const d = await get('https://api.nasdaq.com/api/company/AAPL/earnings-surprise'); if (!(d?.data?.earningsSurpriseTable?.rows || []).length) throw new Error('no rows'); return 'answering'; } },
    { id: 'sec', label: 'SEC EDGAR', level: 'degraded', run: async () => {
      const d = await get('https://data.sec.gov/submissions/CIK0000320193.json', { headers: { 'User-Agent': process.env.SEC_UA || 'SignalDesk health check' } }); if (!d?.filings?.recent) throw new Error('no filings'); return 'answering'; } },
    { id: 'crypto', label: 'Crypto prices (Coinbase)', level: 'degraded', run: async () => {
      const d = await get('https://api.exchange.coinbase.com/products/BTC-USD/ticker'); if (!(+d?.price > 0)) throw new Error('no price'); return 'answering'; } },
  ];
}

export default async function handler(req, res) {
  const host = String(req.headers?.host || '');
  const origin = /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? `${/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https'}://${host}` : 'https://signal-desk-virid.vercel.app';
  const sources = await Promise.all(probes(origin).map(async (p) => {
    const t0 = Date.now();
    try { const detail = await p.run(); return { id: p.id, label: p.label, level: p.level, ok: true, ms: Date.now() - t0, detail }; }
    catch (e) { return { id: p.id, label: p.label, level: p.level, ok: false, ms: Date.now() - t0, detail: e.name === 'AbortError' ? 'timed out' : String(e.message || e).slice(0, 160) }; }
  }));
  // Not a data source, but the first thing worth knowing about a personal app: is it locked?
  const locked = lockOn(process.env);
  sources.push({ id: 'lock', label: 'App lock', level: 'degraded', ok: true, ms: 0, detail: locked ? 'on: sign-in required for every page and data call' : 'OFF: anyone with the link can open the app (set APP_PASSWORD in Vercel to lock it)' });
  const down = sources.filter((s) => !s.ok && s.level === 'critical'), degraded = sources.filter((s) => !s.ok && s.level !== 'critical');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=120');
  res.status(200).json({ asOf: Date.now(), status: down.length ? 'down' : degraded.length ? 'degraded' : 'ok', lock: locked, down: down.map((s) => s.id), degraded: degraded.map((s) => s.id), sources });
}

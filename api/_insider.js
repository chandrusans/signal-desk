// Handler behind /api/intel?op=insider&tickers=NVDA,AAPL&days=90
//
// Corporate insider trades from SEC Form 4 — the primary source. Each ticker
// maps to a CIK via sec.gov's public ticker file; the submissions API lists
// that filer's recent Form 4s; each Form 4's XML carries the transactions.
//
// Only OPEN-MARKET transactions are reported: code P (purchase) and S (sale)
// with a real price. Gifts (G), option exercises (M), tax withholding (F) and
// awards (A) are not trades and are excluded — including them is how most
// "insider buying" trackers end up showing noise.
//
// SEC asks for a descriptive User-Agent with a contact and a ceiling of 10
// requests/second. Both are respected. Per ticker: 1 submissions call plus up
// to MAX_FILINGS Form 4 fetches, so the batch is capped small and cached 6h.
//
// The measured predictive value is attached to the response (see `edge`) so
// the client can never present this as a timing signal without the evidence.

const UA = 'SignalDesk research chandru.sans@gmail.com';
const TICKER_MAP = 'https://www.sec.gov/files/company_tickers.json';
const SUBS = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const MAX_TICKERS = 12;
const MAX_FILINGS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = (tag, s) => (s.match(new RegExp(`<${tag}>\\s*(?:<value>)?([^<]*)`)) || [])[1]?.trim();

let cikCache = null, cikAt = 0;
async function cikMap() {
  if (cikCache && Date.now() - cikAt < 6 * 3600e3) return cikCache;
  const r = await fetch(TICKER_MAP, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`ticker map ${r.status}`);
  const d = await r.json();
  const m = {}; for (const v of Object.values(d)) m[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, '0');
  cikCache = m; cikAt = Date.now(); return m;
}

async function one(t, cik, sinceISO) {
  const out = { ticker: t, cik, trades: [], filingsChecked: 0 };
  let sub;
  try { const r = await fetch(SUBS(cik), { headers: { 'User-Agent': UA } }); if (!r.ok) return out; sub = await r.json(); } catch { return out; }
  const rec = sub.filings?.recent; if (!rec) return out;
  const f4 = [];
  for (let k = 0; k < rec.form.length; k++) if (rec.form[k] === '4' && rec.filingDate[k] >= sinceISO) f4.push({ acc: rec.accessionNumber[k], date: rec.filingDate[k], doc: rec.primaryDocument[k] });
  for (const f of f4.slice(0, MAX_FILINGS)) {
    await sleep(110);
    out.filingsChecked++;
    const url = `https://www.sec.gov/Archives/edgar/data/${+cik}/${f.acc.replace(/-/g, '')}/${f.doc.replace(/^xslF345X\d+\//, '')}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } }); if (!r.ok) continue;
      const x = await r.text();
      const owner = g('rptOwnerName', x) || null, officer = g('officerTitle', x) || null;
      const isDir = /^(1|true)$/i.test(g('isDirector', x) || ''), isOff = /^(1|true)$/i.test(g('isOfficer', x) || ''), isTen = /^(1|true)$/i.test(g('isTenPercentOwner', x) || '');
      for (const b of x.matchAll(/<nonDerivativeTransaction>(.*?)<\/nonDerivativeTransaction>/gs)) {
        const s = b[1]; const code = g('transactionCode', s); if (code !== 'P' && code !== 'S') continue;
        const shares = +g('transactionShares', s) || 0, price = +g('transactionPricePerShare', s) || 0;
        if (!(shares > 0 && price > 0)) continue;
        out.trades.push({
          id: `${f.acc}:${g('transactionDate', s)}:${code}:${shares}`,
          type: code === 'P' ? 'BUY' : 'SELL',
          filingDate: f.date, txnDate: g('transactionDate', s) || null,
          owner, role: officer || (isDir ? 'Director' : isTen ? '10% owner' : 'Other'),
          insider: isOff || isDir,
          shares, price, value: Math.round(shares * price),
          sharesAfter: +g('sharesOwnedFollowingTransaction', s) || null,
          url: `https://www.sec.gov/Archives/edgar/data/${+cik}/${f.acc.replace(/-/g, '')}/`,
        });
      }
    } catch { /* skip this filing */ }
  }
  out.trades.sort((a, b) => (b.filingDate > a.filingDate ? 1 : -1) || b.value - a.value);
  const buys = out.trades.filter((x) => x.type === 'BUY'), sells = out.trades.filter((x) => x.type === 'SELL');
  out.summary = { buys: buys.length, sells: sells.length, buyValue: buys.reduce((s, x) => s + x.value, 0), sellValue: sells.reduce((s, x) => s + x.value, 0), insiderBuys: buys.filter((x) => x.insider).length };
  return out;
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const q = req.query || {};
  const tickers = String(q.tickers || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z.\-]{1,6}$/.test(s)).slice(0, MAX_TICKERS);
  const days = Math.min(Math.max(parseInt(q.days || '90', 10) || 90, 7), 365);
  if (!tickers.length) { res.status(400).json({ error: 'Pass ?tickers=NVDA,AAPL' }); return; }
  const sinceISO = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);

  let map; try { map = await cikMap(); } catch (e) { res.setHeader('Cache-Control', 's-maxage=120'); res.status(200).json({ error: `SEC ticker map unavailable: ${e.message}`, results: {} }); return; }

  const out = {};
  for (const t of tickers) {                       // sequential — SEC's 10 req/s ceiling
    const cik = map[t.replace('-', '')] || map[t];
    if (!cik) { out[t] = { ticker: t, error: 'no CIK for ticker', trades: [] }; continue; }
    out[t] = await one(t, cik, sinceISO);
  }

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    source: 'SEC EDGAR Form 4 (open-market P/S only)',
    sinceISO, days,
    // Measured so no client can present this as a timing signal without it.
    edge: {
      tested: '3,525 Form 4 filings, 94 large-cap names, 2026; 4,228 open-market P/S transactions',
      method: 'excess return vs SPY from the filing date',
      insiderBuy100k: { n: 22, d5: '+1.27% t=1.10', d20: '+3.39% t=1.38', d60: '+8.52% t=1.12', verdict: 'leans positive, not significant — a reason to look' },
      insiderSell: { n: 3686, d5: '+0.92% t=7.24', d20: '+3.51% t=12.27', d60: '+3.10% t=6.79', verdict: 'followed by OUTPERFORMANCE — an insider sell is not a sell signal' },
      caveat: 'one year, large caps, mostly momentum leaders; selling into strength flatters this sample',
    },
    results: out,
  });
}

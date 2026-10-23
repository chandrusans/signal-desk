// Handler behind /api/intel?op=earnings&tickers=NVDA,AAPL
//
// Earnings RESULTS — actual EPS vs consensus and the surprise — from NASDAQ's
// public earnings-surprise endpoint (no key). The earnings DATE gate lives in
// /api/fundamentals; this is the other half: what happened when it printed.
//
// Emits `recent` when the last report landed inside 3 calendar days, which is
// what an "earnings alert" means — the print is fresh and the stock is still
// repricing it.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const URL = (t) => `https://api.nasdaq.com/api/company/${encodeURIComponent(t)}/earnings-surprise`;
const MAX = 30;
const RECENT_DAYS = 3;

const parseMDY = (s) => { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : null; };
const num = (x) => { const n = parseFloat(String(x ?? '').replace(/[,%]/g, '')); return Number.isFinite(n) ? n : null; };

async function one(t) {
  try {
    const r = await fetch(URL(t), { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    const d = (await r.json())?.data;
    const rows = d?.earningsSurpriseTable?.rows || [];
    if (!rows.length) return null;
    const latest = rows[0];
    const ts = parseMDY(latest.dateReported);
    const eps = num(latest.eps), est = num(latest.consensusForecast), surprise = num(latest.percentageSurprise);
    const ageDays = ts != null ? (Date.now() - ts) / 86400000 : null;
    return {
      ticker: t,
      quarter: latest.fiscalQtrEnd || null,
      dateReported: ts != null ? new Date(ts).toISOString().slice(0, 10) : null,
      eps, estimate: est,
      surprisePct: surprise != null ? surprise : (eps != null && est ? +(((eps - est) / Math.abs(est)) * 100).toFixed(2) : null),
      result: surprise == null ? null : surprise > 0 ? 'BEAT' : surprise < 0 ? 'MISS' : 'INLINE',
      recent: ageDays != null && ageDays <= RECENT_DAYS,
      ageDays: ageDays != null ? +ageDays.toFixed(1) : null,
      history: rows.slice(0, 4).map((x) => ({ q: x.fiscalQtrEnd, date: x.dateReported, eps: num(x.eps), est: num(x.consensusForecast), surprise: num(x.percentageSurprise) })),
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  const tickers = String((req.query && req.query.tickers) || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z.\-]{1,6}$/.test(s)).slice(0, MAX);
  if (!tickers.length) { res.status(400).json({ error: 'Pass ?tickers=NVDA,AAPL' }); return; }
  const out = {}; let i = 0;
  async function run() { while (i < tickers.length) { const t = tickers[i++]; const r = await one(t); if (r) out[t] = r; } }
  await Promise.all(Array.from({ length: Math.min(6, tickers.length) }, run));
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ asOf: Date.now(), source: 'NASDAQ earnings-surprise', recentWindowDays: RECENT_DAYS, results: out });
}

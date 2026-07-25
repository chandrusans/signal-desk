// Vercel serverless: /api/fundamentals?tickers=NVDA,PLTR,...
//
// Replaces the previously-mocked market cap / P/E on the screener AND supplies
// the next earnings date, which the analyzer needs to flag "earnings inside
// your holding window" — the single most common way an ATR-based stop fails.
//
// Sources (both free, no API key):
//   • NASDAQ /api/quote/{t}/summary   → market cap, 52w range, avg volume, yield
//   • NASDAQ /api/analyst/{t}/earnings-date → next estimated earnings date
//
// Returns { NVDA: { marketCap, marketCapRaw, peRatio, avgVolume, yield,
//                   fiftyTwoWeek: {high, low}, earningsDate, earningsInDays } }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

function parseMoney(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

async function fetchSummary(sym) {
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/summary?assetclass=stocks`,
      { headers: HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const s = data?.data?.summaryData;
    if (!s) return null;
    const val = (k) => s[k]?.value ?? null;

    const mcRaw = parseMoney(val('MarketCap'));
    // 52-week range comes as "$236.54/$164.07"
    let high52 = null, low52 = null;
    const range = val('FiftTwoWeekHighLow');
    if (range) {
      const parts = String(range).split('/').map(parseMoney);
      high52 = parts[0] ?? null;
      low52 = parts[1] ?? null;
    }
    return {
      marketCapRaw: mcRaw,
      marketCap: mcRaw != null ? mcRaw / 1e9 : null,   // in $B for the screener
      peRatio: parseMoney(val('PERatio')),
      forwardPE: parseMoney(val('ForwardPE1Yr')),
      eps: parseMoney(val('EarningsPerShare')),
      beta: parseMoney(val('Beta')),
      avgVolume: parseMoney(val('AverageVolume')),
      yieldPct: parseMoney(val('Yield')),
      fiftyTwoWeek: { high: high52, low: low52 },
    };
  } catch { return null; }
}

async function fetchEarningsDate(sym) {
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-date`,
      { headers: HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.data?.reportText || '';
    // "…estimated to report earnings on  08/26/2026. The upcoming earnings…"
    const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    const iso = `${yyyy}-${mm}-${dd}`;
    const ts = Date.parse(iso + 'T00:00:00Z');
    if (isNaN(ts)) return null;
    return {
      date: iso,
      daysAway: Math.round((ts - Date.now()) / 86400000),
      // NASDAQ sources these from Zacks; before the company confirms they are
      // algorithmic estimates. Flag that honestly rather than implying certainty.
      estimated: /derived from an algorithm|estimated/i.test(text),
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  const raw = (req.query && req.query.tickers) || '';
  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((t) => !t.startsWith('^') && !t.includes('='))
    .slice(0, 40);

  if (!tickers.length) {
    res.status(400).json({ error: 'Pass ?tickers=NVDA,PLTR,...' });
    return;
  }

  const results = await Promise.all(
    tickers.map(async (t) => {
      const [summary, earnings] = await Promise.all([fetchSummary(t), fetchEarningsDate(t)]);
      return [t, { ...(summary || {}), earnings }];
    })
  );

  const out = {};
  for (const [t, v] of results) {
    if (v && (v.marketCap != null || v.earnings)) out[t] = v;
  }

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200'); // fundamentals move slowly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ asOf: Date.now(), fundamentals: out });
}

// Vercel serverless: /api/quotes?tickers=NVDA,PLTR,...&range=1y
// Fetches Yahoo Finance chart endpoint (no auth required) per ticker in parallel.
// Returns 1y OHLC + volume — enough for 200d MA, RSI(14), ATR(14), volume expansion.

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const CHART = (sym, range, withDivs) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}${withDivs ? '&events=div' : ''}`;

async function fetchOne(sym, range, withDivs = false) {
  const res = await fetch(CHART(sym, range, withDivs), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${sym}: HTTP ${res.status}`);
  const data = await res.json();
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r) throw new Error(`${sym}: no result`);
  const meta = r.meta || {};
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const ts = r.timestamp || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o != null && h != null && l != null && c != null && v != null) {
      bars.push({ t: ts[i] * 1000, o, h, l, c, v });
    }
  }
  const price = meta.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : null);
  // chartPreviousClose is the anchor of the requested range, not yesterday's close — use the
  // penultimate bar instead so change/changePct reflect the actual intraday move.
  const prevClose = bars.length >= 2 ? bars[bars.length - 2].c : null;
  const change = prevClose != null && price != null ? price - prevClose : null;
  const changePct = prevClose && price != null ? (change / prevClose) * 100 : null;
  // Trailing-12-month cash dividends per share from Yahoo's dividend events (for yield screens).
  let dividends = null;
  if (withDivs) {
    const ev = Object.values(r?.events?.dividends || {});
    const cutoff = Date.now() / 1000 - 370 * 86400;
    const ttm = ev.filter((d) => d.date >= cutoff);
    dividends = { ttmPerShare: +ttm.reduce((s, d) => s + (d.amount || 0), 0).toFixed(4), payments12m: ttm.length, last: ttm.length ? { date: new Date(Math.max(...ttm.map((d) => d.date)) * 1000).toISOString().slice(0, 10), amount: ttm.sort((a, b) => b.date - a.date)[0].amount } : null };
  }
  return {
    ...(dividends ? { dividends } : {}),
    price,
    prevClose,
    change,
    changePct,
    volume: meta.regularMarketVolume ?? (bars.length ? bars[bars.length - 1].v : null),
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    bars,
    currency: meta.currency || 'USD',
    asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(),
  };
}

export default async function handler(req, res) {
  const raw = (req.query && req.query.tickers) || '';
  const range = ((req.query && req.query.range) || '1y').toString();
  const validRange = ['3mo', '6mo', '1y', '2y', '5y', '10y', 'max'].includes(range) ? range : '1y';   // 5y/max: stress tests and seasonality need the 2020 and 2022 drawdowns

  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z^][A-Z0-9.\-^=]{0,11}$/.test(s))        // strict symbol shape: no injection into upstream URLs or regexes
    .slice(0, 60);

  if (tickers.length === 0) {
    res.status(400).json({ error: 'Pass ?tickers=NVDA,PLTR,...' });
    return;
  }

  const withDivs = String(req.query?.dividends || '') === '1';
  const results = await Promise.allSettled(tickers.map((t) => fetchOne(t, validRange, withDivs)));
  const out = {};
  const errors = {};
  results.forEach((r, i) => {
    const t = tickers[i];
    if (r.status === 'fulfilled') out[t] = r.value;
    else errors[t] = String(r.reason && r.reason.message || r.reason);
  });

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  res.status(200).json({
    build: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 8) : null,   // lets an open tab notice a new deploy
    asOf: Date.now(),
    range: validRange,
    quotes: out,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
}

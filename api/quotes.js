// Vercel serverless: /api/quotes?tickers=NVDA,PLTR,...&range=1y
// Fetches Yahoo Finance chart endpoint (no auth required) per ticker in parallel.
// Returns 1y OHLC + volume — enough for 200d MA, RSI(14), ATR(14), volume expansion.

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const CHART = (sym, range) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`;

async function fetchOne(sym, range) {
  const res = await fetch(CHART(sym, range), { headers: { 'User-Agent': UA } });
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
  return {
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
  const validRange = ['3mo', '6mo', '1y', '2y'].includes(range) ? range : '1y';

  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 60);

  if (tickers.length === 0) {
    res.status(400).json({ error: 'Pass ?tickers=NVDA,PLTR,...' });
    return;
  }

  const results = await Promise.allSettled(tickers.map((t) => fetchOne(t, validRange)));
  const out = {};
  const errors = {};
  results.forEach((r, i) => {
    const t = tickers[i];
    if (r.status === 'fulfilled') out[t] = r.value;
    else errors[t] = String(r.reason && r.reason.message || r.reason);
  });

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    range: validRange,
    quotes: out,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
}

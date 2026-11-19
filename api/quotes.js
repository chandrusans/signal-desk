// Vercel serverless: /api/quotes?tickers=NVDA,PLTR,...&range=1y
//
// Daily OHLC + volume and the live price for up to 60 symbols: enough for the 200-day average,
// RSI(14), ATR(14) and volume expansion. Prices come from Alpaca's Market Data API when the server
// has keys, and from Yahoo for what Alpaca does not carry or cannot answer; see _prices.js.
//   &dividends=1   adds trailing-12-month dividends (Yahoo only)
//   &source=yahoo  forces the Yahoo path, for comparing the two sources

import { getQuotes } from './_prices.js';

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
  const force = String(req.query?.source || '') === 'yahoo' ? 'yahoo' : null;
  const { quotes, errors, source } = await getQuotes(tickers, validRange, { withDivs, force });

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  res.status(200).json({
    build: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 8) : null,   // lets an open tab notice a new deploy
    asOf: Date.now(),
    range: validRange,
    source,
    quotes,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
}

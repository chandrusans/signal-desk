# Signal Desk

A momentum-swing signals dashboard for self-directed equity research. Pulls live prices from Yahoo Finance, computes real technical indicators, ranks tickers by a transparent composite score, and produces ATR-based trade plans with mechanical entry/exit rules.

**Not investment advice.** This is a research tool. See in-page disclosure.

## What it does

- **Live prices**: 1-year OHLC + volume via Yahoo Finance chart API (no auth key). Polls every 30 seconds.
- **Real analytics**: SMA (10/20/50/200), RSI(14), ATR(14), 20d/60d returns, 52-week high distance, volume expansion.
- **Composite score (0–100)**: transparent breakdown — trend (30) + momentum (25) + location (20) + volume (15) + volatility (10).
- **Setup classifier**: `BREAKOUT`, `PULLBACK`, `EARLY`, `EXTENDED`, `BROKEN`, `AVOID` — each with mechanical entry rules.
- **Trade plans**: ATR-derived stops (`max(1.5×ATR, 5%)`, capped at 10%), 2.5R targets, 15 trading-day time stops.
- **Regime filter**: fetches ^VIX; halves sizing at 20–25, blocks new longs above 25.
- **Screener**: filters 20+ tickers by score, market cap, P/E, momentum, sentiment, setup state.

## Structure

```
signal-desk/
├── index.html         Dashboard UI (all inline CSS/JS)
├── analyze.js         Pure computation module — indicators, score, setup, trade plan
├── api/
│   └── quotes.js      Vercel serverless function — Yahoo Finance proxy
└── vercel.json        Static + serverless config
```

## Local dev

`index.html` uses `<script type="module">` and fetches `/api/quotes`, so it needs a real server (not `file://`). Options:

```bash
# Option A — Vercel CLI (recommended, runs the api function too)
npx vercel dev

# Option B — any static server + real API function URL
# The dashboard will show "feed unavailable" without the API
```

## Deploy to Vercel

```bash
npx vercel        # first time — links project
npx vercel --prod # deploy
```

Vercel auto-detects `api/quotes.js` as a serverless function. No env vars needed.

## API

`GET /api/quotes?tickers=NVDA,PLTR,^VIX&range=1y`

Returns:

```json
{
  "asOf": 1721671200000,
  "range": "1y",
  "quotes": {
    "NVDA": {
      "price": 213.95,
      "prevClose": 208.65,
      "change": 5.30,
      "changePct": 2.54,
      "volume": 84303132,
      "dayHigh": 214.39,
      "dayLow": 204.95,
      "fiftyTwoWeekHigh": 219.5,
      "fiftyTwoWeekLow": 86.6,
      "bars": [{ "t": 1721140800000, "o": 205.1, "h": 208.9, "l": 204.7, "c": 208.65, "v": 78432100 }, ...],
      "currency": "USD",
      "asOf": 1721671200000
    }
  }
}
```

## What's not live yet

Currently mock: composite hand-picked ticker list, Reddit/news/insider narratives in the intel feed, sector/market-cap/P/E in the screener. Roadmap: `api/reddit.js` (PRAW), `api/news.js` (Finnhub free tier), `api/fundamentals.js`.

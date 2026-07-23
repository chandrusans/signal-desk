# Signal Desk

A momentum-swing signals dashboard for self-directed equity research. Pulls live prices from Yahoo Finance, computes real technical indicators, ranks tickers by a transparent composite score, and produces ATR-based trade plans with mechanical entry/exit rules.

**Not investment advice.** This is a research tool. See in-page disclosure.

**Beginners**: read the handbook at `/handbook` (or `handbook.html` in this repo). It explains the point system, setup states, trade plans, and every feature in plain language, with a versioned changelog.

**Contributors**: `CLAUDE.md` at the repo root spells out the handbook maintenance rule — any change to scoring, setups, indicators, or data sources requires a same-commit update to `handbook.html`.

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

## What's live

- Prices, OHLC, volume, VIX regime → `/api/quotes` (Yahoo Finance)
- News headlines + keyword-based sentiment per ticker → `/api/news` (Yahoo Finance search)
- News sentiment feeds into the composite score as a **catalyst adjustment** (max ±10 pts)

## What's still mock

- The pinned ticker list is hand-picked (NVDA / PLTR / CRWD / HOOD / ASML) — Round 3 would auto-populate from top-scoring universe candidates
- Insider / options-flow / analyst-rating narratives in the intel feed still hardcoded
- Screener market cap and P/E values still hardcoded (need Finnhub free tier)

## Trader Buzz — activating paid / auth-gated sources

The `/api/buzz` endpoint is modular: each source is a self-contained function that returns `[]` when its env var is missing, and starts returning data the moment you set it. Nothing else needs to change — the drawer's filter chips and footer auto-detect what's active.

### Vercel setup for each source

Open your Vercel project → **Settings** → **Environment Variables** and add the ones you want, then trigger a redeploy.

| Source | Env vars | Pricing | Setup |
|---|---|---|---|
| **StockTwits** | *(none — always on)* | Free | Nothing to do |
| **CNBC RSS** | *(none — always on)* | Free | Nothing to do |
| **X (Twitter) v2** | `X_BEARER_TOKEN` | ~$100/mo Basic tier | Register at [developer.x.com](https://developer.x.com), create app, copy Bearer Token |
| **Reddit** | `REDDIT_CLIENT_ID`<br/>`REDDIT_CLIENT_SECRET`<br/>`REDDIT_USER_AGENT` | Free | 1) [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → Create app → type **script**<br/>2) Copy client_id (under app name) and secret<br/>3) `REDDIT_USER_AGENT` example: `signal-desk/1.0 by yourhandle` |
| **QuiverQuant** (Congress trades) | `QUIVER_API_KEY` | from $10/mo | [api.quiverquant.com/docs](https://api.quiverquant.com/docs/) — sign up, get key |
| **Finnhub** (news + analyst grades) | `FINNHUB_API_KEY` | Free tier (60 req/min) | [finnhub.io](https://finnhub.io/) — register, copy API key |

**Verifying activation:**
- Open `/api/buzz?tickers=NVDA` — the JSON response includes an `active` map showing which env-var sources are wired
- The drawer footer shows live sources in green (`●`) and dormant ones with their env var setup hint
- Filter chips (ALL / STOCKTWITS / CNBC / X / REDDIT / …) appear automatically as sources come online

**Adding a new source:**
Drop another `fetchXyz(tickers)` function into `api/buzz.js` following the same pattern:
```js
async function fetchXyz(tickers) {
  const key = process.env.XYZ_API_KEY;
  if (!key) return [];              // silent skip when unconfigured
  // …fetch…
  return items;                     // each: { src, speaker, tickers, sent, text, ts, link }
}
```
Add it to the `Promise.all` in the handler and the `active` map. Done.

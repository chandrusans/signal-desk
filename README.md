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
├── index.html         Stocks UI (all inline CSS/JS)
├── dashboard.html     Personal portfolio tracker
├── options.html       Options recommendations
├── crypto.html        Crypto — rankings + measured-edge reality check
├── metals.html        Gold / silver
├── handbook.html      Beginner reference + changelog (see CLAUDE.md — keep current)
├── analyze.js         Pure computation — indicators, score, setup, trade plan
├── backtest.js        Point-in-time backtest + walk-forward validation
├── api/
│   ├── quotes.js      Yahoo Finance proxy (bars, 60-ticker cap)
│   ├── universe.js    S&P 500 constituents + GICS sectors, 24h edge cache
│   ├── scan.js        Batch server-side scorer — ~400-byte rows per ticker
│   ├── news.js        Headlines + sentiment
│   ├── buzz.js        StockTwits + CNBC aggregator
│   ├── options.js     NASDAQ option chains + recommendation engine
│   ├── option-quote.js  Live per-contract premiums by OCC symbol
│   ├── fundamentals.js  Market cap, P/E, earnings dates
│   ├── crypto-universe.js  Top coins by mcap ∩ Coinbase USD pairs
│   ├── crypto-scan.js      Batch crypto scorer, BTC as benchmark
│   ├── crypto-hours.js     Hour-of-day returns + Bonferroni significance test
│   └── crypto-backtest.js  Crypto backtest + venue fee sweep
├── tools/
│   ├── devserver.mjs  Local server routing /api/* to the handler modules
│   └── lint.mjs       Undefined-function detector for inline scripts
└── vercel.json        Static + serverless config
```

### Why scoring is server-side

The candidate list covers the whole S&P 500. At a year of daily bars that's
~13MB of raw payload — past Vercel's response limit and hopeless on mobile.
`/api/scan` scores in batches of 50 and returns ~400 bytes per ticker, so the
full index arrives in ~195KB. Full bar history is fetched for the single ticker
the user opens. A side benefit is that every client sees identical scores.

## Local dev

`index.html` uses `<script type="module">` and fetches `/api/quotes`, so it needs a real server (not `file://`). Options:

```bash
# Option A — the bundled dev server (no install, routes /api/* to the same
# handler modules Vercel runs)
node tools/devserver.mjs 3000

# Option B — Vercel CLI
npx vercel dev
```

If upstream fetches fail with `unable to get local issuer certificate`, you're
behind a TLS-intercepting proxy. Node doesn't read the macOS keychain; export it
and point Node at the result:

```bash
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > /tmp/ca.pem
security find-certificate -a -p /Library/Keychains/System.keychain >> /tmp/ca.pem
NODE_EXTRA_CA_CERTS=/tmp/ca.pem node tools/devserver.mjs 3000
```

### Checks before committing

```bash
node tools/lint.mjs index.html dashboard.html options.html crypto.html metals.html handbook.html
```

This catches called-but-never-defined functions in the inline `<script>` blocks —
a class of bug `node --check` cannot see, and one that has silently killed the
page bootstrap before.

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

`GET /api/universe` → S&P 500 constituents with GICS sector and sector ETF.

`GET /api/scan?tickers=AAPL,MSFT,...&sectors=AAPL:XLK,MSFT:XLK`

Scores up to 80 tickers per call. Returns compact rows — `t` ticker, `p` price,
`sc` score, `su` setup, `rs` / `srs` relative strength vs SPY and sector,
`stop` / `tgt` plan levels, `spark` a 20-point sparkline.

### Crypto: fees decide the outcome

The crypto momentum strategy earns roughly **+0.06R per trade before costs** over
~5 years across the liquid majors — thin but positive. At Coinbase's retail taker
fee of 60 bps a side (120 bps round trip) that becomes **negative**. Breakeven
sits far below retail pricing, so venue choice is a bigger lever on this strategy
than coin choice.

`/api/crypto-backtest` computes this live and returns a fee sweep across venue
tiers. The Crypto page shows it above the rankings and does not let it be
dismissed — a screen that looks authoritative while losing money is worse than no
screen. Asset-class costs and stop bounds live in `CLASS_CFG` in `backtest.js`.

Hour-of-day timing is measured, not asserted: `/api/crypto-hours` t-tests all 24
hours against zero with a Bonferroni correction. On the majors tested, no hour
survives it.

## What's live

- S&P 500 constituents + GICS sectors → `/api/universe`
- Index-wide composite scores → `/api/scan` (server-side, all ~500 names)
- Prices, OHLC, volume, VIX regime → `/api/quotes` (Yahoo Finance)
- Market breadth — % of the full index above its own 50d MA, computed from the scan
- News headlines + keyword-based sentiment per ticker → `/api/news` (Yahoo Finance search)
- News sentiment feeds into the composite score as a **catalyst adjustment** (max ±10 pts)
- Crypto prices, daily/hourly candles → Coinbase Exchange public API (no key)
- Crypto universe + market caps → CoinGecko free tier, intersected with Coinbase USD pairs
- Crypto backtest + fee sweep → `/api/crypto-backtest`, computed live and cached 6h

## What's still mock

- Insider / options-flow / analyst-rating narratives in the intel feed still hardcoded
- Lower screener table's market cap and P/E values still hardcoded (need Finnhub free tier)
- Political calendar is a curated array in `index.html`, not scraped

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

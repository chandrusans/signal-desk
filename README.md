# Signal Desk

A momentum-swing signals dashboard for self-directed equity research. Pulls live prices from Yahoo Finance, computes real technical indicators, ranks tickers by a transparent composite score, and produces ATR-based trade plans with mechanical entry/exit rules.

**Not investment advice.** This is a research tool. See in-page disclosure.

**Beginners**: read the handbook at `/handbook` (or `handbook.html` in this repo). It explains the point system, setup states, trade plans, and every feature in plain language, with a versioned changelog.

**Contributors**: `CLAUDE.md` at the repo root spells out the handbook maintenance rule — any change to scoring, setups, indicators, or data sources requires a same-commit update to `handbook.html`.

## Start with /today

The **Today** tab is the whole desk reduced to three plain-English questions:
should I trade today (macro + regime gates as a traffic light), what qualifies
right now across stocks, options, crypto and metals, and what to leave alone.
Enter your capital once and every card is sized — shares or contracts, and the
most you can lose. It calls the same endpoints and applies the same rules as
every other tab; it just puts the answer first. `?preview=open` forces the gates
open for display only, so the cards can be seen on a day the real gate is shut.

## Simulate: paper auto-trading

`/simulate` lets the rulebook trade pretend money over a window you choose and
shows every decision, including open positions marked to the last close. It is
layered like an auto-invest product — strategy (`analyze.js`), execution engine
(`backtest.js`), accounting (the page) — but the scheduler is "replay on open":
a paper portfolio is a pure function of config and market history, so saved
simulations store settings only and are recomputed from bars on every visit.
No cron, no database, no drift. **No real order is ever placed.**

## Alerts

`/alerts` watches a ticker list for the seven things traders are told to watch
(big move, breaking news, earnings result, analyst rating, insider trade,
deal/lawsuit, sentiment shift), one written rule each in `alerts.js`, with
browser notifications via `sw.js`. Notifications work while a tab is open
anywhere in the browser; true push with the browser closed needs a subscription
store this app does not have. First run captures a baseline and fires nothing
old. Insider trades were measured before shipping (see handbook ch. 19): sells
were followed by outperformance, buys were not significant on n=22.

## Phone alerts

`/api/notify` runs the same alert engine server-side on a GitHub Actions
schedule (`.github/workflows/alerts.yml`) and sends to Telegram, WhatsApp
(CallMeBot) or ntfy. State lives in a private Vercel Blob (connect a Blob
store to the project → `BLOB_READ_WRITE_TOKEN`); the scheduler authenticates
with `RUN_KEY` (Vercel env + repo secret). User steps: handbook ch. 21.

## Sell alerts for what you hold

Track from any card (Today, Stocks, Options, Crypto, Metals) and the position is
saved with that card's stop and target. The Dashboard shows a live verdict
(SELL / TRIM / WATCH / HOLD) and the Alerts tab notifies on it. Both call
`positionVerdict()` in `exits.js` — one rulebook, so they cannot disagree.
Handbook ch. 20 lists every rule.

## Profile screen (nightly batch)

`.github/workflows/screen.yml` runs `tools/build-screen.mjs` each weeknight:
every S&P 500 name through the forensic module (SEC XBRL), the scan, five
years of price history and NASDAQ, written to `data/screen.json` (~270 KB)
and committed. Research → "profile screen" ranks that file in the browser
(`screen.js`: five percentile components, profile weights, hard filters) and
prints when it was built and what each source covered. Local build:
`npm run screen:build` (needs the CA bundle, see Validation). Handbook ch. 24.

## What it does

- **Live prices**: 1-year OHLC + volume via Yahoo Finance chart API (no auth key). Polls every 15s (Stocks) / 20s (Crypto) behind a 30s edge cache.
- **Real analytics**: SMA (10/20/50/200), RSI(14), ATR(14), 20d/60d returns, 52-week high distance, volume expansion.
- **Composite score (0–100)**: transparent breakdown — trend (30) + momentum (25) + location (20) + volume (15) + volatility (10).
- **Setup classifier**: `BREAKOUT`, `PULLBACK`, `EARLY`, `EXTENDED`, `BROKEN`, `AVOID` — each with mechanical entry rules.
- **Trade plans**: ATR-derived stops (`max(1.5×ATR, 5%)`, capped at 10%), 2.5R targets, 15 trading-day time stops.
- **Regime filter**: fetches ^VIX; halves sizing at 20–25, blocks new longs above 25.
- **Screener**: filters 20+ tickers by score, market cap, P/E, momentum, sentiment, setup state.

## Structure

```
signal-desk/
├── today.html         START HERE — one page, three questions, all four markets
├── alerts.html        Seven alert types + browser notifications (engine in alerts.js)
├── simulate.html      Paper auto-trading — the rulebook trades pretend money
├── index.html         Stocks UI (all inline CSS/JS)
├── dashboard.html     Personal portfolio tracker
├── options.html       Options recommendations
├── crypto.html        Crypto — rankings + measured-edge reality check
├── metals.html        Gold / silver
├── research.html      Research tab — forensics, earnings brief, DCF, patterns, screen, compare, dividends, plan
├── dcf.js             Forward DCF (editable assumptions, two terminal methods, sensitivity)
├── indicators.js      Display-only indicators + seasonality / drawdown / liquidity / rate-beta tests
├── screen.js          Profile-driven ranking of the universe (percentile components, weights, filters)
├── views.js           Compare, dividend blueprint, allocation-plan and screen views
├── data/screen.json   Nightly screen file (built by tools/build-screen.mjs via screen.yml)
├── risk.js            Risk engine (book-level limits) + trade journal, shared by Today and Dashboard
├── handbook.html      Beginner reference + changelog (see CLAUDE.md — keep current)
├── analyze.js         Pure computation — indicators, score, setup, trade plan
├── exits.js           The ONE exit rulebook — shared by Dashboard and Alerts
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
│   ├── intel.js            Router: ?op=macro|congress|earnings|analyst|insider
│   ├── notify.js           Phone alerts: sync | run | test | status (Blob state)
│   ├── _macro-calendar.js    ForexFactory calendar (FairEconomy feed) — event gate
│   ├── _congress.js          STOCK Act PTRs from the Clerk of the House
│   ├── _earnings.js          NASDAQ actual-vs-consensus results
│   ├── _analyst.js           per-firm rating events (stockanalysis.com) + NASDAQ consensus
│   ├── _insider.js           SEC EDGAR Form 4 open-market insider trades
│   ├── crypto.js           Router: ?op=universe|scan|hours|backtest|pumpfun
│   ├── _crypto-universe.js   Top coins by mcap ∩ Coinbase USD pairs
│   ├── _crypto-scan.js       Batch crypto scorer, BTC as benchmark
│   ├── _crypto-hours.js      Hour-of-day returns + Bonferroni significance
│   ├── _crypto-backtest.js   Crypto backtest + venue fee sweep
│   └── _pumpfun.js           pump.fun exit-risk screen (DexScreener)
├── tools/
│   ├── devserver.mjs  Local server routing /api/* to the handler modules
│   ├── build-screen.mjs  Nightly screen builder (filings + scan + history + NASDAQ → data/screen.json)
│   └── lint.mjs       Undefined-function detector for inline scripts
└── vercel.json        Static + serverless config
```

### Function budget

Vercel's Hobby plan allows **12 Serverless Functions per deployment**. The four
crypto endpoints are therefore merged behind one `api/crypto.js` router
(`?op=universe|scan|hours|backtest|pumpfun|bars`); the handlers live in `_crypto-*.js`, where
the underscore keeps Vercel from routing them separately. Exceeding the cap fails
at the "Deploying outputs" step with the build itself green — which reads like a
code error but isn't. Count `ls api/*.js | grep -v /_` before adding a route.

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

### Validate against the last session

```bash
npm run validate
```

(`sh tools/validate.sh` does the same.) On macOS the wrapper exports your
keychain to `~/.config/signal-desk/ca.pem` once and points Node at it — without
that, Node ignores the system keychain and every HTTPS fetch fails with
`unable to get local issuer certificate` behind a TLS-inspecting proxy. The app
on Vercel is unaffected; only local Node runs are.

Runs the deployed app against independent sources — NASDAQ historical closes,
NASDAQ's earnings calendar, CoinGecko — recomputes ATR/stop/target from raw
bars, checks the big-move alert rule against the day's actual S&P 500 movers,
and tests point-in-time verdicts against next-day returns over 20 sessions.
11 checks; the 2026-10-22 run found and fixed one rule gap (high-ATR names
slipping under a pure 2×ATR big-move bar).

```bash
npm run validate:co
```

The same for crypto and options: coin prices against CoinGecko, the coin
big-move rule against the day's actual movers, coin news resolution, the
crypto regime, crypto and option exit rules, breakeven and max-loss
arithmetic on every live option recommendation, and that an option SELL
verdict produces a position alert. 12 checks. The 20-session crypto BUY/SELL
cohort comparison is printed as a finding, not a pass/fail — a month is too
small a sample, and the multi-year backtest on the Crypto tab is the verdict.

```bash
npm run validate:risk
```

Pure arithmetic, no network: the risk engine (`risk.js`) — per-trade risk,
portfolio heat, daily loss limit, position cap, concentration warning — and the
journal's R-multiples, win rate, expectancy and profit factor, plus the exit
rulebook's initial-stop and regime behaviour. 28 checks.

```bash
npm run validate:research
```

The forensic module (`api/_forensic.js`) against real filers: Apple's FY2025
net income and operating cash flow match the 10-K to the dollar, Nvidia's
share count is split-adjusted, JPMorgan degrades to "not meaningful" for a
bank, historical multiples are sane, the implied-growth solver reproduces
the market cap, and the research endpoint shape is stable, debt is not double-counted, EV nets
long-term investments, and a bank gets P/E only. 36 checks.

```bash
npm test
```

Unit tests (node:test) for the pure modules — exit rulebook, risk engine and
journal, UI escaping/formatting, analysis plan, forward DCF, indicators and
statistical tests, the profile screen — no network. 37 tests. CI runs them with
the lint and `npm audit` on every push.

### Security model

- The site is same-origin only: a strict Content-Security-Policy, no third-
  party scripts, no wildcard CORS, strict symbol validation on every endpoint.
- All third-party text goes through `esc()` in `ui.js`; links through `safeHref()`.
- Phone alerts: the scheduler sends `Authorization: Bearer RUN_KEY`; the
  first sync that claims the server store must present the same key once;
  channel secrets live only in the private Blob store and are never returned.
- Positions, journal, capital and the sync key are stored in the browser's
  localStorage in plain text — this is a single-user tool; do not use it on a
  shared device, and export your data.

### Checks before committing

```bash
node tools/lint.mjs today.html alerts.html simulate.html index.html dashboard.html options.html crypto.html metals.html handbook.html
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

`/api/crypto?op=backtest` computes this live and returns a fee sweep across venue
tiers. The Crypto page shows it above the rankings and does not let it be
dismissed — a screen that looks authoritative while losing money is worse than no
screen. Asset-class costs and stop bounds live in `CLASS_CFG` in `backtest.js`.

Hour-of-day timing is measured, not asserted: `/api/crypto?op=hours` t-tests all 24
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
- Crypto backtest + fee sweep → `/api/crypto?op=backtest`, computed live and cached 6h
- Economic calendar → `/api/intel?op=macro` (FairEconomy feed behind ForexFactory)
- Congressional trades → `/api/intel?op=congress` (House Clerk STOCK Act PTRs, PDF-parsed)
- Earnings results → `/api/intel?op=earnings` (NASDAQ actual vs consensus)
- Analyst per-firm events + consensus → `/api/intel?op=analyst` (stockanalysis.com ratings page for events; NASDAQ for consensus)
- Insider trades → `/api/intel?op=insider` (SEC EDGAR Form 4, open-market P/S only)
- pump.fun tokens → `/api/crypto?op=pumpfun` (DexScreener public API, pumpswap pairs)

### pump.fun: an exit-risk screen

In a live ~220-pair sample only **22%** are exitable (liquidity ≥ $10k and 24h
volume ≥ $1k), ~37% report no liquidity, and median 24h volume collapses from
about **$4,500 on day one to under $60 after a week**. The binding constraint is
not picking the right token — it is being able to sell one.

So the screen scores exit risk (high is bad) and gives a max position sized at 1%
of pool liquidity. It does not rank tokens to buy. Note both biases run the same
direction: only graduated tokens are indexed, and DexScreener search ranks by
activity — a 10-query sample reported 73% exitable where 40 queries gives 22%.

### External sources: what's gated vs what's only shown

**Macro calendar gates verdicts.** A high-impact US release inside 24h forces
AVOID; inside 48h it halves sizing. It is a risk control — it never predicts
direction, only that a gap can jump your stop.

**Congressional trades do not.** Measured across 2,379 disclosed 2026
transactions, excess return vs SPY from the notification date was −0.49% at +20d
for BUYs (t=−1.39) and −0.34% for SELLs (t=−0.99) — nothing significant, and
disclosed buys slightly under-performed. Median disclosure lag is 18 days, so
the edge is gone before you can see it. It renders as a context badge and is
excluded from the composite score.

Neither site is scraped. forexfactory.com/calendar and capitoltrades.com both
block bots; the calendar comes from the publisher's own JSON feed and the
congressional data from the primary government filings.

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

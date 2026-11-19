// Prices for /api/quotes and /api/scan: daily bars plus the live price, per symbol.
// (The underscore keeps Vercel from routing this as a function of its own.)
//
// SOURCE ORDER
//   1. Alpaca Market Data API — licensed, keyed, one request for many symbols. Used for plain US
//      stocks and ETFs whenever ALPACA_KEY_ID / ALPACA_SECRET_KEY are set on the server.
//   2. Yahoo Finance chart endpoint — for what Alpaca does not carry (^VIX and other indices,
//      futures such as GC=F, rates, the dollar index), for dividend history, and as the fallback
//      for any symbol or request Alpaca fails on. A data outage at one source therefore degrades
//      to the other instead of to an empty page.
//
// PLANS. The same code serves both Alpaca plans; ALPACA_DATA_FEED selects the live feed:
//   • Basic (free), the default, ALPACA_DATA_FEED unset or "iex":
//       history   feed=sip — every US exchange, consolidated volume — which the free plan allows for
//                 anything older than 15 minutes (the API's default `end` on this plan);
//       live      feed=iex — real-time last trade from the IEX exchange only. IEX carries a few
//                 percent of volume, so the PRICE is current but its day volume is not the market's;
//                 today's volume is therefore taken from the 15-minute-old consolidated bar, or
//                 scaled up from IEX volume when that bar is not there yet.
//   • Algo Trader Plus, set ALPACA_DATA_FEED=sip after upgrading:
//       live      feed=sip — real-time consolidated price and volume; nothing is estimated.
//
// Bars are split-adjusted (as Yahoo's are), not dividend-adjusted, so stops and targets are in
// prices a broker would show.

const DATA_HOST = 'https://data.alpaca.markets';
const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const DAY = 864e5;
const RANGE_DAYS = { '3mo': 95, '6mo': 186, '1y': 368, '2y': 733, '5y': 1830, '10y': 3660, max: 4020 };
const nyDate = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const utcDate = (t) => new Date(t).toISOString().slice(0, 10);

const regularHours = (ms) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)).split(':').map(Number); const t = h * 60 + m; return t >= 570 && t <= 960; };
export const dataConfigured = (env = process.env) => !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY);
export const liveFeed = (env = process.env) => (String(env.ALPACA_DATA_FEED || '').trim().toLowerCase() === 'sip' ? 'sip' : 'iex');
/** The Alpaca spelling of an app ticker (BRK-B → BRK.B), or null for things Alpaca's stock API does not carry. */
export function toAlpaca(t) {
  const s = String(t || '').toUpperCase().replace(/-/g, '.');
  return /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(s) ? s : null;
}

// ── Yahoo ────────────────────────────────────────────────────────────────
export async function yahooQuote(sym, range = '1y', withDivs = false, fetchFn = fetch) {
  const res = await fetchFn(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}${withDivs ? '&events=div' : ''}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${sym}: HTTP ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`${sym}: no result`);
  const meta = r.meta || {}, q = r.indicators?.quote?.[0] || {}, ts = r.timestamp || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o != null && h != null && l != null && c != null && v != null) bars.push({ t: ts[i] * 1000, o, h, l, c, v });
  }
  const price = meta.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : null);
  // chartPreviousClose is the anchor of the requested range, not yesterday's close — use the
  // penultimate bar instead so change/changePct reflect the actual intraday move.
  const prevClose = bars.length >= 2 ? bars[bars.length - 2].c : null;
  const change = prevClose != null && price != null ? price - prevClose : null;
  let dividends = null;
  if (withDivs) {
    const ev = Object.values(r?.events?.dividends || {});
    const cutoff = Date.now() / 1000 - 370 * 86400;
    const ttm = ev.filter((d) => d.date >= cutoff);
    dividends = { ttmPerShare: +ttm.reduce((s, d) => s + (d.amount || 0), 0).toFixed(4), payments12m: ttm.length, last: ttm.length ? { date: new Date(Math.max(...ttm.map((d) => d.date)) * 1000).toISOString().slice(0, 10), amount: ttm.sort((a, b) => b.date - a.date)[0].amount } : null };
  }
  return {
    ...(dividends ? { dividends } : {}),
    price, prevClose, change, changePct: prevClose && price != null ? (change / prevClose) * 100 : null,
    volume: meta.regularMarketVolume ?? (bars.length ? bars[bars.length - 1].v : null),
    dayHigh: meta.regularMarketDayHigh ?? null, dayLow: meta.regularMarketDayLow ?? null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null, fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    bars, currency: meta.currency || 'USD', asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now(), src: 'yahoo',
  };
}

// ── Alpaca ───────────────────────────────────────────────────────────────
async function alpacaGet(path, env, fetchFn) {
  const r = await fetchFn(DATA_HOST + path, { headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY, Accept: 'application/json' } });
  if (!r.ok) { let m = ''; try { m = (await r.json())?.message || ''; } catch { /* no body */ } throw Object.assign(new Error(`Alpaca data ${r.status}${m ? ': ' + String(m).slice(0, 100) : ''}`), { status: r.status }); }
  return r.json();
}
/** Daily bars for many symbols in one (paginated) request: { SYM: [{ t, o, h, l, c, v }] }, oldest first. */
export async function alpacaBars(symbols, days, env, fetchFn = fetch, now = Date.now()) {
  const out = {};
  const base = `/v2/stocks/bars?symbols=${encodeURIComponent(symbols.join(','))}&timeframe=1Day&start=${utcDate(now - days * DAY)}&limit=10000&adjustment=split&feed=sip&sort=asc`;
  let token = null;
  for (let page = 0; page < 16; page++) {
    const d = await alpacaGet(base + (token ? `&page_token=${encodeURIComponent(token)}` : ''), env, fetchFn);
    for (const [sym, list] of Object.entries(d.bars || {})) {
      const a = (out[sym] ||= []);
      for (const b of list) if (b.o > 0 && b.c > 0) a.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    token = d.next_page_token || null;
    if (!token) break;
  }
  return out;
}
export async function alpacaSnapshots(symbols, feed, env, fetchFn = fetch) {
  const d = await alpacaGet(`/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=${feed}`, env, fetchFn);
  return d && d.snapshots ? d.snapshots : d || {};
}

/**
 * One symbol's quote from its history (consolidated bars) and its live snapshot.
 * The last bar is always "today so far" once the session has traded: its close is the live price.
 */
export function assemble(history, snap, { feed = 'iex', now = Date.now() } = {}) {
  const bars = (history || []).map((b) => ({ ...b }));
  if (!bars.length) return null;
  let last = bars[bars.length - 1];
  const lastDay = utcDate(last.t), db = snap?.dailyBar, snapDay = db?.t ? String(db.t).slice(0, 10) : null;
  const trade = snap?.latestTrade, tradeDay = trade?.t ? nyDate(Date.parse(trade.t)) : null;
  // The live trade sets the price only when it is from the regular session (09:30–16:00 New York) and
  // not older than the last bar we hold. Before the open and after the close, the consolidated bar's own
  // close is the better number: an odd-lot after-hours print on one exchange is not "the price".
  let price = trade?.p > 0 && tradeDay && tradeDay >= lastDay && regularHours(Date.parse(trade.t)) ? trade.p : null;
  let estimatedVolume = false;
  if (snapDay && snapDay > lastDay && db.o > 0) {
    // The consolidated history does not have today yet (first minutes of the session on the free plan):
    // build today's bar from the live feed.
    let v = db.v || 0;
    if (feed !== 'sip') {
      // IEX sees a small, fairly steady share of each stock's volume: scale by yesterday's ratio.
      const pv = snap?.prevDailyBar, same = pv?.t && String(pv.t).slice(0, 10) === lastDay && pv.v > 0;
      v = Math.round(v * (same ? Math.min(400, Math.max(1, last.v / pv.v)) : 35));
      estimatedVolume = true;
    }
    const p = price ?? db.c;
    bars.push({ t: Date.parse(db.t), o: db.o, h: Math.max(db.h, p), l: Math.min(db.l, p), c: p, v });
    last = bars[bars.length - 1]; price = p;
  } else if (price != null && (snapDay === lastDay || tradeDay === lastDay)) {
    last.c = price; last.h = Math.max(last.h, price); last.l = Math.min(last.l, price);
  }
  if (price == null) price = last.c;
  const prevClose = bars.length >= 2 ? bars[bars.length - 2].c : null;
  const change = prevClose != null ? price - prevClose : null;
  const yr = bars.slice(-252);
  return {
    price, prevClose, change, changePct: prevClose ? (change / prevClose) * 100 : null,
    volume: last.v, dayHigh: last.h, dayLow: last.l,
    fiftyTwoWeekHigh: bars.length >= 200 ? Math.max(...yr.map((b) => b.h)) : null, fiftyTwoWeekLow: bars.length >= 200 ? Math.min(...yr.map((b) => b.l)) : null,
    bars, currency: 'USD', asOf: trade?.t ? Date.parse(trade.t) : now, src: 'alpaca', ...(estimatedVolume ? { volumeEstimated: true } : {}),
  };
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/**
 * Quotes for a list of app tickers. Returns { quotes, errors, source: { alpaca, yahoo, feed, note? } }.
 *   force: 'yahoo' skips Alpaca (dividend history needs Yahoo; also handy for comparing the two).
 */
export async function getQuotes(tickers, range = '1y', { env = process.env, fetchFn = fetch, withDivs = false, force = null, now = Date.now() } = {}) {
  const quotes = {}, errors = {}, source = { alpaca: 0, yahoo: 0, feed: null };
  const useAlpaca = dataConfigured(env) && force !== 'yahoo' && !withDivs;
  const map = new Map();                                   // alpaca symbol → app ticker
  if (useAlpaca) for (const t of tickers) { const a = toAlpaca(t); if (a) map.set(a, t); }
  if (map.size) {
    const feed = liveFeed(env), days = RANGE_DAYS[range] || RANGE_DAYS['1y'];
    source.feed = feed;
    // Keep each request to a few pages: about 20,000 bars a call.
    const per = Math.max(4, Math.min(50, Math.floor(20000 / (days * 0.7))));
    const groups = chunk([...map.keys()], per);
    let i = 0;
    const worker = async () => {
      while (i < groups.length) {
        const g = groups[i++];
        try {
          const [hist, snaps] = await Promise.all([alpacaBars(g, days, env, fetchFn, now), alpacaSnapshots(g, feed, env, fetchFn).catch(() => ({}))]);
          for (const a of g) { const q = assemble(hist[a], snaps[a], { feed, now }); if (q) { quotes[map.get(a)] = q; source.alpaca++; } }
        } catch (e) { source.note = String(e.message || e).slice(0, 120); }      // this group falls through to Yahoo below
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, groups.length) }, worker));
  }
  const rest = tickers.filter((t) => !quotes[t]);
  const results = await Promise.allSettled(rest.map((t) => yahooQuote(t, range, withDivs, fetchFn)));
  results.forEach((r, k) => { if (r.status === 'fulfilled') { quotes[rest[k]] = r.value; source.yahoo++; } else errors[rest[k]] = String(r.reason?.message || r.reason); });
  return { quotes, errors, source };
}

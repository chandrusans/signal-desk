import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getQuotes, assemble, toAlpaca, liveFeed, dataConfigured } from '../api/_prices.js';

const ENV = { ALPACA_KEY_ID: 'PKTEST', ALPACA_SECRET_KEY: 'secret-not-real' };
const NOW = Date.parse('2026-11-19T17:00:00Z');                       // Thursday, noon in New York
const day = (iso, c, v = 1_000_000) => ({ t: `${iso}T05:00:00Z`, o: c - 1, h: c + 1, l: c - 2, c, v, n: 10, vw: c });
const HIST = (c0 = 100) => [day('2026-11-16', c0), day('2026-11-17', c0 + 1), day('2026-11-18', c0 + 2)];
const json = (o, status = 200) => ({ ok: status < 300, status, json: async () => o });
const yahooBody = (c) => ({ chart: { result: [{ meta: { regularMarketPrice: c, currency: 'USD' }, timestamp: [1795000000, 1795086400], indicators: { quote: [{ open: [c, c], high: [c, c], low: [c, c], close: [c - 1, c], volume: [5, 6] }] } }] } });

/** A pretend internet: Alpaca's data host and Yahoo's chart endpoint. */
function net({ bars = {}, snaps = {}, alpacaStatus = 200, pages = null } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url); calls.push({ host: u.host, path: u.pathname, q: Object.fromEntries(u.searchParams), key: opts.headers?.['APCA-API-KEY-ID'] });
    if (u.host === 'data.alpaca.markets') {
      if (alpacaStatus !== 200) return json({ code: 42210000, message: 'subscription does not permit querying recent SIP data' }, alpacaStatus);
      if (u.pathname === '/v2/stocks/bars') {
        if (pages) { const i = u.searchParams.get('page_token') ? +u.searchParams.get('page_token') : 0; return json({ bars: pages[i], next_page_token: i + 1 < pages.length ? String(i + 1) : null }); }
        const want = u.searchParams.get('symbols').split(','); return json({ bars: Object.fromEntries(want.filter((s) => bars[s]).map((s) => [s, bars[s]])), next_page_token: null });
      }
      if (u.pathname === '/v2/stocks/snapshots') return json(snaps);
    }
    if (u.host === 'query1.finance.yahoo.com') return json(yahooBody(decodeURIComponent(u.pathname.split('/').pop()) === '^VIX' ? 22 : 50));
    return json({}, 404);
  };
  return { fetchFn, calls };
}

test('which symbols Alpaca can serve, and which plan is in use', () => {
  assert.equal(toAlpaca('AAPL'), 'AAPL'); assert.equal(toAlpaca('BRK-B'), 'BRK.B'); assert.equal(toAlpaca('brk.b'), 'BRK.B');
  for (const t of ['^VIX', 'GC=F', 'DX-Y.NYB', '^TNX', 'TOOLONGX']) assert.equal(toAlpaca(t), null, t);
  assert.equal(liveFeed({}), 'iex'); assert.equal(liveFeed({ ALPACA_DATA_FEED: 'SIP' }), 'sip'); assert.equal(liveFeed({ ALPACA_DATA_FEED: 'anything' }), 'iex');
  assert.equal(dataConfigured({}), false); assert.equal(dataConfigured(ENV), true);
});

test('stocks come from Alpaca in one call; the index comes from Yahoo; the request asks for consolidated, split-adjusted daily bars', async () => {
  const n = net({ bars: { AAPL: HIST(100), MSFT: HIST(500) }, snaps: {} });
  const r = await getQuotes(['AAPL', 'MSFT', '^VIX'], '1y', { env: ENV, fetchFn: n.fetchFn, now: NOW });
  assert.deepEqual(r.source, { alpaca: 2, yahoo: 1, feed: 'iex' });
  assert.equal(r.quotes.AAPL.src, 'alpaca'); assert.equal(r.quotes['^VIX'].src, 'yahoo'); assert.equal(r.quotes['^VIX'].price, 22);
  const barsCall = n.calls.find((c) => c.path === '/v2/stocks/bars');
  assert.equal(barsCall.q.symbols, 'AAPL,MSFT'); assert.equal(barsCall.q.feed, 'sip'); assert.equal(barsCall.q.adjustment, 'split'); assert.equal(barsCall.q.timeframe, '1Day');
  assert.equal(barsCall.q.end, undefined, 'no end: the free plan then defaults to 15 minutes ago instead of refusing');
  assert.equal(n.calls.filter((c) => c.host === 'data.alpaca.markets').length, 2, 'one bars call and one snapshot call for the whole batch');
  assert.equal(n.calls.find((c) => c.path === '/v2/stocks/snapshots').q.feed, 'iex');
  assert.equal(r.quotes.MSFT.bars.length, 3); assert.equal(r.quotes.MSFT.price, 502); assert.equal(r.quotes.MSFT.prevClose, 501);
});

test('a result that comes back in pages is stitched together', async () => {
  const n = net({ pages: [{ AAPL: [day('2026-11-16', 100), day('2026-11-17', 101)] }, { AAPL: [day('2026-11-18', 102)], MSFT: HIST(500) }] });
  const r = await getQuotes(['AAPL', 'MSFT'], '1y', { env: ENV, fetchFn: n.fetchFn, now: NOW });
  assert.deepEqual(r.quotes.AAPL.bars.map((b) => b.c), [100, 101, 102]); assert.equal(r.quotes.MSFT.bars.length, 3);
});

test('if Alpaca refuses or is down, every symbol still gets a price from Yahoo and the reason is reported', async () => {
  const n = net({ alpacaStatus: 403 });
  const r = await getQuotes(['AAPL', 'SPY'], '1y', { env: ENV, fetchFn: n.fetchFn, now: NOW });
  assert.equal(r.source.alpaca, 0); assert.equal(r.source.yahoo, 2); assert.match(r.source.note, /Alpaca data 403/);
  assert.equal(r.quotes.AAPL.src, 'yahoo'); assert.deepEqual(r.errors, {});
  // a symbol Alpaca has no bars for (a new listing, a typo) falls back on its own
  const m = net({ bars: { AAPL: HIST() } });
  const r2 = await getQuotes(['AAPL', 'NEWCO'], '1y', { env: ENV, fetchFn: m.fetchFn, now: NOW });
  assert.equal(r2.quotes.AAPL.src, 'alpaca'); assert.equal(r2.quotes.NEWCO.src, 'yahoo');
});

test('without keys, or when dividends are asked for, or when forced, it is Yahoo only and Alpaca is never called', async () => {
  for (const o of [{ env: {} }, { env: ENV, withDivs: true }, { env: ENV, force: 'yahoo' }]) {
    const n = net({ bars: { AAPL: HIST() } });
    const r = await getQuotes(['AAPL'], '1y', { fetchFn: n.fetchFn, now: NOW, ...o });
    assert.equal(r.quotes.AAPL.src, 'yahoo'); assert.ok(n.calls.every((c) => c.host !== 'data.alpaca.markets'));
  }
});

test('today so far: the live trade sets the close of today\'s bar and widens its range', () => {
  const hist = [...HIST(100), day('2026-11-19', 103, 400_000)].map((b) => ({ ...b, t: Date.parse(b.t) }));
  const snap = { latestTrade: { p: 106.5, t: '2026-11-19T16:59:30Z' }, dailyBar: day('2026-11-19', 103, 9_000), prevDailyBar: day('2026-11-18', 102, 25_000) };
  const q = assemble(hist, snap, { feed: 'iex', now: NOW });
  assert.equal(q.price, 106.5); assert.equal(q.bars.length, 4); assert.equal(q.bars[3].c, 106.5); assert.equal(q.bars[3].h, 106.5);
  assert.equal(q.volume, 400_000, 'consolidated volume from the 15-minute-old bar, not IEX\'s 9,000'); assert.equal(q.prevClose, 102);
  assert.ok(Math.abs(q.changePct - ((106.5 / 102 - 1) * 100)) < 1e-9); assert.equal(q.volumeEstimated, undefined);
});

test('first minutes of the session on the free plan: today\'s bar is built from IEX, with volume scaled to the whole market', () => {
  const hist = HIST(100).map((b) => ({ ...b, t: Date.parse(b.t) }));                 // ends yesterday, 1,000,000 shares
  const snap = { latestTrade: { p: 103.2, t: '2026-11-19T14:40:00Z' }, dailyBar: { ...day('2026-11-19', 103, 2_000), o: 102.5, h: 103.4, l: 102.4 }, prevDailyBar: day('2026-11-18', 102, 25_000) };
  const q = assemble(hist, snap, { feed: 'iex', now: Date.parse('2026-11-19T14:41:00Z') });
  assert.equal(q.bars.length, 4); assert.equal(q.price, 103.2); assert.equal(q.bars[3].o, 102.5);
  assert.equal(q.volume, 80_000, '2,000 IEX shares × (1,000,000 consolidated ÷ 25,000 IEX yesterday)'); assert.equal(q.volumeEstimated, true);
  const sip = assemble(hist, snap, { feed: 'sip', now: NOW });
  assert.equal(sip.volume, 2_000, 'on the paid feed the snapshot is already the whole market'); assert.equal(sip.volumeEstimated, undefined);
});

test('outside the session the official close stands: an after-hours or stale print does not move the price', () => {
  const hist = HIST(100).map((b) => ({ ...b, t: Date.parse(b.t) }));
  const afterHours = { latestTrade: { p: 99.1, t: '2026-11-18T23:10:00Z' }, dailyBar: day('2026-11-18', 102, 20_000) };   // 6:10 pm New York
  assert.equal(assemble(hist, afterHours, { now: NOW }).price, 102);
  const stale = { latestTrade: { p: 90, t: '2026-11-12T16:00:00Z' }, dailyBar: day('2026-11-12', 90, 100) };              // a thin name: last IEX trade a week ago
  const q = assemble(hist, stale, { now: NOW }); assert.equal(q.price, 102); assert.equal(q.bars.length, 3);
  assert.equal(assemble(hist, undefined, { now: NOW }).price, 102, 'no snapshot at all');
  assert.equal(assemble([], undefined), null);
});

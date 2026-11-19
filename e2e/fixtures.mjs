// Made-up market data for the browser tests. Nothing here is real or copied from a data provider:
// prices are generated, and the six "stocks" are arranged so that each rule has one clear example.
//
//   KMI  breakout, score 92          → a BUY when the gate is open
//   DIS  pullback, score 80          → a BUY when the gate is open (the only kind allowed at VIX 20–25)
//   XOM  2-day RSI 5 above the 200d  → a mean-reversion BUY
//   AAPL early · JNJ extended · MSFT broken → never buys

const DAY = 864e5;
/** n daily bars ending today, walking from `from` to `to`. */
export function bars(n, from, to) {
  const out = [], now = Date.now();
  for (let i = 0; i < n; i++) { const c = from + ((to - from) * i) / (n - 1), w = 1 + 0.004 * Math.sin(i * 1.7); out.push({ t: now - (n - 1 - i) * DAY, o: c * 0.998, h: c * 1.006 * w, l: c * 0.994, c, v: 5e6 }); }
  return out;
}
const SCAN = {
  KMI: { t: 'KMI', p: 34.43, c: 1.2, sc: 92, su: 'BREAKOUT', rsi: 64, atr: 2.5, r20: 9, r60: 14, rs: 13.4, srs: 6, d52: -1, vr: 1.4, a50: true, a200: true, rsi2: 70, ma5: 34, stop: 32.71, tgt: 38.73, reason: 'New 20-day high on volume' },
  DIS: { t: 'DIS', p: 120, c: 0.4, sc: 80, su: 'PULLBACK', rsi: 52, atr: 2.2, r20: 5, r60: 9, rs: 6.1, srs: 3, d52: -4, vr: 0.9, a50: true, a200: true, rsi2: 35, ma5: 119, stop: 114, tgt: 135, reason: 'Dip to the 10-day average in an uptrend' },
  XOM: { t: 'XOM', p: 100, c: -1.8, sc: 48, su: 'AVOID', rsi: 41, atr: 1.9, r20: -2, r60: 4, rs: -1, srs: -2, d52: -8, vr: 1.1, a50: false, a200: true, rsi2: 5, ma5: 102, stop: 95, tgt: 112.5, reason: 'No clean setup on this bar' },
  AAPL: { t: 'AAPL', p: 350, c: 0.2, sc: 60, su: 'EARLY', rsi: 55, atr: 1.8, r20: 2, r60: 5, rs: 1, srs: 0, d52: -6, vr: 1, a50: true, a200: true, rsi2: 55, ma5: 349, stop: 332.5, tgt: 393.75, reason: 'Uptrend forming' },
  JNJ: { t: 'JNJ', p: 270, c: 0.6, sc: 75, su: 'EXTENDED', rsi: 74, atr: 1.4, r20: 8, r60: 12, rs: 7, srs: 4, d52: 0, vr: 1.2, a50: true, a200: true, rsi2: 90, ma5: 268, stop: 256.5, tgt: 303.75, reason: 'More than 6% above its 20-day' },
  MSFT: { t: 'MSFT', p: 500, c: -0.9, sc: 20, su: 'BROKEN', rsi: 38, atr: 2, r20: -7, r60: -9, rs: -8, srs: -5, d52: -15, vr: 1.3, a50: false, a200: false, rsi2: 20, ma5: 505, stop: 475, tgt: 562.5, reason: 'Below its 50-day average' },
};
const NAMES = { KMI: 'Kinder Morgan', DIS: 'Walt Disney', XOM: 'Exxon Mobil', AAPL: 'Apple', JNJ: 'Johnson & Johnson', MSFT: 'Microsoft' };
const spark = (p) => Array.from({ length: 20 }, (_, i) => +(p * (0.95 + 0.0025 * i)).toFixed(2));

/**
 * Answer every /api call from fixtures. `opts`:
 *   vix (default 14, a calm market) · indexDown (S&P 500 below its 50-day) · macro ('clear') · earningsDays (60)
 */
export async function mockApi(page, opts = {}) {
  const o = { vix: 14, indexDown: false, macro: 'clear', earningsDays: 60, ...opts };
  const seen = [];
  const quote = (t) => {
    if (t === 'SPY') { const b = o.indexDown ? bars(260, 760, 640) : bars(260, 560, 700); return { price: b.at(-1).c, changePct: o.indexDown ? -1.1 : 0.6, bars: b }; }
    if (t === '^VIX') return { price: o.vix, changePct: -2, bars: bars(260, o.vix + 2, o.vix) };
    const row = SCAN[t], p = row ? row.p : 100;
    return { price: p, changePct: row ? row.c : 0.1, prevClose: p / (1 + (row ? row.c : 0.1) / 100), bars: bars(260, p * 0.8, p) };
  };
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url()), name = u.pathname.replace('/api/', ''), q = u.searchParams, op = q.get('op') || '';
    if (name === 'vault') return route.continue();                       // sync is tested against the real handler
    seen.push(name + (op ? `?op=${op}` : ''));
    const list = (k) => (q.get(k) || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    let body = {};
    if (name === 'universe') body = { constituents: Object.keys(SCAN).map((s) => ({ symbol: s, name: NAMES[s], sector: 'Energy', sectorEtf: 'XLE' })) };
    else if (name === 'scan') body = { asOf: Date.now(), rows: list('tickers').filter((t) => SCAN[t]).map((t) => ({ ...SCAN[t], spark: spark(SCAN[t].p) })) };
    else if (name === 'quotes') body = { asOf: Date.now(), quotes: Object.fromEntries(list('tickers').map((t) => [t, quote(t)])) };
    else if (name === 'fundamentals') { const d = new Date(Date.now() + o.earningsDays * DAY).toISOString().slice(0, 10); body = { fundamentals: Object.fromEntries(list('tickers').map((t) => [t, { marketCap: 1e11, peRatio: 20, earnings: { date: d, daysAway: o.earningsDays, estimated: false, when: 'post' } }])) }; }
    else if (name === 'intel' && op === 'macro' && o.macro === 'unavailable') body = { error: 'calendar feed unavailable', events: [], macroRisk: null };
    else if (name === 'intel' && op === 'macro') body = { asOf: Date.now(), macroRisk: { level: o.macro, sizeMult: o.macro === 'clear' ? 1 : 0.5, note: o.macro === 'clear' ? 'No high-impact US release inside the window.' : 'A release is close.', next: null }, counts: { total: 2, high: 0, usdHigh: 0 }, events: [] };
    else if (name === 'intel') body = { results: {} };
    else if (name === 'news') body = { news: {} };
    else if (name === 'crypto' && op === 'universe') body = { constituents: [{ symbol: 'BTC', name: 'Bitcoin' }, { symbol: 'ETH', name: 'Ethereum' }] };
    else if (name === 'crypto' && op === 'scan') body = { rows: [], btc: null };
    else if (name === 'options') body = { recommendations: [] };
    else if (name === 'notify') body = { ok: false, error: 'not set up in tests' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { seen };
}

/** Collect page errors and console errors so a test can assert there were none. */
export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return errors;
}

/** Answer the app's own in-page dialog: optionally type into it, then press its main button. */
export async function answerDialog(page, value) {
  const d = page.locator('dialog[open]');
  await d.waitFor({ state: 'visible' });
  const text = (await d.locator('.sd-msg').innerText().catch(() => '')) || '';
  if (value != null) await d.locator('input, textarea').first().fill(String(value));
  await d.locator('button.ok').click();
  // The app reuses one <dialog> element, and the next question can open in the same tick: wait until
  // this question is gone (closed, or replaced by a different one), not merely for "no dialog".
  await page.waitForFunction((was) => { const x = document.querySelector('dialog[open]'); return !x || (x.querySelector('.sd-msg')?.innerText || '') !== was; }, text, { timeout: 8000 }).catch(() => {});
  return text;
}

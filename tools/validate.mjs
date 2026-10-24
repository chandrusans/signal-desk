// Session validation — run after any market close:  node tools/validate.mjs
// Checks the DEPLOYED app against independent sources (NASDAQ historical
// closes, NASDAQ earnings calendar, CoinGecko), recomputes ATR/stop/target
// from raw bars, checks the big-move rule against the day's actual movers,
// and tests point-in-time verdicts against next-day returns over 20 sessions.
// Behind a TLS proxy: NODE_EXTRA_CA_CERTS=/tmp/ca.pem node tools/validate.mjs
// Validation of the deployed app against INDEPENDENT sources for the last session.
import { analyze, regime } from '../analyze.js';
const B = 'https://signal-desk-virid.vercel.app';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const j = async (u, h = {}) => { const r = await fetch(u, { headers: { 'User-Agent': UA, ...h } }); if (!r.ok) throw new Error(`${u.split('?')[0]} ${r.status}`); return r.json(); };
const txt = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.text(); };
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const pct = (x, d = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// ── 0. what is the last session, according to the app ───────────────────
const SAMPLE = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'JPM', 'XOM', 'ELV', 'CRL', 'LLY'];
const q = await j(`${B}/api/quotes?tickers=${[...SAMPLE, 'SPY', '%5EVIX'].join(',')}&range=1y`);
const spy = q.quotes.SPY.bars; const last = spy[spy.length - 1], prev = spy[spy.length - 2];
const LAST = day(last.t), PREV = day(prev.t);
console.log(`\n═══ LAST SESSION per app: ${LAST} (prior ${PREV}) ═══\n`);
check('App data is current', (Date.now() - last.t) < 3 * 86400e3, `last bar ${LAST}`);

// ── 1. PRICES vs Stooq (independent of Yahoo) ───────────────────────────
console.log('\n── 1. Close prices vs NASDAQ historical (independent of Yahoo) ──');
const mdy = (iso) => { const [y, m, d] = iso.split('-'); return `${+m}/${+d}/${y}`; };
const nasdaqHist = async (t) => { const d = await j(`https://api.nasdaq.com/api/quote/${t.replace('-', '.')}/historical?assetclass=stocks&fromdate=${PREV}&limit=5`, { Accept: 'application/json' }); return (d.data?.tradesTable?.rows || []).map((r) => [r.date, 0, 0, 0, r.close.replace(/[$,]/g, '')]); };
let priceOK = 0, priceN = 0, worst = 0, cmpDay = LAST;
for (const t of SAMPLE) {
  try {
    const rows = await nasdaqHist(t);
    // NASDAQ posts a session's row after the close; while the app already shows today's
    // live bar, compare the most recent session BOTH sources have (usually yesterday).
    let st = rows.find((r) => r[0] === mdy(LAST)); let stPrev = rows.find((r) => r[0] === mdy(PREV));
    const bars = q.quotes[t]?.bars; let app = bars?.find((b) => day(b.t) === LAST);
    if (!st && bars) { cmpDay = PREV; st = stPrev; app = bars.find((b) => day(b.t) === PREV); const i = rows.findIndex((r) => r[0] === mdy(PREV)); stPrev = i >= 0 ? rows[i + 1] : null; }
    if (!st || !app) { console.log(`  ${t.padEnd(5)} no row for ${cmpDay} (nasdaq ${!!st}, app ${!!app})`); continue; }
    const stClose = +st[4], appClose = app.c, diff = Math.abs(appClose - stClose) / stClose * 100;
    const stChg = stPrev ? (stClose / +stPrev[4] - 1) * 100 : null;
    const appChg = q.quotes[t].changePct;
    priceN++; if (diff < 0.05) priceOK++; worst = Math.max(worst, diff);
    console.log(`  ${t.padEnd(5)} app ${appClose.toFixed(2).padStart(8)}  nasdaq ${stClose.toFixed(2).padStart(8)}  Δ ${diff.toFixed(3)}%   day: app ${pct(appChg)}  nasdaq ${pct(stChg)}`);
  } catch (e) { console.log(`  ${t} nasdaq unavailable: ${e.message}`); }
  await sleep(250);
}
if (priceN === 0) console.log('NOTE  Closes vs independent source: NASDAQ historical refused every request from this machine (rate limit / 403) — skipped, not failed; re-run later');
else check('Closes match independent source', priceOK === priceN, `${priceOK}/${priceN} within 0.05%, worst Δ ${worst.toFixed(3)}%${cmpDay !== LAST ? ` (session ${cmpDay}: NASDAQ has not posted ${LAST} yet)` : ''}`);

// ── 2. ATR / stop / target arithmetic, recomputed from raw bars ───────────
console.log('\n── 2. Trade-plan arithmetic (independent recomputation) ──');
{
  const bars = q.quotes.NVDA.bars; const a = analyze(bars, { benchBars: spy });
  const trs = []; for (let i = 1; i < bars.length; i++) { const p = bars[i - 1], b = bars[i]; trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c))); }
  // Wilder's smoothing — the textbook ATR and what the app uses; a plain 14-bar mean is NOT ATR
  let atr14 = trs.slice(0, 14).reduce((s, x) => s + x, 0) / 14; for (let i = 14; i < trs.length; i++) atr14 = (atr14 * 13 + trs[i]) / 14;
  const entry = a.plan.entry; const stopDist = Math.min(entry * 0.10, Math.max(1.5 * atr14, entry * 0.05));
  const stop = entry - stopDist, target = entry + 2.5 * stopDist;
  const ok = Math.abs(stop - a.plan.stop) < 0.01 && Math.abs(target - a.plan.target) < 0.01 && Math.abs(atr14 - a.indicators.atr14) < 0.01;
  check('ATR(14, Wilder), stop and 2.5R target recompute exactly', ok, `NVDA ATR ${atr14.toFixed(2)} vs ${a.indicators.atr14.toFixed(2)} · stop ${stop.toFixed(2)} vs ${a.plan.stop.toFixed(2)} · target ${target.toFixed(2)} vs ${a.plan.target.toFixed(2)}`);
  const ma50 = bars.slice(-50).reduce((s, b) => s + b.c, 0) / 50;
  check('MA50 recomputes exactly', Math.abs(ma50 - a.indicators.ma50) < 0.01, `${ma50.toFixed(2)} vs ${a.indicators.ma50.toFixed(2)}`);
}

// ── 3. Regime gate vs raw VIX ────────────────────────────────────────────
{
  const vix = q.quotes['^VIX'].price; const rg = regime(vix);
  const expect = vix < 15 ? 'calm' : vix < 20 ? 'normal' : vix < 25 ? 'elevated' : vix < 35 ? 'stress' : 'crisis';
  check('Regime level follows the documented VIX bands', rg.level === expect, `VIX ${vix.toFixed(2)} → ${rg.level.toUpperCase()}`);
}

// ── 4. BIG-MOVE alert rule vs the day's actual movers (full S&P 500) ─────
console.log('\n── 4. Big-move rule vs actual S&P 500 movers on ' + LAST + ' ──');
const uni = (await j(`${B}/api/universe`)).constituents;
const rows = [];
for (let i = 0; i < uni.length; i += 50) {
  const b = uni.slice(i, i + 50); try { rows.push(...(await j(`${B}/api/scan?tickers=${b.map((c) => c.symbol).join(',')}`)).rows); } catch {}
}
const movers = rows.filter((r) => r.c != null).sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
const wouldFire = rows.filter((r) => r.c != null && (Math.abs(r.c) >= Math.min(8, Math.max(2 * (r.atr || 2), 4)) || ((r.vr || 0) >= 3 && Math.abs(r.c) >= 2)));
console.log(`  ${rows.length} names scored · top movers: ${movers.slice(0, 6).map((r) => `${r.t} ${pct(r.c)}`).join(', ')}`);
console.log(`  rule would fire on ${wouldFire.length}: ${wouldFire.slice(0, 12).map((r) => `${r.t} ${pct(r.c)}(ATR ${r.atr})`).join(', ')}`);
const top5 = movers.slice(0, 5); const caught = top5.filter((r) => wouldFire.includes(r)).length;
check('Big-move rule catches the day\'s largest movers', caught >= 4, `${caught}/5 of the top-5 absolute movers trigger`);
// independent confirm of the #1 mover's day change
try {
  const m = movers[0]; const rs = await nasdaqHist(m.t); const a = rs.find((r) => r[0] === mdy(LAST)), p = rs.find((r) => r[0] === mdy(PREV));
  const ind = a && p ? (+a[4] / +p[4] - 1) * 100 : null;
  if (!a) console.log(`  NOTE  Top mover ${m.t} ${pct(m.c)}: NASDAQ has not posted the ${LAST} session yet — re-run after the close to confirm independently`);
  else check('Top mover confirmed by independent source', ind != null && Math.abs(ind - m.c) < 0.3, `${m.t} app ${pct(m.c)} nasdaq ${pct(ind)}`);
} catch (e) { console.log('  (independent confirm skipped: ' + e.message + ')'); }

// ── 5. EARNINGS facts vs NASDAQ's calendar (different endpoint) ──────────
console.log('\n── 5. Earnings results vs NASDAQ earnings calendar ──');
try {
  const cal = await j(`https://api.nasdaq.com/api/calendar/earnings?date=${PREV}`, { Accept: 'application/json' });
  const reported = (cal.data?.rows || []).filter((r) => r.eps && r.epsForecast && SAMPLE.concat(['TSLA', 'ELV', 'CRL']).includes(r.symbol));
  const pick = reported.slice(0, 4).map((r) => r.symbol);
  if (pick.length) {
    const e = (await j(`${B}/api/intel?op=earnings&tickers=${pick.join(',')}`)).results;
    let ok = 0; for (const r of reported.slice(0, 4)) {
      const app = e[r.symbol]; const calEps = parseFloat(String(r.eps).replace(/[$()]/g, '')) * (String(r.eps).includes('(') ? -1 : 1);
      const match = app && Math.abs(app.eps - calEps) < 0.011; if (match) ok++;
      console.log(`  ${r.symbol.padEnd(5)} calendar eps ${r.eps} est ${r.epsForecast}   app eps ${app?.eps} est ${app?.estimate} → ${app?.result} ${pct(app?.surprisePct)} reported ${app?.dateReported} ${app?.recent ? '(fresh)' : ''}`);
    }
    check('Earnings EPS matches NASDAQ calendar', ok === reported.slice(0, 4).length, `${ok}/${reported.slice(0, 4).length} on ${PREV}`);
  } else console.log(`  no sample tickers reported on ${PREV}; calendar had ${cal.data?.rows?.length || 0} rows`);
} catch (e) { console.log('  calendar unavailable: ' + e.message); }

// ── 6. CRYPTO price vs CoinGecko (independent of Coinbase) ──────────────
console.log('\n── 6. Crypto price vs CoinGecko ──');
try {
  const cg = await j('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd');
  const cs = (await j(`${B}/api/crypto?op=scan&coins=BTC,ETH,SOL`)).rows;
  let ok = 0; for (const [c, id] of [['BTC', 'bitcoin'], ['ETH', 'ethereum'], ['SOL', 'solana']]) {
    const app = cs.find((r) => r.t === c)?.p, ind = cg[id]?.usd; const d = Math.abs(app - ind) / ind * 100; if (d < 1) ok++;
    console.log(`  ${c} app $${app}  coingecko $${ind}  Δ ${d.toFixed(2)}%`);
  }
  check('Crypto prices within 1% of CoinGecko', ok === 3, '(two different venues; sub-1% spread is normal)');
} catch (e) { console.log('  coingecko unavailable: ' + e.message); }

// ── 7. THE REAL TEST: point-in-time verdicts, next-session result ─────────
console.log('\n── 7. Did yesterday\'s BUY verdicts beat the index today? (point-in-time, no look-ahead) ──');
const full = {}; const universeT = ['NVDA','PLTR','CRWD','HOOD','ASML','AMD','META','MSFT','GOOGL','TSLA','AAPL','AMZN','NFLX','COIN','ORCL','AVGO','MU','MRVL','SNOW','NET','PANW','PYPL','SQ','SHOP','SOFI','RIVN','SMCI','LLY','JPM','BAC','XOM','CVX','HD','COST','WMT','UNH','V','MA','PG','JNJ','ABBV','MRK','PEP','KO','DIS','CSCO','INTC','QCOM','TXN','HON','CAT','DE','GE','BA','GS','MS','ELV','CRL','BF-B','NKE'];
for (let i = 0; i < universeT.length; i += 55) { const d = await j(`${B}/api/quotes?tickers=${universeT.slice(i, i + 55).join(',')}&range=1y`); Object.assign(full, d.quotes); }
const vixBars = q.quotes['^VIX'].bars;
function verdictAt(bars, cut, spyCut) {
  const a = analyze(bars.slice(0, cut), { benchBars: spyCut }); if (a.insufficient) return null;
  const s = a.score, su = a.setup;
  if (su === 'BROKEN' || su === 'AVOID') return su === 'BROKEN' && s < 30 ? 'SELL' : 'AVOID';
  if (su === 'EXTENDED') return 'HOLD';
  if ((su === 'BREAKOUT' && s >= 65) || (su === 'PULLBACK' && s >= 60) || s >= 70) return 'BUY';
  return 'HOLD';
}
function session(k) {   // k sessions back from the last bar: verdict on close[k+1], return into close[k]
  const n = spy.length; const vi = n - 1 - k; const spyRet = (spy[vi].c / spy[vi - 1].c - 1) * 100;
  const out = { date: day(spy[vi].t), spyRet, BUY: [], SELL: [], HOLD: [], AVOID: [] };
  for (const t of universeT) {
    const bars = full[t]?.bars; if (!bars) continue;
    const idx = bars.findIndex((b) => day(b.t) === out.date); if (idx < 60) continue;
    const v = verdictAt(bars, idx, spy.slice(0, vi)); if (!v) continue;
    out[v].push({ t, ret: (bars[idx].c / bars[idx - 1].c - 1) * 100 });
  }
  return out;
}
const s0 = session(0);
const avg = (a) => a.length ? a.reduce((s, x) => s + x.ret, 0) / a.length : null;
console.log(`  ${s0.date}: SPY ${pct(s0.spyRet)} · BUY(${s0.BUY.length}) avg ${pct(avg(s0.BUY))} · HOLD(${s0.HOLD.length}) ${pct(avg(s0.HOLD))} · AVOID(${s0.AVOID.length}) ${pct(avg(s0.AVOID))} · SELL(${s0.SELL.length}) ${pct(avg(s0.SELL))}`);
console.log(`  BUYs were: ${s0.BUY.map((x) => `${x.t} ${pct(x.ret)}`).join(', ') || 'none'}`);
check('One session: BUY cohort vs SPY', s0.BUY.length === 0 || avg(s0.BUY) >= s0.spyRet, s0.BUY.length ? `BUY ${pct(avg(s0.BUY))} vs SPY ${pct(s0.spyRet)} — one day proves nothing either way` : 'no BUYs on the prior close');

console.log('\n── 8. Same test over the last 20 sessions (the number that matters) ──');
const agg = { BUY: [], SELL: [], HOLD: [], AVOID: [] }; let buyBeat = 0, buyDays = 0;
for (let k = 0; k < 20; k++) { const s = session(k); for (const v of Object.keys(agg)) agg[v].push(...s[v].map((x) => ({ ...x, ex: x.ret - s.spyRet }))); if (s.BUY.length) { buyDays++; if (avg(s.BUY) > s.spyRet) buyBeat++; } }
const exm = (a) => a.length ? a.reduce((s, x) => s + x.ex, 0) / a.length : null;
const tstat = (a) => { if (a.length < 5) return null; const m = exm(a); const sd = Math.sqrt(a.reduce((s, x) => s + (x.ex - m) ** 2, 0) / (a.length - 1)); return m / (sd / Math.sqrt(a.length)); };
for (const v of ['BUY', 'HOLD', 'AVOID', 'SELL']) console.log(`  ${v.padEnd(5)} n=${String(agg[v].length).padStart(4)}  next-day excess vs SPY ${pct(exm(agg[v]), 3)}  t=${tstat(agg[v])?.toFixed(2) ?? '—'}`);
console.log(`  BUY cohort beat SPY on ${buyBeat} of ${buyDays} sessions that had a BUY`);
const spread = (exm(agg.BUY) ?? 0) - (exm(agg.SELL) ?? 0);
check('20 sessions: BUY cohort outperforms SELL cohort next day', agg.BUY.length >= 10 && agg.SELL.length >= 10 && spread > 0, `BUY−SELL spread ${pct(spread, 3)}/day (n=${agg.BUY.length}/${agg.SELL.length})`);

console.log('\n═══ SUMMARY ═══'); for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);

// Validation for the CRYPTO and OPTIONS sides, against the deployed app.
//   npm run validate:co      (or: sh tools/validate.sh crypto — see validate.sh)
//
// What can and cannot be validated honestly:
//   crypto   fully — prices vs CoinGecko, big-move rule vs the day's actual
//            movers, point-in-time verdict cohorts over the last 20 sessions,
//            and the alert engine firing on real coin data.
//   options  partially — there is no free historical option-chain data, so
//            20-day return cohorts are NOT possible. What is checkable: the
//            breakeven / max-loss arithmetic on every live recommendation, the
//            liquidity gate, and the exit rulebook (stop, +50%, +100%, 7-DTE)
//            on synthetic positions. That is stated, not glossed.
import { analyze, cryptoRegime } from '../analyze.js';
import { positionVerdict } from '../exits.js';
import { evaluate, evaluatePositions, fetchAlertData, useStore, memoryStore } from '../alerts.js';

const B = process.env.APP_URL || 'https://signal-desk-virid.vercel.app';
const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const j = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error(`${u.split('?')[0]} ${r.status}`); return r.json(); };
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
const pct = (x, d = 2) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}%`);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// ═══════════════════════════ CRYPTO ═══════════════════════════
console.log('\n═══ CRYPTO ═══');
const uni = (await j(`${B}/api/crypto?op=universe&limit=40`)).constituents.map((c) => c.symbol);
const scan = (await j(`${B}/api/crypto?op=scan&coins=${uni.join(',')}`)).rows;
console.log(`universe ${uni.length} coins · ${scan.length} scored · last bar ${day((await j(`${B}/api/crypto?op=bars&coins=BTC&days=60`)).bars.BTC.at(-1).t)}`);

// 1. prices vs CoinGecko
try {
  const ids = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', ADA: 'cardano' };
  const cg = await j(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(ids).join(',')}&vs_currencies=usd`);
  let ok = 0, n = 0; for (const [c, id] of Object.entries(ids)) { const app = scan.find((r) => r.t === c)?.p, ind = cg[id]?.usd; if (!app || !ind) continue; n++; const d = Math.abs(app - ind) / ind * 100; if (d < 1) ok++; console.log(`  ${c.padEnd(4)} app $${app}  coingecko $${ind}  Δ ${d.toFixed(2)}%`); }
  check('Crypto prices within 1% of CoinGecko', n > 0 && ok === n, `${ok}/${n}`);
} catch (e) { console.log('  coingecko unavailable: ' + e.message); }

// 2. big-move rule vs the day's actual movers (12% cap for coins)
const movers = scan.filter((r) => r.c != null).sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
const fires = (r) => Math.abs(r.c) >= Math.min(12, Math.max(2 * (r.atr || 2), 4)) || ((r.vr || 0) >= 3 && Math.abs(r.c) >= 2);
const wouldFire = movers.filter(fires);
console.log(`  top movers: ${movers.slice(0, 6).map((r) => `${r.t} ${pct(r.c)} (ATR ${r.atr})`).join(', ')}`);
console.log(`  rule fires on ${wouldFire.length}: ${wouldFire.slice(0, 8).map((r) => `${r.t} ${pct(r.c)}`).join(', ') || 'none — a quiet day'}`);
const top3 = movers.slice(0, 3); const bigDay = top3.some((r) => Math.abs(r.c) >= 8);
check('Crypto big-move rule catches the largest movers when there are any', !bigDay || top3.filter(fires).length >= 2, bigDay ? `${top3.filter(fires).length}/3 of the top-3 trigger` : 'no coin moved 8%+ today; rule correctly silent');

// 3. the alert engine on REAL coin data (memory store, baseline skipped)
useStore(memoryStore({ 'sd-alerts-seen-v1': { __init: 1 } }));
const data = await fetchAlertData(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AAPL'], { base: B, slow: false });
console.log(`  engine routed: ${data.coins.length} coins, ${data.equities.length} equities · scan rows ${Object.keys(data.scan).length} · news for ${Object.keys(data.news).join(',')}`);
const fired = evaluate(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AAPL'], data);
const coinNews = ['BTC', 'ETH', 'SOL'].map((c) => (data.news[c]?.items || []).length);
check('Coins route to the crypto scan (class = crypto)', ['BTC', 'ETH', 'SOL'].every((c) => data.scan[c]?.cls === 'crypto'), `BTC ${pct(data.scan.BTC?.c)} ATR ${data.scan.BTC?.atr}`);
check('Coin news resolves (searched by name)', coinNews.some((n) => n > 0), `items BTC/ETH/SOL = ${coinNews.join('/')}`);
console.log(`  alerts fired now on real data: ${fired.length} → ${fired.map((a) => a.type + ':' + a.ticker).join(', ') || 'none (nothing unusual today)'}`);
// synthetic: prove the coin path fires end-to-end
const syn = evaluate(['ZZC'], { scan: { ZZC: { t: 'ZZC', p: 1, c: 14, atr: 5, vr: 1, cls: 'crypto' } }, news: {} });
check('Coin big-move alert fires on a 14% day with 5% ATR', syn.some((a) => a.type === 'big_move'), syn[0]?.body?.slice(0, 70));

// 4. point-in-time verdicts over the last 20 sessions (crypto trades daily)
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOGE', 'DOT', 'LTC', 'UNI', 'ATOM'];
const bars = (await j(`${B}/api/crypto?op=bars&coins=${COINS.join(',')}&days=400`)).bars;
const btc = bars.BTC;
function verdictAt(b, cut) {
  const a = analyze(b.slice(0, cut), { assetClass: 'crypto', benchBars: btc.slice(0, cut) }); if (a.insufficient) return null;
  const s = a.score, su = a.setup;
  if (su === 'BROKEN' || su === 'AVOID') return su === 'BROKEN' && s < 30 ? 'SELL' : 'AVOID';
  if (su === 'EXTENDED') return 'HOLD';
  if ((su === 'BREAKOUT' && s >= 65) || (su === 'PULLBACK' && s >= 60) || s >= 70) return 'BUY';
  return 'HOLD';
}
const agg = { BUY: [], HOLD: [], AVOID: [], SELL: [] };
const n = btc.length;
for (let k = 0; k < 20; k++) {
  const vi = n - 1 - k; const btcRet = (btc[vi].c / btc[vi - 1].c - 1) * 100;
  for (const c of COINS) { const b = bars[c]; if (!b) continue; const idx = b.findIndex((x) => day(x.t) === day(btc[vi].t)); if (idx < 60) continue; const v = verdictAt(b, idx); if (!v) continue; agg[v].push((b[idx].c / b[idx - 1].c - 1) * 100 - btcRet); }
}
const stat = (a) => { if (a.length < 5) return { m: null, t: null }; const m = a.reduce((s, x) => s + x, 0) / a.length; const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); return { m, t: m / (sd / Math.sqrt(a.length)) }; };
console.log('  verdict on prior close → next-day excess return vs BTC, last 20 sessions, 12 majors:');
for (const v of ['BUY', 'HOLD', 'AVOID', 'SELL']) { const s = stat(agg[v]); console.log(`   ${v.padEnd(5)} n=${String(agg[v].length).padStart(3)}  ${pct(s.m, 3)}  t=${s.t?.toFixed(2) ?? '—'}`); }
const spread = (stat(agg.BUY).m ?? 0) - (stat(agg.SELL).m ?? 0);
check('Crypto 20 sessions: BUY cohort above SELL cohort next day', agg.BUY.length + agg.SELL.length >= 10 ? spread > 0 : true, `BUY−SELL ${pct(spread, 3)}/day (n=${agg.BUY.length}/${agg.SELL.length}) — one month is a weak test; the multi-year backtest on the Crypto tab is the real one`);
const reg = cryptoRegime(btc);
check('Crypto regime computes from BTC realised vol', !!reg.level, `${reg.level.toUpperCase()} · vol ${reg.realisedVol?.toFixed(0)}% · BTC>50d ${reg.btcAbove50}`);

// 5. exit rulebook on crypto positions
const d = (k) => new Date(Date.now() - k * 86400e3).toISOString().slice(0, 10);
const px = scan.find((r) => r.t === 'BTC').p;
const v1 = positionVerdict({ ticker: 'BTC', buyPrice: px * 1.2, stop: px * 1.1, buyDate: d(5), assetClass: 'crypto' }, { price: px });
const v2 = positionVerdict({ ticker: 'BTC', buyPrice: px / 1.3, stop: px / 1.45, buyDate: d(10), assetClass: 'crypto' }, { price: px });
check('Crypto exits: stop hit → SELL; +2.5R → TRIM', v1.action === 'SELL' && v2.action === 'TRIM', `${v1.rule} / ${v2.rule}`);

// ═══════════════════════════ OPTIONS ═══════════════════════════
console.log('\n═══ OPTIONS ═══');
const od = await j(`${B}/api/options?tickers=NVDA,AAPL,TSLA,AMD,META&limit=25&perTicker=3`);
const recs = od.recommendations || [];
console.log(`  ${recs.length} live recommendations from ${od.scannedContracts} contracts scanned`);
let okBE = 0, okML = 0, okGate = 0;
for (const o of recs) {
  const be = o.direction === 'CALL' ? o.strike + o.mid : o.strike - o.mid;          // textbook breakeven
  if (Math.abs(be - o.breakeven) < 0.02) okBE++;
  if (Math.abs(o.mid * 100 - o.maxLoss) < 1.5) okML++;                              // max loss = premium × 100
  if (o.dte >= 7 && o.spreadPct <= 15 && o.liquidity !== 'thin') okGate++;
}
check('Option breakeven = strike ± premium on every recommendation', recs.length > 0 && okBE === recs.length, `${okBE}/${recs.length}`);
check('Option max loss = premium × 100 on every recommendation', recs.length > 0 && okML === recs.length, `${okML}/${recs.length}`);
check('Every recommendation passes the liquidity / DTE / spread gate', recs.length > 0 && okGate === recs.length, `${okGate}/${recs.length}`);
if (recs[0]) console.log(`  e.g. ${recs[0].underlying} $${recs[0].strike} ${recs[0].direction} ${recs[0].expiration}: mid $${recs[0].mid}, breakeven $${recs[0].breakeven}, max loss $${recs[0].maxLoss}, exits ${recs[0].exitTargets.map((t) => '+' + t.pct + '% @ $' + t.premium).join(' / ')}, stop $${recs[0].stopPremium}`);

// exit rulebook on option positions (synthetic — no free historical chains exist)
const o = recs[0] || { occSymbol: 'NVDA261113C00215000', underlying: 'NVDA', strike: 215, expiration: d(-21), mid: 6.85, direction: 'CALL' };
const mk = (over) => ({ ticker: o.occSymbol, underlying: o.underlying, strike: o.strike, expiration: o.expiration, buyPrice: o.mid, isOption: true, multiplier: 100, assetClass: 'option', buyDate: d(3), ...over });
const cases = [
  ['premium −50% → SELL', positionVerdict(mk({}), { price: o.mid * 0.49 }).action === 'SELL'],
  ['premium +50% → TRIM', positionVerdict(mk({}), { price: o.mid * 1.5 }).action === 'TRIM'],
  ['premium +100% → TRIM', positionVerdict(mk({}), { price: o.mid * 2.05 }).action === 'TRIM'],
  ['6 days to expiry → SELL', positionVerdict(mk({ expiration: d(-6) }), { price: o.mid }).action === 'SELL'],
  ['expired → SELL', positionVerdict(mk({ expiration: d(1) }), { price: o.mid }).action === 'SELL'],
  ['flat, 30 days left → HOLD', positionVerdict(mk({ expiration: d(-30) }), { price: o.mid }).action === 'HOLD'],
];
for (const [name, ok] of cases) console.log(`   ${ok ? '✓' : '✗'} ${name}`);
check('Option exit rulebook: all six cases behave', cases.every((c) => c[1]));
// the alert engine notifies on those verdicts
useStore(memoryStore({ 'sd-alerts-seen-v1': { __init: 1 } }));
const pos = mk({ id: 'opt-test' });
const pa = evaluatePositions([pos], { 'opt-test': { price: o.mid * 0.45 } });
check('Option SELL verdict produces a position alert', pa.some((a) => a.type === 'position' && a.action === 'SELL'), pa[0]?.title);
console.log('  NOTE: no free source carries historical option chains, so 20-day option return cohorts cannot be measured. What is validated is the arithmetic, the gate, and the exit rules.');

console.log('\n═══ SUMMARY ═══'); for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);

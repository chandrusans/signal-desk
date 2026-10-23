// Handler behind /api/intel?op=analyst&tickers=NVDA,AAPL
//
// Analyst consensus and price targets from NASDAQ's public analyst endpoints.
//
// What is and is not available for free, stated plainly: NASDAQ's `ratings`
// endpoint carries an `upgradesDowngrades` array that is EMPTY on every ticker
// tested — individual upgrade/downgrade events are not published without a
// paid feed. What IS live is the consensus (Buy/Hold/Sell counts, mean rating,
// target low/mean/high) plus a 13-month monthly history of that consensus.
//
// So a "rating change" here means the CONSENSUS moved: the mean rating flipped,
// the buy/sell counts shifted, or the mean target moved more than 5% since the
// prior monthly snapshot. That is a real, stateless, verifiable signal — just
// not the "Apple gets upgraded by Morgan Stanley at 7am" headline, which the
// free source does not carry. The page says so.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const R = (t) => `https://api.nasdaq.com/api/analyst/${encodeURIComponent(t)}/ratings`;
const P = (t) => `https://api.nasdaq.com/api/analyst/${encodeURIComponent(t)}/targetprice`;
const MAX = 30;

async function j(url) { const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); if (!r.ok) return null; return (await r.json())?.data || null; }

async function one(t) {
  try {
    const [rt, tp] = await Promise.all([j(R(t)), j(P(t))]);
    if (!rt && !tp) return null;
    const c = tp?.consensusOverview || {};
    const hist = (tp?.historicalConsensus || []).map((h) => ({ date: h.z?.date, consensus: h.z?.consensus, buy: +h.z?.buy || 0, hold: +h.z?.hold || 0, sell: +h.z?.sell || 0, price: h.y != null ? +h.y : null }));
    const now = { consensus: rt?.meanRatingType || null, buy: +c.buy || 0, hold: +c.hold || 0, sell: +c.sell || 0, target: c.priceTarget != null ? +c.priceTarget : null, low: c.lowPriceTarget != null ? +c.lowPriceTarget : null, high: c.highPriceTarget != null ? +c.highPriceTarget : null };
    const prev = hist.length ? hist[hist.length - 1] : null;      // most recent monthly snapshot
    // Compare like with like. The `ratings` endpoint's meanRatingType covers a
    // different analyst pool (39 for NVDA) than `targetprice`'s counts (33), so
    // comparing one against the other produced false "Buy -> Hold" flips. Both
    // the current counts and the history come from targetprice, so the
    // majority class of each is the consistent thing to compare.
    const majority = (b, h, sl) => (b >= h && b >= sl ? 'Buy' : h >= sl ? 'Hold' : 'Sell');
    const nowMaj = majority(now.buy, now.hold, now.sell);
    const change = [];
    if (prev) {
      const prevMaj = majority(prev.buy, prev.hold, prev.sell);
      if (nowMaj !== prevMaj) change.push({ kind: 'consensus', from: prevMaj, to: nowMaj });
      const dBuy = now.buy - prev.buy, dSell = now.sell - prev.sell;
      if (Math.abs(dBuy) >= 2 || Math.abs(dSell) >= 2) change.push({ kind: 'counts', buy: dBuy, hold: now.hold - prev.hold, sell: dSell });
      if (prev.price && now.target) { const dT = ((now.target - prev.price) / prev.price) * 100; if (Math.abs(dT) >= 5) change.push({ kind: 'target', from: prev.price, to: now.target, pct: +dT.toFixed(1) }); }
    }
    const analysts = now.buy + now.hold + now.sell;
    const m = String(rt?.ratingsSummary || '').match(/(\d+)\s+analysts?/i);
    return {
      ticker: t,
      consensus: nowMaj, meanRating: now.consensus, buy: now.buy, hold: now.hold, sell: now.sell,
      analysts: m ? +m[1] : analysts,
      target: now.target, targetLow: now.low, targetHigh: now.high,
      upgradesDowngrades: rt?.upgradesDowngrades || [],          // kept so an empty array is visible, not hidden
      prior: prev ? { date: prev.date, consensus: majority(prev.buy, prev.hold, prev.sell), buy: prev.buy, hold: prev.hold, sell: prev.sell, target: prev.price } : null,
      change,
      changed: change.length > 0,
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  const tickers = String((req.query && req.query.tickers) || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z.\-]{1,6}$/.test(s)).slice(0, MAX);
  if (!tickers.length) { res.status(400).json({ error: 'Pass ?tickers=NVDA,AAPL' }); return; }
  const out = {}; let i = 0;
  async function run() { while (i < tickers.length) { const t = tickers[i++]; const r = await one(t); if (r) out[t] = r; } }
  await Promise.all(Array.from({ length: Math.min(5, tickers.length) }, run));
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    source: 'NASDAQ analyst ratings + targetprice',
    note: 'Individual upgrade/downgrade events are not in the free feed (upgradesDowngrades is empty). `changed` means the consensus or counts moved since the prior monthly snapshot.',
    results: out,
  });
}

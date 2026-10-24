// Handler behind /api/crypto?op=bars&coins=BTC,ETH&days=600
//
// Daily candles for a handful of coins, paginated from Coinbase's 300-candle
// cap. Exists for the Simulate tab, which runs the backtest engine in the
// browser and needs raw bars rather than scored rows. Capped at 15 coins so a
// request can never approach the ~13MB payload problem the equity scan solves.

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const DAY = 86400;
const MAX_COINS = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dailyBars(product, pages) {
  const now = Math.floor(Date.now() / 1000);
  const all = new Map();
  for (let p = 0; p < pages; p++) {
    const end = now - p * 300 * DAY, start = end - 300 * DAY;
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles`
      + `?granularity=${DAY}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    let got = false;
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      if (attempt) await sleep(250 * attempt);
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA } });
        if (r.status === 429) continue;
        if (!r.ok) { got = true; break; }
        const d = await r.json();
        if (!Array.isArray(d) || !d.length) { got = true; break; }
        for (const x of d) if (Array.isArray(x) && x.length >= 6 && x.every((n) => n != null)) all.set(x[0], x);
        got = true;
      } catch { /* retry */ }
    }
    await sleep(100);
  }
  // Coinbase order is [time, low, high, open, close, volume]
  return [...all.values()].sort((a, b) => a[0] - b[0])
    .map((x) => ({ t: x[0] * 1000, o: x[3], h: x[2], l: x[1], c: x[4], v: x[5] }));
}

export default async function handler(req, res) {
  const q = req.query || {};
  const coins = String(q.coins || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{2,10}$/.test(s)).slice(0, MAX_COINS);
  const days = Math.min(Math.max(parseInt(q.days || '600', 10) || 600, 60), 1500);
  const pages = Math.ceil(days / 300);
  if (!coins.length) { res.status(400).json({ error: 'Pass ?coins=BTC,ETH' }); return; }

  const bars = {};
  let i = 0;
  async function run() { while (i < coins.length) { const c = coins[i++]; bars[c] = await dailyBars(`${c}-USD`, pages); } }
  await Promise.all(Array.from({ length: Math.min(4, coins.length) }, run));

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.status(200).json({ asOf: Date.now(), coins: Object.keys(bars), bars });
}

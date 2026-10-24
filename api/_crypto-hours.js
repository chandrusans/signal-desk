// Vercel serverless: /api/crypto-hours?coin=BTC
//
// Answers "what time of day should I sell?" with measured data instead of a
// made-up rule — and, just as importantly, says when the data does not support
// an answer at all.
//
// Crypto trades 24/7, so there is no opening bell to anchor a timing rule to.
// What does exist is a possible hour-of-day effect driven by when humans are
// awake: Asia, Europe and US sessions overlap at different UTC hours. This
// endpoint measures it directly.
//
// THE STATISTICS MATTER HERE. Testing 24 hours and reporting the best one is
// textbook multiple-comparison bias: with 24 draws from pure noise, the most
// extreme will always look impressive. So every hour gets a t-test, and the
// verdict is judged against a Bonferroni-corrected threshold (alpha 0.05 / 24).
// If nothing clears it, the response says so rather than naming a "best hour".

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const HOUR = 3600;
const PAGES = 8;                                   // 8 x 300 candles ~= 100 days
const ALPHA = 0.05;
const TESTS = 24;
// Two-tailed critical t for alpha/24 at large df. Normal approximation is fine
// at n~100 per bucket; the exact t-value differs in the third decimal.
const T_CRIT_BONFERRONI = 3.09;

/**
 * Coinbase returns [time, low, high, open, close, volume], newest first, and
 * caps each response at 300 candles. Walk backwards in 300-candle windows.
 */
async function fetchHourly(product) {
  const now = Math.floor(Date.now() / 1000);
  const all = new Map();
  for (let page = 0; page < PAGES; page++) {
    const end = now - page * 300 * HOUR;
    const start = end - 300 * HOUR;
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles`
      + `?granularity=${HOUR}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) break;
      const d = await r.json();
      if (!Array.isArray(d) || !d.length) break;
      for (const x of d) {
        if (Array.isArray(x) && x.length >= 6 && x.every((n) => n != null)) all.set(x[0], x);
      }
    } catch { break; }
  }
  return [...all.values()]
    .sort((a, b) => a[0] - b[0])
    .map((x) => ({ t: x[0] * 1000, l: x[1], h: x[2], o: x[3], c: x[4], v: x[5] }));
}

const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);

export default async function handler(req, res) {
  const coin = String((req.query && req.query.coin) || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(coin)) {
    res.status(400).json({ error: 'Pass ?coin=BTC' });
    return;
  }

  const bars = await fetchHourly(`${coin}-USD`);
  if (bars.length < 24 * 20) {
    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(200).json({ coin, insufficient: true, bars: bars.length, note: 'Need at least 20 days of hourly candles for an hour-of-day read.' });
    return;
  }

  // Bucket each bar's close-to-close return by its UTC hour
  const buckets = Array.from({ length: 24 }, () => []);
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (!(prev.c > 0)) continue;
    buckets[new Date(cur.t).getUTCHours()].push(((cur.c - prev.c) / prev.c) * 100);
  }

  const hours = buckets.map((b, h) => {
    if (b.length < 10) return { h, n: b.length, avg: null, winRate: null, t: null };
    const n = b.length;
    const avg = b.reduce((s, x) => s + x, 0) / n;
    const variance = b.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    const se = sd / Math.sqrt(n);
    return {
      h,
      n,
      avg: r3(avg),
      sd: r3(sd),
      winRate: Math.round((b.filter((x) => x > 0).length / n) * 1000) / 10,
      t: se > 0 ? r3(avg / se) : null,
    };
  });

  const rated = hours.filter((x) => x.t != null);
  let best = null, worst = null, significant = [];
  if (rated.length) {
    best = rated.reduce((a, b) => (b.avg > a.avg ? b : a));
    worst = rated.reduce((a, b) => (b.avg < a.avg ? b : a));
    significant = rated
      .filter((x) => Math.abs(x.t) >= T_CRIT_BONFERRONI)
      .sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  }

  // The honest headline. If no hour clears the corrected threshold, the right
  // answer is "time of day is not your edge here" — not a spurious best hour.
  const verdict = significant.length
    ? `${significant.length} hour${significant.length > 1 ? 's' : ''} of ${rated.length} show a move distinguishable from noise after correcting for testing all 24.`
    : `No hour is distinguishable from noise once you correct for testing all 24. Time of day is not a reliable edge for ${coin} on this sample — trade the setup, not the clock.`;

  const days = Math.round(bars.length / 24);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.status(200).json({
    coin,
    asOf: Date.now(),
    sampleDays: days,
    sampleBars: bars.length,
    obsPerHour: Math.round(bars.length / 24),
    method: {
      test: 'two-tailed t-test of mean hourly return vs zero',
      correction: `Bonferroni, alpha ${ALPHA} / ${TESTS} tests`,
      tCritical: T_CRIT_BONFERRONI,
    },
    hours,
    best,
    worst,
    significant,
    anySignificant: significant.length > 0,
    verdict,
  });
}

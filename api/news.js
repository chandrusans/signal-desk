// Vercel serverless: /api/news?tickers=NVDA,PLTR,...
// Pulls recent company news from Yahoo Finance search endpoint (no auth key).
// Returns { NVDA: { items: [{title, publisher, link, ts, sentiment}], count24h, avgSentiment }, ... }

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const NEWS = (sym) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&newsCount=15&quotesCount=0`;

// Simple keyword-based sentiment scorer — no ML, no external calls.
// Range: -1 (very bearish) to +1 (very bullish). 0 = neutral.
const BULL_WORDS = [
  'beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps',
  'upgrade', 'upgraded', 'raise', 'raised', 'strong', 'record', 'high', 'growth',
  'outperform', 'buy', 'positive', 'bullish', 'gain', 'gains', 'up', 'rise', 'rises',
  'expand', 'expands', 'wins', 'won', 'launch', 'launches', 'boost', 'boosts',
  'breakthrough', 'approves', 'approved', 'exceeded', 'topping', 'accelerating',
];
const BEAR_WORDS = [
  'miss', 'misses', 'plunge', 'plunges', 'crash', 'crashes', 'fall', 'falls', 'drop', 'drops',
  'downgrade', 'downgraded', 'cut', 'cuts', 'weak', 'low', 'decline', 'declines',
  'underperform', 'sell', 'negative', 'bearish', 'loss', 'losses', 'down', 'slump',
  'concern', 'concerns', 'warning', 'warns', 'risk', 'risks', 'lawsuit', 'sued', 'probe',
  'delay', 'delays', 'recall', 'layoffs', 'bankruptcy', 'fraud', 'fine', 'fined',
  'disappointing', 'below expectations', 'guidance cut', 'restructuring',
];

function scoreText(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let bull = 0, bear = 0;
  for (const w of BULL_WORDS) if (lower.includes(w)) bull++;
  for (const w of BEAR_WORDS) if (lower.includes(w)) bear++;
  const total = bull + bear;
  if (total === 0) return 0;
  return (bull - bear) / total;
}

async function fetchNews(sym) {
  const res = await fetch(NEWS(sym), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${sym}: HTTP ${res.status}`);
  const data = await res.json();
  const raw = data.news || [];
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const items = raw.map((n) => {
    const ts = (n.providerPublishTime || 0) * 1000;
    const sentiment = scoreText(n.title);
    return {
      title: n.title || '',
      publisher: n.publisher || '',
      link: n.link || '',
      ts,
      sentiment: +sentiment.toFixed(2),
    };
  });
  const last24 = items.filter((i) => i.ts >= dayAgo);
  const avgSent = last24.length
    ? +(last24.reduce((s, i) => s + i.sentiment, 0) / last24.length).toFixed(2)
    : 0;
  return {
    items: items.slice(0, 8),
    count24h: last24.length,
    avgSentiment: avgSent,
  };
}

export default async function handler(req, res) {
  const raw = (req.query && req.query.tickers) || '';
  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((t) => !t.startsWith('^'))
    .slice(0, 20);

  if (tickers.length === 0) {
    res.status(400).json({ error: 'Pass ?tickers=NVDA,PLTR,...' });
    return;
  }

  const results = await Promise.allSettled(tickers.map(fetchNews));
  const out = {};
  const errors = {};
  results.forEach((r, i) => {
    const t = tickers[i];
    if (r.status === 'fulfilled') out[t] = r.value;
    else errors[t] = String(r.reason && r.reason.message || r.reason);
  });

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    news: out,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
}

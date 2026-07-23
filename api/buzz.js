// Vercel serverless: /api/buzz?tickers=NVDA,PLTR,...
// Aggregates LIVE public sources — no API keys required:
//   • StockTwits per-ticker streams (public JSON, no auth)
//   • CNBC market news RSS (top-news feed)
// Returns a unified feed { source, speaker, tickers[], sent, text, ts, link }.

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';

// ---- StockTwits: per-ticker stream ----
const ST_URL = (sym) => `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json?limit=15`;

async function fetchStockTwits(sym) {
  try {
    const res = await fetch(ST_URL(sym), { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const msgs = data.messages || [];
    return msgs.map((m) => {
      const body = String(m.body || '').trim();
      const user = m.user?.username || 'stocktwits';
      const followers = m.user?.followers || 0;
      const sentTag = m.entities?.sentiment?.basic;
      const sent = sentTag === 'Bullish' ? 'bull' : sentTag === 'Bearish' ? 'bear' : 'neu';
      // Extract $TICKER symbols mentioned
      const mentioned = new Set([sym]);
      for (const s of body.matchAll(/\$([A-Z]{1,5})\b/g)) mentioned.add(s[1]);
      return {
        src: 'STOCKTWITS',
        speaker: `@${user}${followers > 500 ? ` · ${followers}f` : ''}`,
        tickers: [...mentioned],
        sent,
        text: body,
        ts: m.created_at ? Date.parse(m.created_at) : Date.now(),
        link: `https://stocktwits.com/${user}/message/${m.id}`,
      };
    });
  } catch { return []; }
}

// ---- CNBC RSS: general market news ----
const CNBC_RSS = 'https://www.cnbc.com/id/100003114/device/rss/rss.html';

async function fetchCNBC(tickers) {
  try {
    const res = await fetch(CNBC_RSS, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const xml = await res.text();
    // Very small RSS parser — good enough for CNBC's item shape.
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
      const chunk = m[1];
      const pick = (tag) => {
        const r = chunk.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        if (!r) return '';
        return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
      };
      const title = pick('title');
      const link = pick('link');
      const pub = pick('pubDate');
      const desc = pick('description').replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      // Find any tickers mentioned in title or description
      const hay = (title + ' ' + desc).toUpperCase();
      const mentioned = tickers.filter((t) => new RegExp(`\\b${t.replace(/[\^]/g, '')}\\b`).test(hay));
      // Simple sentiment on the title
      const t = title.toLowerCase();
      const bull = ['beat', 'surge', 'rally', 'jump', 'upgrade', 'gain', 'record', 'strong', 'boost', 'win'].some(w => t.includes(w));
      const bear = ['miss', 'plunge', 'fall', 'drop', 'downgrade', 'cut', 'weak', 'concern', 'warn', 'lawsuit', 'probe', 'slide'].some(w => t.includes(w));
      items.push({
        src: 'CNBC',
        speaker: 'CNBC · Top News',
        tickers: mentioned,
        sent: bull && !bear ? 'bull' : bear && !bull ? 'bear' : 'neu',
        text: title + (desc ? ' — ' + desc.slice(0, 140) : ''),
        ts: pub ? Date.parse(pub) : Date.now(),
        link,
      });
    }
    return items;
  } catch { return []; }
}

export default async function handler(req, res) {
  const raw = (req.query && req.query.tickers) || 'NVDA,PLTR,CRWD,HOOD,ASML,AMD,META,MSFT,GOOGL,TSLA,AMZN,COIN,LLY';
  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((t) => !t.startsWith('^') && !t.includes('=')) // skip index/futures for social
    .slice(0, 20);

  const [stAll, cnbc] = await Promise.all([
    Promise.all(tickers.map(fetchStockTwits)),
    fetchCNBC(tickers),
  ]);

  const stFlat = stAll.flat();
  // De-dup StockTwits by message text prefix (some users cross-post)
  const seenText = new Set();
  const stUnique = stFlat.filter((m) => {
    const k = m.text.slice(0, 60);
    if (seenText.has(k)) return false;
    seenText.add(k);
    return true;
  });

  // Merge & sort by time desc, cap at 60 items
  const all = [...stUnique, ...cnbc]
    .filter((x) => x.text && x.text.length > 3)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 60);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    counts: {
      stocktwits: stUnique.length,
      cnbc: cnbc.length,
      total: all.length,
    },
    items: all,
  });
}

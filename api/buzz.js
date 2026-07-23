// Vercel serverless: /api/buzz?tickers=NVDA,PLTR,...
//
// Aggregates market chatter from multiple sources. Each source is a self-
// contained fetch function that returns [] when its credentials are not
// configured, so the endpoint always works — it just gets richer as you add
// keys via Vercel environment variables.
//
// Currently WIRED and returning data:
//   • StockTwits — public JSON stream, no auth              [ALWAYS ON]
//   • CNBC RSS   — public top-news feed, no auth            [ALWAYS ON]
//
// WIRED but dormant until you add env vars in Vercel:
//   • X (Twitter) v2  — set X_BEARER_TOKEN                  [PAID: ~$100/mo Basic]
//   • Reddit          — set REDDIT_CLIENT_ID / _SECRET / _USER_AGENT
//   • QuiverQuant     — set QUIVER_API_KEY (Congress trades)
//   • Finnhub         — set FINNHUB_API_KEY (news + analyst grades)
//
// Response shape (unchanged as sources come online):
//   { asOf, counts: {stocktwits, cnbc, x, reddit, congress, finnhub, total}, items: [...] }
// Each item: { src, speaker, tickers[], sent, text, ts, link }

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';

// =====================================================================
// SOURCE 1 · StockTwits (always on — public feed)
// =====================================================================
async function fetchStockTwits(tickers) {
  const perTicker = tickers.map(async (sym) => {
    try {
      const res = await fetch(
        `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json?limit=15`,
        { headers: { 'User-Agent': UA } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (data.messages || []).map((m) => {
        const body = String(m.body || '').trim();
        const user = m.user?.username || 'stocktwits';
        const followers = m.user?.followers || 0;
        const sentTag = m.entities?.sentiment?.basic;
        const sent = sentTag === 'Bullish' ? 'bull' : sentTag === 'Bearish' ? 'bear' : 'neu';
        const mentioned = new Set([sym]);
        for (const s of body.matchAll(/\$([A-Z]{1,5})\b/g)) mentioned.add(s[1]);
        return {
          src: 'STOCKTWITS',
          speaker: `@${user}${followers > 500 ? ` · ${followers.toLocaleString()}f` : ''}`,
          tickers: [...mentioned],
          sent,
          text: body,
          ts: m.created_at ? Date.parse(m.created_at) : Date.now(),
          link: `https://stocktwits.com/${user}/message/${m.id}`,
        };
      });
    } catch { return []; }
  });
  const results = await Promise.all(perTicker);
  return results.flat();
}

// =====================================================================
// SOURCE 2 · CNBC top-news RSS (always on — public)
// =====================================================================
async function fetchCNBC(tickers) {
  try {
    const res = await fetch('https://www.cnbc.com/id/100003114/device/rss/rss.html', { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) !== null) {
      const chunk = m[1];
      const pick = (tag) => {
        const r = chunk.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return r ? r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
      };
      const title = pick('title');
      const link = pick('link');
      const pub = pick('pubDate');
      const desc = pick('description').replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      const hay = (title + ' ' + desc).toUpperCase();
      const mentioned = tickers.filter((t) => new RegExp(`\\b${t.replace(/[\^]/g, '')}\\b`).test(hay));
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

// =====================================================================
// SOURCE 3 · X (Twitter) v2 — set X_BEARER_TOKEN to activate
// Pricing: Basic tier ~$100/mo · https://developer.x.com/en/products/twitter-api
// =====================================================================
async function fetchX(tickers) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return [];
  try {
    // Recent-search endpoint with cashtags: (($NVDA OR $PLTR) -is:retweet lang:en)
    const q = tickers.slice(0, 10).map((t) => `$${t}`).join(' OR ');
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(`(${q}) -is:retweet lang:en`)}&max_results=50&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name,verified,public_metrics`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const users = Object.fromEntries((data.includes?.users || []).map((u) => [u.id, u]));
    return (data.data || []).map((tw) => {
      const u = users[tw.author_id] || {};
      const body = String(tw.text || '').trim();
      const mentioned = new Set();
      for (const s of body.matchAll(/\$([A-Z]{1,5})\b/g)) mentioned.add(s[1]);
      // If none matched, drop it (probably not really about our tickers)
      if (mentioned.size === 0) return null;
      const t = body.toLowerCase();
      const bull = ['bull', 'long', 'buy', 'rally', 'moon', 'breakout', 'squeeze'].some(w => t.includes(w));
      const bear = ['bear', 'short', 'sell', 'crash', 'dump', 'puts'].some(w => t.includes(w));
      return {
        src: 'X',
        speaker: `@${u.username || 'x'}${u.verified ? ' ✓' : ''}${u.public_metrics?.followers_count > 10000 ? ` · ${(u.public_metrics.followers_count/1000).toFixed(0)}kf` : ''}`,
        tickers: [...mentioned],
        sent: bull && !bear ? 'bull' : bear && !bull ? 'bear' : 'neu',
        text: body,
        ts: tw.created_at ? Date.parse(tw.created_at) : Date.now(),
        link: `https://x.com/${u.username || 'i'}/status/${tw.id}`,
      };
    }).filter(Boolean);
  } catch { return []; }
}

// =====================================================================
// SOURCE 4 · Reddit — set REDDIT_CLIENT_ID + _SECRET + _USER_AGENT
// Free · register app at https://www.reddit.com/prefs/apps (type: script)
// =====================================================================
async function fetchReddit(tickers) {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const secret   = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT || 'signal-desk/1.0';
  if (!clientId || !secret) return [];
  try {
    // Client-credentials OAuth (no user login needed — 60 req/min)
    const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body: 'grant_type=client_credentials',
    });
    if (!tokenRes.ok) return [];
    const { access_token } = await tokenRes.json();
    if (!access_token) return [];

    // Search top posts in r/wallstreetbets + r/stocks + r/investing for each cashtag
    const subs = ['wallstreetbets', 'stocks', 'investing'];
    const results = [];
    for (const sub of subs) {
      for (const t of tickers.slice(0, 5)) {
        const r = await fetch(`https://oauth.reddit.com/r/${sub}/search.json?q=%24${t}&restrict_sr=1&sort=new&t=day&limit=5`, {
          headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': userAgent },
        });
        if (!r.ok) continue;
        const d = await r.json();
        for (const p of (d.data?.children || [])) {
          const pd = p.data;
          const body = (pd.title || '') + (pd.selftext ? ' — ' + pd.selftext.slice(0, 180) : '');
          const l = body.toLowerCase();
          const bull = ['bull', 'long', 'buy', 'moon', 'breakout', 'calls', 'rally'].some(w => l.includes(w));
          const bear = ['bear', 'short', 'puts', 'crash', 'dump', 'sell'].some(w => l.includes(w));
          results.push({
            src: 'REDDIT',
            speaker: `r/${sub} · u/${pd.author}`,
            tickers: [t],
            sent: bull && !bear ? 'bull' : bear && !bull ? 'bear' : 'neu',
            text: body,
            ts: pd.created_utc ? pd.created_utc * 1000 : Date.now(),
            link: `https://reddit.com${pd.permalink}`,
          });
        }
      }
    }
    return results;
  } catch { return []; }
}

// =====================================================================
// SOURCE 5 · QuiverQuant — set QUIVER_API_KEY to activate
// Congressional STOCK Act trades + gov contracts + insider signals
// Pricing: from $10/mo · https://api.quiverquant.com/docs/
// =====================================================================
async function fetchCongress(tickers) {
  const key = process.env.QUIVER_API_KEY;
  if (!key) return [];
  try {
    // Recent congressional trades (last 90 days). Then filter to our tickers.
    const res = await fetch('https://api.quiverquant.com/beta/live/congresstrading', {
      headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || [])
      .filter((r) => tickers.includes(r.Ticker))
      .slice(0, 30)
      .map((r) => ({
        src: 'CONGRESS',
        speaker: `${r.Representative} (${r.House}) · ${r.Party || '?'}`,
        tickers: [r.Ticker],
        sent: r.Transaction?.toLowerCase().includes('purchase') ? 'bull' : 'bear',
        text: `${r.Transaction} · $${r.Range || 'amount TBD'} · filed ${r.ReportDate}`,
        ts: r.TransactionDate ? Date.parse(r.TransactionDate) : Date.now(),
        link: 'https://www.capitoltrades.com/',
      }));
  } catch { return []; }
}

// =====================================================================
// SOURCE 6 · Finnhub — set FINNHUB_API_KEY to activate
// Free tier available (60 req/min) · https://finnhub.io/
// Analyst grades + company news with source attribution
// =====================================================================
async function fetchFinnhub(tickers) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return [];
  try {
    const perTicker = tickers.slice(0, 5).map(async (t) => {
      // Last-week news
      const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const to   = new Date().toISOString().slice(0, 10);
      const res = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${t}&from=${from}&to=${to}&token=${key}`);
      if (!res.ok) return [];
      const arr = await res.json();
      return (arr || []).slice(0, 8).map((n) => ({
        src: 'CNBC', // finnhub aggregates multiple outlets; mark generic news color
        speaker: n.source || 'Finnhub',
        tickers: [t],
        sent: 'neu',
        text: n.headline + (n.summary ? ' — ' + n.summary.slice(0, 140) : ''),
        ts: n.datetime ? n.datetime * 1000 : Date.now(),
        link: n.url || '',
      }));
    });
    return (await Promise.all(perTicker)).flat();
  } catch { return []; }
}

// =====================================================================
// Handler
// =====================================================================
export default async function handler(req, res) {
  const raw = (req.query && req.query.tickers) || 'NVDA,PLTR,CRWD,HOOD,ASML,AMD,META,MSFT,GOOGL,TSLA,AMZN,COIN,LLY';
  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((t) => !t.startsWith('^') && !t.includes('='))
    .slice(0, 20);

  // Fetch all sources in parallel — each returns [] silently if creds missing
  const [st, cnbc, x, reddit, congress, finnhub] = await Promise.all([
    fetchStockTwits(tickers),
    fetchCNBC(tickers),
    fetchX(tickers),
    fetchReddit(tickers),
    fetchCongress(tickers),
    fetchFinnhub(tickers),
  ]);

  // Dedup StockTwits text near-duplicates
  const seenText = new Set();
  const stUnique = st.filter((m) => {
    const k = m.text.slice(0, 60);
    if (seenText.has(k)) return false;
    seenText.add(k);
    return true;
  });

  const all = [...stUnique, ...cnbc, ...x, ...reddit, ...congress, ...finnhub]
    .filter((x) => x.text && x.text.length > 3)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 80);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=180');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    counts: {
      stocktwits: stUnique.length,
      cnbc: cnbc.length,
      x: x.length,
      reddit: reddit.length,
      congress: congress.length,
      finnhub: finnhub.length,
      total: all.length,
    },
    active: {
      x: !!process.env.X_BEARER_TOKEN,
      reddit: !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET),
      congress: !!process.env.QUIVER_API_KEY,
      finnhub: !!process.env.FINNHUB_API_KEY,
    },
    items: all,
  });
}

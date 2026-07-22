// Vercel serverless: /api/news?tickers=NVDA,PLTR,...&sectors=NVDA:semis,PLTR:defense,...
// Pulls Yahoo Finance news per ticker, scores general + political sentiment,
// tags political headlines. Sector param lets the political sentiment be
// interpreted correctly (a "chips act" headline is bullish for semis, neutral elsewhere).

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const NEWS = (sym) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&newsCount=15&quotesCount=0`;

// ---- General bull/bear lexicon ----
const BULL = [
  'beat','beats','surge','surges','soar','soars','rally','rallies','jump','jumps',
  'upgrade','upgraded','raise','raised','strong','record','high','growth',
  'outperform','buy','positive','bullish','gain','gains','rise','rises',
  'expand','expands','wins','won','launch','launches','boost','boosts',
  'breakthrough','approves','approved','exceeded','topping','accelerating',
];
const BEAR = [
  'miss','misses','plunge','plunges','crash','crashes','fall','falls','drop','drops',
  'downgrade','downgraded','cut','cuts','weak','decline','declines',
  'underperform','sell','negative','bearish','loss','losses','slump',
  'concern','concerns','warning','warns','risk','risks','lawsuit','sued','probe',
  'delay','delays','recall','layoffs','bankruptcy','fraud','fine','fined',
  'disappointing','below expectations','guidance cut','restructuring','spooking','tumbles',
];

// ---- Political trigger words (flag isPolitical if any hit) ----
const POLITICAL_TRIGGERS = [
  'tariff','tariffs','sanctions','sanction','regulation','regulatory','antitrust','probe',
  'sec ','ftc','fda','doj','congress','senate','house of representatives','white house',
  'president','election','biden','trump','harris','vance','xi jinping','putin',
  'geopolitical','war','conflict','sanctions','embargo','ban','banned','banning',
  'export controls','export control','chips act','ira','inflation reduction',
  'executive order','policy','subsidy','subsidies','tax credit','tax hike','tax cut',
  'medicare','medicaid','drug pricing','price controls','stimulus','bailout',
  'fomc','fed','federal reserve','powell','rate cut','rate hike','hawkish','dovish',
  'nato','china','russia','iran','israel','ukraine','taiwan','saudi','opec',
  'trade war','trade deal','deregulation','oversight','crackdown','investigation',
];

// Political sentiment lexicon, generic (sector-neutral defaults)
const POL_BULL_GENERIC = [
  'subsidy','subsidies','tax credit','stimulus','deregulation','tax cut',
  'passed','approved','signed','rate cut','dovish','trade deal','exempt','exemption',
  'aid package','infrastructure',
];
const POL_BEAR_GENERIC = [
  'tariff','tariffs','sanctions','ban','banned','banning','antitrust','probe','lawsuit',
  'investigation','crackdown','regulation','tax hike','rate hike','hawkish',
  'export controls','embargo','fine','fined','oversight',
];

// Sector-specific lexicon adjustments — same word can mean opposite things per sector
const SECTOR_LEXICON = {
  semis: {
    bull: ['chips act','onshoring','domestic','foundry','tsmc','samsung','fab','capex'],
    bear: ['export controls','china restrictions','china ban','huawei ban'],
  },
  defense: {
    bull: ['budget increase','contract','aid package','conflict','war','tensions','buildup'],
    bear: ['peace talks','ceasefire','budget cut','defense cuts'],
  },
  energy: {
    bull: ['drilling','permit','lng exports','opec cut','production cut','pipeline approval'],
    bear: ['drilling ban','moratorium','climate rules','carbon tax','opec increase'],
  },
  healthcare: {
    bull: ['approval','fda approval','breakthrough designation','medicare coverage'],
    bear: ['price controls','ipra','drug pricing','recall','black box','rejected'],
  },
  fin: {
    bull: ['deregulation','rate cut','loan growth','deposit growth'],
    bear: ['capital requirements','stress test','fdic','regulation','basel'],
  },
  'tech-mega': {
    bull: ['exempt','dismissed','settled','court ruling in favor'],
    bear: ['antitrust','break up','breakup','privacy law','section 230','dma','digital markets act'],
  },
  crypto: {
    bull: ['spot etf approved','bitcoin etf','stablecoin bill','clarity act','trump crypto'],
    bear: ['sec crackdown','stablecoin ban','exchange ban','cbdc','wells notice'],
  },
  ev: {
    bull: ['tax credit','subsidy','ev incentive','infrastructure bill'],
    bear: ['tax credit removed','tariff','emissions rollback'],
  },
};

function escapeRe(w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function countMatches(text, list) {
  if (!text) return 0;
  const l = text.toLowerCase();
  let n = 0;
  for (const w of list) {
    // Word-boundary match for short single-word triggers to avoid false positives
    // (e.g. "war" matching "Warren", "ban" matching "banner"). Multi-word phrases
    // and longer words are matched as substrings — they're distinctive enough.
    if (w.length < 6 && !w.includes(' ')) {
      const re = new RegExp('\\b' + escapeRe(w) + '\\b', 'i');
      if (re.test(l)) n++;
    } else if (l.includes(w)) {
      n++;
    }
  }
  return n;
}

function isPolitical(text) {
  return countMatches(text, POLITICAL_TRIGGERS) > 0;
}

function scoreGeneral(text) {
  if (!text) return 0;
  const b = countMatches(text, BULL);
  const r = countMatches(text, BEAR);
  const total = b + r;
  return total === 0 ? 0 : (b - r) / total;
}

function scorePolitical(text, sector) {
  if (!text) return 0;
  const sectorLex = sector && SECTOR_LEXICON[sector] ? SECTOR_LEXICON[sector] : { bull: [], bear: [] };
  const b = countMatches(text, POL_BULL_GENERIC) + countMatches(text, sectorLex.bull) * 1.5;
  const r = countMatches(text, POL_BEAR_GENERIC) + countMatches(text, sectorLex.bear) * 1.5;
  const total = b + r;
  return total === 0 ? 0 : (b - r) / total;
}

async function fetchNews(sym, sector) {
  const res = await fetch(NEWS(sym), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${sym}: HTTP ${res.status}`);
  const data = await res.json();
  const raw = data.news || [];
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const items = raw.map((n) => {
    const title = n.title || '';
    const pol = isPolitical(title);
    return {
      title,
      publisher: n.publisher || '',
      link: n.link || '',
      ts: (n.providerPublishTime || 0) * 1000,
      sentiment: +scoreGeneral(title).toFixed(2),
      political: pol,
      politicalSentiment: pol ? +scorePolitical(title, sector).toFixed(2) : 0,
    };
  });
  const last24 = items.filter((i) => i.ts >= dayAgo);
  const pol24 = last24.filter((i) => i.political);
  const avgSent = last24.length
    ? +(last24.reduce((s, i) => s + i.sentiment, 0) / last24.length).toFixed(2)
    : 0;
  const avgPolSent = pol24.length
    ? +(pol24.reduce((s, i) => s + i.politicalSentiment, 0) / pol24.length).toFixed(2)
    : 0;
  return {
    items: items.slice(0, 10),
    count24h: last24.length,
    political24h: pol24.length,
    avgSentiment: avgSent,
    avgPoliticalSentiment: avgPolSent,
    sector: sector || null,
  };
}

export default async function handler(req, res) {
  const raw = (req.query && req.query.tickers) || '';
  const sectorsRaw = (req.query && req.query.sectors) || '';
  const sectorMap = {};
  for (const pair of String(sectorsRaw).split(',')) {
    const [t, s] = pair.split(':');
    if (t && s) sectorMap[t.trim().toUpperCase()] = s.trim().toLowerCase();
  }
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

  const results = await Promise.allSettled(tickers.map((t) => fetchNews(t, sectorMap[t])));
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

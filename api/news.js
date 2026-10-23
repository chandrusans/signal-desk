// Vercel serverless: /api/news?tickers=NVDA,PLTR,...&sectors=NVDA:semis,PLTR:defense,...
// Pulls Yahoo Finance news per ticker, scores general + political sentiment,
// tags political headlines. Sector param lets the political sentiment be
// interpreted correctly (a "chips act" headline is bullish for semis, neutral elsewhere).

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const NEWS = (sym) =>
  `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&newsCount=15&quotesCount=0`;

// ---- General bull/bear lexicon ----
const BULL = [
  // past tense / gerund forms (added so 'soared' and 'rallying' score, not just 'soar')
  'acceleratinged', 'acceleratinging', 'approveded', 'approveding', 'approveed', 'approving', 'beated', 'beating', 'boosted', 'boosting', 'breakthroughed', 'breakthroughing', 'bullished', 'bullishing', 'buyed', 'buying', 'exceededed', 'exceededing', 'expanded', 'expanding', 'gained', 'gaining', 'growthed', 'growthing', 'highed', 'highing', 'jumped', 'jumping', 'launched', 'launcheed', 'launching', 'outperformed', 'outperforming', 'positived', 'positiveed', 'positiving', 'raiseded', 'raiseding', 'raiseed', 'raising', 'rallied', 'rallieed', 'ralliing', 'rallyed', 'rallying', 'recorded', 'recording', 'rised', 'riseed', 'rising', 'soared', 'soaring', 'stronged', 'stronging', 'surged', 'surgeed', 'surging', 'toppinged', 'toppinging', 'upgradeded', 'upgradeding', 'upgradeed', 'upgrading', 'winsed', 'winsing', 'woned', 'woning',

  'beat','beats','surge','surges','soar','soars','rally','rallies','jump','jumps',
  'upgrade','upgraded','raise','raised','strong','record','high','growth',
  'outperform','buy','positive','bullish','gain','gains','rise','rises',
  'expand','expands','wins','won','launch','launches','boost','boosts',
  'breakthrough','approves','approved','exceeded','topping','accelerating',
];
const BEAR = [
  'bankruptcyed', 'bankruptcying', 'bearished', 'bearishing', 'concerned', 'concerning', 'crashed', 'crasheed', 'crashing', 'cuted', 'cuting', 'cutsed', 'cutsing', 'declined', 'declineed', 'declining', 'delayed', 'delaying', 'disappointinged', 'disappointinging', 'downgradeded', 'downgradeding', 'downgradeed', 'downgrading', 'droped', 'droping', 'falled', 'falling', 'fineded', 'fineding', 'fineed', 'fining', 'frauded', 'frauding', 'lawsuited', 'lawsuiting', 'layoffed', 'layoffing', 'lossed', 'losseed', 'lossing', 'missed', 'misseed', 'missing', 'negatived', 'negativeed', 'negativing', 'plunged', 'plungeed', 'plunging', 'probed', 'probeed', 'probing', 'recalled', 'recalling', 'restructuringed', 'restructuringing', 'risked', 'risking', 'selled', 'selling', 'slumped', 'slumping', 'spookinged', 'spookinging', 'sueded', 'sueding', 'tumbled', 'tumbleed', 'tumbling', 'underperformed', 'underperforming', 'warned', 'warninged', 'warninging', 'weaked', 'weaking',

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

// Event category for a headline. Keyword rules on purpose: every tag can be
// explained by pointing at the word that triggered it. Order matters — the
// first matching category wins, and the specific ones come before the broad.
const CATEGORY_RULES = [
  ['earnings', /\b(earnings|eps|quarterly results|q[1-4]\s*(results|revenue)|beats? (estimates|expectations)|misses? (estimates|expectations)|guidance|outlook (raised|cut|lowered))\b/i],
  ['lawsuit',  /\b(lawsuit|sued|sues|class action|antitrust|probe|investigation|subpoena|doj|ftc|sec charges|settlement|fined|indicted|regulator)\b/i],
  ['deal',     /\b(acquires?|acquisition|mergers?|merges?|buyout|takeover|agrees? to (buy|acquire)|in talks to (buy|acquire)|to acquire|deal (to|with|worth|valued)|joint venture|takes? a stake|stake in)\b/i],
  ['rating',   /\b(upgrade[sd]?|downgrade[sd]?|price target|initiates? coverage|overweight|underweight|outperform|underperform|rating)\b/i],
  ['insider',  /\b(insider|ceo (buys|sells|sold|bought)|director (buys|sells)|form 4|share sale by)\b/i],
  ['product',  /\b(launch(es|ed)?|unveil(s|ed)?|announces? (new|the)|rollout|release[sd]?)\b/i],
  ['macro',    /\b(fed|fomc|inflation|cpi|tariff|rate (hike|cut)|jobs report|recession|treasury yields?)\b/i],
];
function categorize(text) {
  for (const [name, re] of CATEGORY_RULES) if (re.test(text || '')) return name;
  return 'other';
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
    // Yahoo's search returns articles that merely MENTION the ticker among
    // several. `primary` is true when the article is about this name: it is
    // the first related ticker, or one of at most two, or named in the title.
    const rel = Array.isArray(n.relatedTickers) ? n.relatedTickers.map((x) => String(x).toUpperCase()) : [];
    const primary = rel.length === 0 || rel[0] === sym || (rel.length <= 2 && rel.includes(sym)) || new RegExp(`\\b${sym.replace(/[.-]/g, '[.-]')}\\b`).test(title);
    return {
      title,
      relatedTickers: rel,
      primary,
      publisher: n.publisher || '',
      link: n.link || '',
      ts: (n.providerPublishTime || 0) * 1000,
      sentiment: +scoreGeneral(title).toFixed(2),
      category: categorize(title),
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

  // Sentiment SHIFT — the alert is a change, not a level. Compare the last
  // 24h against the prior 24-96h window. Both windows need at least 3
  // headlines or the comparison is noise and `shift` stays null. A flip is
  // the sign changing with a gap of at least 0.4 on the -1..1 scale.
  const prior = items.filter((i) => i.ts < dayAgo && i.ts >= now - 96 * 3600 * 1000);
  let shift = null;
  if (last24.length >= 3 && prior.length >= 3) {
    const priorAvg = +(prior.reduce((s, i) => s + i.sentiment, 0) / prior.length).toFixed(2);
    const delta = +(avgSent - priorAvg).toFixed(2);
    const flipped = Math.sign(avgSent) !== Math.sign(priorAvg) && Math.abs(delta) >= 0.4;
    shift = { now: avgSent, prior: priorAvg, delta, n24: last24.length, nPrior: prior.length,
      flipped, direction: flipped ? (avgSent > priorAvg ? 'bullish' : 'bearish') : null };
  }

  return {
    items: items.slice(0, 10),
    shift,
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

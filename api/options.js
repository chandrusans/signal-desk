// Vercel serverless: /api/options?tickers=NVDA,PLTR,...
//
// Pulls US equity options chains from NASDAQ's public JSON endpoint (no auth
// needed), filters to actionable strikes and expiries, and returns structured
// single-leg call/put recommendations sized for Robinhood + Charles Schwab.
//
// Response:
//   {
//     asOf,
//     recommendations: [
//       {
//         underlying, underlyingPrice,
//         horizon: 'short' | 'long',    // 7–45 DTE or 90–365 DTE
//         direction: 'CALL' | 'PUT',
//         strike, expiration (ISO), dte,
//         occSymbol,                    // e.g. NVDA260815C00220000 — works in Robinhood & Schwab search
//         bid, ask, mid, spreadPct,
//         volume, openInterest,
//         breakeven,
//         premiumPerContract,           // mid × 100
//         maxLoss,                      // premium + $0.65 regulatory fee (both apps)
//         exitTargets: [{ pct: 50, premium, underlyingPx }, { pct: 100, ... }],
//         stopPremium,                  // -50% of entry
//         moneyness, deltaEst,          // approximate delta from moneyness
//         liquidity: 'good'|'okay'|'thin',
//         score, rationale,
//       }, ...
//     ]
//   }

const NAS_URL = (t) => `https://api.nasdaq.com/api/quote/${encodeURIComponent(t)}/option-chain?assetclass=stocks&limit=10000&fromdate=all&todate=undefined&excode=oprac&callput=callput&money=all&type=all`;

// Both apps charge $0.65/contract regulatory fee. Commission itself is $0 on Robinhood
// and $0 base + $0.65/contract on Schwab. So $0.65/contract is the honest per-contract cost.
const FEE_PER_CONTRACT = 0.65;

async function fetchChain(sym) {
  try {
    const res = await fetch(NAS_URL(sym), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data || null;
  } catch { return null; }
}

// Parse NASDAQ's flat row list into { underlyingPrice, contracts: [...] }
function parseChain(raw, sym) {
  if (!raw?.table?.rows) return null;
  // "LAST TRADE: $212.06 (AS OF JUL 22, 2026)"
  const priceMatch = String(raw.lastTrade || '').match(/\$?([\d,]+\.?\d*)/);
  const underlyingPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
  if (!underlyingPrice) return null;

  let currentExpiryISO = null;
  const contracts = [];

  for (const row of raw.table.rows) {
    // Header rows carry 'expirygroup' with the full date, e.g. "July 22, 2026"
    if (row.expirygroup) {
      const d = new Date(row.expirygroup);
      if (!isNaN(d)) currentExpiryISO = d.toISOString().slice(0, 10);
      continue;
    }
    if (!currentExpiryISO || row.strike == null) continue;
    const strike = parseFloat(row.strike);
    if (!(strike > 0)) continue;

    // OCC symbol parts from the drillDownURL, e.g. .../nvda--260815c00220000
    // We parse the YYMMDD and strike8 parts, then construct per-side to avoid
    // any string replacement corrupting ticker letters (e.g. PLTR contains "P").
    const url = row.drillDownURL || '';
    const occMatch = url.match(/--(\d{6})([cp])(\d{8})/i);
    const occYYMMDD = occMatch ? occMatch[1] : null;
    const occStrike8 = occMatch ? occMatch[3] : null;

    // Both call and put on the same row
    for (const side of ['c', 'p']) {
      const bid = parseFloat(row[`${side}_Bid`]);
      const ask = parseFloat(row[`${side}_Ask`]);
      const last = parseFloat(row[`${side}_Last`]);
      const vol = parseFloat(row[`${side}_Volume`]) || 0;
      const oi = parseFloat(row[`${side}_Openinterest`]) || 0;
      if (!(bid > 0) && !(ask > 0) && !(last > 0)) continue;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (last > 0 ? last : (bid || ask));
      if (!(mid > 0)) continue;
      const sideOCC = (occYYMMDD && occStrike8)
        ? `${sym.toUpperCase()}${occYYMMDD}${side.toUpperCase()}${occStrike8}`
        : null;

      contracts.push({
        underlying: sym.toUpperCase(),
        underlyingPrice,
        direction: side === 'c' ? 'CALL' : 'PUT',
        strike,
        expiration: currentExpiryISO,
        bid: bid || 0,
        ask: ask || 0,
        mid: +mid.toFixed(2),
        last: last || 0,
        volume: vol,
        openInterest: oi,
        occSymbol: sideOCC,
      });
    }
  }
  return { underlyingPrice, contracts };
}

// Score a contract for recommendation quality. Higher = better.
function scoreContract(c, horizon, direction) {
  let score = 0;
  const dte = daysBetween(new Date(), new Date(c.expiration));
  // Prefer target DTE windows
  if (horizon === 'short') {
    // Sweet spot 21–35 DTE (balances theta decay vs price move time)
    if (dte >= 21 && dte <= 35) score += 30;
    else if (dte >= 14 && dte <= 45) score += 22;
    else if (dte >= 7 && dte <= 55) score += 12;
    else return -1; // out of range
  } else {
    // Long-term: 120–270 DTE preferred, up to 365
    if (dte >= 120 && dte <= 270) score += 30;
    else if (dte >= 90 && dte <= 365) score += 22;
    else return -1;
  }
  // Moneyness: for calls, want slightly OTM (delta ~0.30–0.40); for puts, similar (moneyness measured opposite)
  const moneyness = c.direction === 'CALL' ? (c.strike / c.underlyingPrice) : (c.underlyingPrice / c.strike);
  if (moneyness >= 1.00 && moneyness <= 1.10) score += 25;      // sweet spot slightly OTM
  else if (moneyness >= 0.95 && moneyness <= 1.15) score += 15;
  else if (moneyness >= 0.85 && moneyness <= 1.25) score += 5;
  else return -1;
  // Liquidity — OI is more important than volume
  if (c.openInterest >= 1000) score += 20;
  else if (c.openInterest >= 200) score += 12;
  else if (c.openInterest >= 50) score += 5;
  else return -1;
  // Bid-ask spread (tighter = better for entry)
  const spreadPct = c.ask > 0 ? ((c.ask - c.bid) / c.ask) * 100 : 100;
  if (spreadPct <= 5) score += 15;
  else if (spreadPct <= 10) score += 10;
  else if (spreadPct <= 20) score += 4;
  else return -1;
  // Volume today (freshness)
  if (c.volume >= 500) score += 10;
  else if (c.volume >= 100) score += 5;

  return score;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / (24 * 3600 * 1000));
}

function moneynessLabel(c) {
  const pxDelta = c.direction === 'CALL' ? (c.strike - c.underlyingPrice) : (c.underlyingPrice - c.strike);
  if (Math.abs(pxDelta) / c.underlyingPrice < 0.02) return 'ATM';
  if (pxDelta > 0) return 'OTM';
  return 'ITM';
}

// Rough delta from moneyness. Not Black-Scholes accurate, but ballpark for a
// user picking between contracts. Real delta needs vol + risk-free rate.
function estDelta(c) {
  const moneyness = c.strike / c.underlyingPrice;
  if (c.direction === 'CALL') {
    if (moneyness < 0.9) return 0.85;      // deep ITM
    if (moneyness < 0.98) return 0.65;     // ITM
    if (moneyness < 1.02) return 0.5;      // ATM
    if (moneyness < 1.08) return 0.32;     // slight OTM
    if (moneyness < 1.15) return 0.18;     // OTM
    return 0.08;                            // far OTM
  } else {
    if (moneyness > 1.1) return -0.85;
    if (moneyness > 1.02) return -0.65;
    if (moneyness > 0.98) return -0.5;
    if (moneyness > 0.92) return -0.32;
    if (moneyness > 0.85) return -0.18;
    return -0.08;
  }
}

function liquidityRating(c) {
  if (c.openInterest >= 1000 && c.volume >= 100) return 'good';
  if (c.openInterest >= 200) return 'okay';
  return 'thin';
}

function buildRecommendation(c, horizon, direction, underlyingCtx) {
  const dte = daysBetween(new Date(), new Date(c.expiration));
  const premium = c.mid;
  const premiumPerContract = +(premium * 100).toFixed(2);
  const maxLoss = +(premiumPerContract + FEE_PER_CONTRACT).toFixed(2);
  const breakeven = c.direction === 'CALL' ? c.strike + premium : c.strike - premium;
  const spreadPct = c.ask > 0 ? ((c.ask - c.bid) / c.ask) * 100 : 0;
  // Exit targets: +50% and +100% on premium. Compute the underlying price required
  // for these (very approximate — assumes near expiry, no theta model).
  const target50Prem = +(premium * 1.5).toFixed(2);
  const target100Prem = +(premium * 2.0).toFixed(2);
  const stopPrem = +(premium * 0.5).toFixed(2);
  // Underlying price where option premium *roughly* doubles = strike + premium (for call)
  // A cleaner heuristic: if option is at delta d, the underlying needs to move ~ premium/d for premium to increase by that amount
  const d = Math.abs(estDelta(c));
  const target50Px = c.direction === 'CALL'
    ? c.underlyingPrice + (premium * 0.5) / Math.max(d, 0.1)
    : c.underlyingPrice - (premium * 0.5) / Math.max(d, 0.1);
  const target100Px = c.direction === 'CALL'
    ? c.underlyingPrice + (premium * 1.0) / Math.max(d, 0.1)
    : c.underlyingPrice - (premium * 1.0) / Math.max(d, 0.1);

  return {
    underlying: c.underlying,
    underlyingPrice: c.underlyingPrice,
    horizon,
    direction: c.direction,
    strike: c.strike,
    expiration: c.expiration,
    dte,
    occSymbol: c.occSymbol,
    bid: c.bid,
    ask: c.ask,
    mid: premium,
    spreadPct: +spreadPct.toFixed(1),
    volume: c.volume,
    openInterest: c.openInterest,
    breakeven: +breakeven.toFixed(2),
    premiumPerContract,
    maxLoss,
    exitTargets: [
      { pct: 50, premium: target50Prem, underlyingPx: +target50Px.toFixed(2) },
      { pct: 100, premium: target100Prem, underlyingPx: +target100Px.toFixed(2) },
    ],
    stopPremium: stopPrem,
    moneyness: moneynessLabel(c),
    deltaEst: +estDelta(c).toFixed(2),
    liquidity: liquidityRating(c),
    score: 0, // filled below
    rationale: '',
  };
}

// Return TOP N scored contracts per ticker per horizon (per direction).
// Previously returned just the single best per (horizon, direction) — that gave
// at most 2 recs per ticker. Now we surface a ranked shortlist.
function recommendationsForTicker(chain, sym, direction, perHorizon = 3) {
  const recs = [];
  for (const horizon of ['short', 'long']) {
    const scored = [];
    for (const c of chain.contracts) {
      if (c.direction !== direction) continue;
      const s = scoreContract(c, horizon, direction);
      if (s > 0) scored.push({ c, s });
    }
    scored.sort((a, b) => b.s - a.s);
    for (const { c, s } of scored.slice(0, perHorizon)) {
      const r = buildRecommendation(c, horizon, direction);
      r.score = Math.min(100, s);
      recs.push(r);
    }
  }
  return recs;
}

export default async function handler(req, res) {
  const raw = (req.query && req.query.tickers) || 'NVDA,PLTR,CRWD,HOOD,ASML,AMD,META,MSFT,GOOGL,TSLA,AAPL,AMZN,NFLX,COIN,ORCL,AVGO,MU,MRVL,SNOW,NET,PANW,PYPL,SQ,SHOP,SOFI,RIVN,SMCI,LLY,JPM,BAC';
  const dirRaw = (req.query && req.query.directions) || '';
  const dirMap = {};
  for (const p of String(dirRaw).split(',')) {
    const [t, d] = p.split(':');
    if (t && d) dirMap[t.trim().toUpperCase()] = d.trim().toUpperCase();
  }
  // Query params: limit (max recs returned), perTicker (max recs per horizon per ticker)
  const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit, 10) || 25));
  const perTicker = Math.max(1, Math.min(10, parseInt(req.query?.perTicker, 10) || 3));
  const tickers = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((t) => !t.startsWith('^') && !t.includes('='))
    .slice(0, 30);

  const chains = await Promise.all(tickers.map(async (t) => {
    const raw = await fetchChain(t);
    return { ticker: t, chain: raw ? parseChain(raw, t) : null };
  }));

  const recommendations = [];
  for (const { ticker, chain } of chains) {
    if (!chain) continue;
    const dir = dirMap[ticker] === 'PUT' ? 'PUT' : 'CALL';
    recommendations.push(...recommendationsForTicker(chain, ticker, dir, perTicker));
  }

  recommendations.sort((a, b) => b.score - a.score);
  const capped = recommendations.slice(0, limit);

  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    feePerContract: FEE_PER_CONTRACT,
    supportedApps: ['Robinhood', 'Charles Schwab'],
    universeSize: tickers.length,
    scannedContracts: recommendations.length,
    recommendations: capped,
  });
}

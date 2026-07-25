// Vercel serverless: /api/option-quote?occ=NVDA260814C00215000,PLTR260821C00125000
//
// Returns the CURRENT market price for specific option contracts, looked up by
// OCC symbol. This is what makes live P&L on tracked option positions possible —
// without it a position's premium is frozen at its entry price and the card
// shows $0.00 gain forever, which is worse than useless because it looks live.
//
// OCC symbol layout:  NVDA  260814  C  00215000
//                     root  YYMMDD  C/P  strike × 1000, 8 digits
//
// Source: NASDAQ public option-chain JSON (same as /api/options, no API key).
// Chains are fetched once per underlying and shared across all requested
// contracts on that underlying.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

const CHAIN = (sym) =>
  `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/option-chain` +
  `?assetclass=stocks&limit=10000&fromdate=all&todate=undefined&excode=oprac&callput=callput&money=all&type=all`;

/** Split an OCC symbol into its parts. Returns null if malformed. */
export function parseOCC(occ) {
  const m = String(occ || '').trim().toUpperCase().match(/^([A-Z][A-Z0-9.]{0,5}?)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yymmdd, cp, strike8] = m;
  const yy = +yymmdd.slice(0, 2);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  return {
    root,
    expiration: `20${String(yy).padStart(2, '0')}-${mm}-${dd}`,
    yymmdd,
    type: cp === 'C' ? 'CALL' : 'PUT',
    strike: parseInt(strike8, 10) / 1000,
  };
}

async function fetchChain(sym) {
  try {
    const res = await fetch(CHAIN(sym), { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data || null;
  } catch { return null; }
}

/**
 * Walk the flat NASDAQ row list looking for a specific expiry+strike, and
 * return the requested side's quote.
 */
function findContract(raw, want) {
  if (!raw?.table?.rows) return null;
  const pxMatch = String(raw.lastTrade || '').match(/\$?([\d,]+\.?\d*)/);
  const underlyingPrice = pxMatch ? parseFloat(pxMatch[1].replace(/,/g, '')) : null;

  let currentExpiryISO = null;
  for (const row of raw.table.rows) {
    if (row.expirygroup) {
      const d = new Date(row.expirygroup);
      if (!isNaN(d)) currentExpiryISO = d.toISOString().slice(0, 10);
      continue;
    }
    if (!currentExpiryISO || row.strike == null) continue;
    if (currentExpiryISO !== want.expiration) continue;
    const strike = parseFloat(row.strike);
    // Strikes are decimal; compare with a small tolerance rather than ===
    if (!(Math.abs(strike - want.strike) < 0.0001)) continue;

    const side = want.type === 'CALL' ? 'c' : 'p';
    const bid = parseFloat(row[`${side}_Bid`]);
    const ask = parseFloat(row[`${side}_Ask`]);
    const last = parseFloat(row[`${side}_Last`]);
    const vol = parseFloat(row[`${side}_Volume`]) || 0;
    const oi = parseFloat(row[`${side}_Openinterest`]) || 0;
    if (!(bid > 0) && !(ask > 0) && !(last > 0)) return null;

    // Mid is the fair mark. Fall back to last, then to whichever side quotes.
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (last > 0 ? last : (bid || ask));
    return {
      bid: bid || 0,
      ask: ask || 0,
      last: last || 0,
      mid: +mid.toFixed(2),
      volume: vol,
      openInterest: oi,
      underlyingPrice,
      strike,
      expiration: currentExpiryISO,
      type: want.type,
    };
  }
  return null;
}

export default async function handler(req, res) {
  const raw = (req.query && (req.query.occ || req.query.symbols)) || '';
  const symbols = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 25);

  if (!symbols.length) {
    res.status(400).json({ error: 'Pass ?occ=NVDA260814C00215000,...' });
    return;
  }

  // Group by underlying so we fetch each chain only once
  const byRoot = {};
  const parsed = {};
  for (const occ of symbols) {
    const p = parseOCC(occ);
    if (!p) continue;
    parsed[occ] = p;
    (byRoot[p.root] ||= []).push(occ);
  }

  const roots = Object.keys(byRoot);
  const chains = await Promise.all(roots.map(async (r) => [r, await fetchChain(r)]));
  const chainMap = Object.fromEntries(chains);

  const quotes = {};
  const errors = {};
  for (const occ of symbols) {
    const p = parsed[occ];
    if (!p) { errors[occ] = 'malformed OCC symbol'; continue; }
    const chain = chainMap[p.root];
    if (!chain) { errors[occ] = `no chain for ${p.root}`; continue; }
    const found = findContract(chain, p);
    if (!found) { errors[occ] = 'contract not found in chain (expired or illiquid)'; continue; }
    quotes[occ] = found;
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    quotes,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
}

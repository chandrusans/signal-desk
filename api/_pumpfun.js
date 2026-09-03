// Handler behind /api/crypto?op=pumpfun
//
// pump.fun tokens, sourced via DexScreener's public API.
//
// pump.fun's own endpoints (frontend-api.pump.fun) return 403 behind Cloudflare,
// so they are not used. DexScreener publishes a documented free API that indexes
// pumpswap — pump.fun's own DEX — and that is what this reads.
//
// ── WHY THIS SCORES EXIT RISK, NOT ENTRY ───────────────────────────────────
// Measured across a 222-pair sample of graduated pump.fun tokens:
//
//   • 37% no longer report liquidity at all
//   • only 22% are "exitable" (liquidity >= $10k AND 24h volume >= $1k)
//   • median 24h volume collapses from ~$4,500 (<1 day old) to ~$30-56 (7d+)
//   • 20% have liquidity under 5% of market cap — a $1k sale moves the price hard
//   • 58% of the 7-day-plus cohort is negative on the day
//
// And that sample is ALREADY THE SURVIVORS: DexScreener only indexes tokens that
// completed the bonding curve and reached a DEX. Everything that died before
// graduating is invisible here, so the real distribution is worse than these
// numbers, not better.
//
// The binding risk in this market is not picking the wrong token. It is holding
// one you cannot sell. So the score below measures exit risk.

const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
const SEARCH = (q) => `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;

// DexScreener caps each search response at 30 and RANKS BY ACTIVITY, so a
// narrow query set returns only the busiest tokens. Ten queries reported 73%
// "exitable"; widening to the set below took the same measurement to ~22%,
// which is the ranking bias, not a change in the market. Even this is not a
// random sample — see the note on `stats` in the response.
const QUERIES = [
  'pumpswap', 'pump', 'sol', 'solana', 'meme', 'ai', 'cat', 'dog', 'moon', 'pepe',
  'bonk', 'inu', 'baby', 'elon', 'trump', 'wojak', 'chad', 'frog', 'bull', 'rocket',
  'banana', 'gold', 'sun', 'king', 'fire', 'ghost', 'panda', 'tiger', 'robot', 'alien',
  'pizza', 'beer', 'coin', 'token', 'gm', 'x', 'a', 'b', 'c', 'usd',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

/**
 * Exit-risk score, 0-100. HIGH IS BAD — this is a hazard score, not a buy score.
 * Every component answers one question: if you bought, could you get out?
 */
function exitRisk(p) {
  const liq = p.liquidity?.usd ?? 0;
  const vol = p.volume?.h24 ?? 0;
  const mc = p.marketCap ?? p.fdv ?? 0;
  const t24 = p.txns?.h24 || {};
  const ageDays = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 86400000 : null;

  let risk = 0;
  const flags = [];

  // 1. Depth (0-30). Liquidity IS the exit. Below ~$10k you are the exit liquidity.
  if (liq < 1000) { risk += 30; flags.push('Liquidity under $1k — effectively unsellable'); }
  else if (liq < 10000) { risk += 22; flags.push(`Liquidity only $${Math.round(liq).toLocaleString()} — a small sale moves the price hard`); }
  else if (liq < 50000) { risk += 12; flags.push(`Thin liquidity ($${Math.round(liq).toLocaleString()})`); }

  // 2. Is anyone still trading it (0-25). Volume dies within days on this venue.
  if (vol < 100) { risk += 25; flags.push(`24h volume $${Math.round(vol)} — no active market`); }
  else if (vol < 1000) { risk += 18; flags.push(`24h volume only $${Math.round(vol)}`); }
  else if (vol < 10000) { risk += 8; }

  // 3. Liquidity as a share of market cap (0-20). A large cap on a thin pool
  //    means the quoted value cannot be realised at anything near that price.
  const lr = mc > 0 ? (liq / mc) * 100 : null;
  if (lr != null) {
    if (lr < 2) { risk += 20; flags.push(`Pool is only ${lr.toFixed(1)}% of market cap — the valuation is not realisable`); }
    else if (lr < 5) { risk += 13; flags.push(`Pool is ${lr.toFixed(1)}% of market cap`); }
    else if (lr < 10) { risk += 6; }
  }

  // 4. Distribution already unwinding (0-15)
  const tot = (t24.buys || 0) + (t24.sells || 0);
  const sellShare = tot > 0 ? ((t24.sells || 0) / tot) * 100 : null;
  if (sellShare != null && tot >= 20) {
    if (sellShare >= 70) { risk += 15; flags.push(`${sellShare.toFixed(0)}% of 24h trades are sells — holders are exiting`); }
    else if (sellShare >= 58) { risk += 8; flags.push(`Sell-weighted tape (${sellShare.toFixed(0)}% sells)`); }
  }

  // 5. Age vs activity (0-10). Volume decay is the death curve.
  if (ageDays != null && ageDays > 7 && vol < 1000) {
    risk += 10;
    flags.push(`${Math.round(ageDays)} days old with almost no volume — past the point these recover`);
  }

  // Paid promotion is an advertising slot, not a signal. Called out because it
  // looks like endorsement on the DexScreener UI.
  if (p.boosts?.active) flags.push(`Paid "boost" active (${p.boosts.active}) — this is advertising, not demand`);

  risk = Math.max(0, Math.min(100, risk));
  const band = risk >= 70 ? 'EXTREME' : risk >= 45 ? 'HIGH' : risk >= 25 ? 'ELEVATED' : 'MODERATE';

  // Max position implied by pool depth. Taking more than ~1% of the pool means
  // your own exit is the thing that moves the price against you.
  const maxPositionUsd = liq > 0 ? Math.floor(liq * 0.01) : 0;

  return { risk, band, flags, liquidityRatioPct: r2(lr), sellSharePct: r2(sellShare), maxPositionUsd, ageDays: r2(ageDays) };
}

export default async function handler(req, res) {
  const seen = new Map();
  for (const q of QUERIES) {
    try {
      const r = await fetch(SEARCH(q), { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of d.pairs || []) {
        if (p.chainId !== 'solana') continue;
        // pump.fun mints conventionally end in "pump"; pumpswap is its own DEX
        const isPump = p.dexId === 'pumpswap' || String(p.baseToken?.address || '').endsWith('pump');
        if (isPump && p.pairAddress) seen.set(p.pairAddress, p);
      }
    } catch { /* keep going; a partial sample is still usable */ }
    await sleep(90);
  }

  const pairs = [...seen.values()];
  if (!pairs.length) {
    res.setHeader('Cache-Control', 's-maxage=120');
    res.status(200).json({ error: 'no pump.fun pairs returned', tokens: [], stats: null });
    return;
  }

  const tokens = pairs.map((p) => {
    const er = exitRisk(p);
    return {
      symbol: p.baseToken?.symbol || '?',
      name: p.baseToken?.name || '',
      address: p.baseToken?.address,
      pair: p.pairAddress,
      url: p.url,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: r2(p.liquidity?.usd),
      volume24: r2(p.volume?.h24),
      marketCap: r2(p.marketCap ?? p.fdv),
      change24: r2(p.priceChange?.h24),
      change1h: r2(p.priceChange?.h1),
      buys24: p.txns?.h24?.buys ?? null,
      sells24: p.txns?.h24?.sells ?? null,
      ...er,
    };
  }).sort((a, b) => a.risk - b.risk || (b.volume24 ?? 0) - (a.volume24 ?? 0));

  // Sample statistics. NOT a population base rate — see `samplingCaveat`.
  const n = tokens.length;
  const exitable = tokens.filter((t) => (t.liquidityUsd ?? 0) >= 10000 && (t.volume24 ?? 0) >= 1000).length;
  const noLiq = tokens.filter((t) => t.liquidityUsd == null || t.liquidityUsd === 0).length;
  const med = (arr) => {
    const b = arr.filter(Number.isFinite).sort((x, y) => x - y);
    return b.length ? b[Math.floor(b.length / 2)] : null;
  };
  const older = tokens.filter((t) => (t.ageDays ?? 0) >= 7);

  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    asOf: Date.now(),
    source: 'DexScreener public API (pumpswap / pump.fun mints)',
    sampled: n,
    stats: {
      exitable,
      exitablePct: r2((exitable / n) * 100),
      noLiquidity: noLiq,
      medianLiquidityUsd: med(tokens.map((t) => t.liquidityUsd)),
      medianVolume24: med(tokens.map((t) => t.volume24)),
      medianVolume24Fresh: med(tokens.filter((t) => (t.ageDays ?? 99) < 1).map((t) => t.volume24)),
      medianVolume24Older: med(older.map((t) => t.volume24)),
      olderNegativePct: older.length
        ? r2((older.filter((t) => (t.change24 ?? 0) < 0).length / older.length) * 100)
        : null,
      extremeRiskPct: r2((tokens.filter((t) => t.band === 'EXTREME').length / n) * 100),
    },
    samplingCaveat:
      'DexScreener search ranks by activity, so this sample over-represents busy tokens. '
      + 'It is what this screen can see, not a random draw from all pump.fun launches.',
    survivorshipWarning:
      'Only tokens that completed the bonding curve and reached a DEX are indexed at all. '
      + 'Everything that died before graduating is invisible here, so the real distribution is '
      + 'worse than any figure on this page.',
    tokens: tokens.slice(0, 60),
  });
}

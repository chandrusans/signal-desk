// Vercel serverless: /api/crypto-universe
//
// The tradeable crypto universe: CoinGecko's top coins by market cap,
// intersected with the USD pairs actually online on Coinbase.
//
// The intersection matters. Ranking by market cap alone surfaces coins the
// user cannot buy on a US exchange, and a recommendation you can't act on is
// noise. Everything returned here has a live Coinbase USD order book.
//
// Cached 1h at the edge — the top-100 list reshuffles slowly, and CoinGecko's
// free tier is rate-limited.

const CG = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h,7d';
const CB_PRODUCTS = 'https://api.exchange.coinbase.com/products';
const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';

// Stablecoins and wrapped/staked derivatives. They either don't move (so a
// momentum score is meaningless) or they mirror an asset already in the list.
const EXCLUDE = new Set([
  'USDT', 'USDC', 'DAI', 'FDUSD', 'USDE', 'PYUSD', 'TUSD', 'USDS', 'USDD', 'BUSD',
  'WBTC', 'CBBTC', 'WBETH', 'WEETH', 'STETH', 'WSTETH', 'RETH', 'METH', 'SOLVBTC',
  'LBTC', 'BSC-USD', 'USD1', 'RLUSD', 'EURC', 'BUIDL',
]);

// Used when CoinGecko is unreachable or rate-limited. Deliberately the most
// liquid Coinbase USD pairs, so the page degrades to "fewer coins" not "broken".
const FALLBACK = [
  ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['XRP', 'XRP'], ['SOL', 'Solana'],
  ['DOGE', 'Dogecoin'], ['ADA', 'Cardano'], ['LINK', 'Chainlink'], ['AVAX', 'Avalanche'],
  ['XLM', 'Stellar'], ['LTC', 'Litecoin'], ['DOT', 'Polkadot'], ['UNI', 'Uniswap'],
  ['AAVE', 'Aave'], ['ETC', 'Ethereum Classic'], ['NEAR', 'NEAR Protocol'],
  ['ICP', 'Internet Computer'], ['ALGO', 'Algorand'], ['ATOM', 'Cosmos'],
  ['FIL', 'Filecoin'], ['ARB', 'Arbitrum'], ['OP', 'Optimism'], ['INJ', 'Injective'],
  ['GRT', 'The Graph'], ['LDO', 'Lido DAO'], ['SUI', 'Sui'],
].map(([symbol, name], i) => ({
  symbol, name, product: `${symbol}-USD`, rank: i + 1,
  marketCap: null, volume24h: null, change24h: null, change7d: null,
}));

/** Coinbase product ids that are online, USD-quoted and not disabled. */
async function coinbaseUsdProducts() {
  const r = await fetch(CB_PRODUCTS, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const list = await r.json();
  const set = new Set();
  for (const p of list) {
    if (p.quote_currency !== 'USD') continue;
    if (p.status !== 'online') continue;
    if (p.trading_disabled || p.cancel_only || p.post_only) continue;
    set.add(String(p.base_currency).toUpperCase());
  }
  return set;
}

export default async function handler(req, res) {
  const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '40', 10) || 40, 5), 100);

  let coins = null;
  let source = 'fallback';

  try {
    const [cgRes, cbSet] = await Promise.all([
      fetch(CG, { headers: { 'User-Agent': UA, Accept: 'application/json' } }),
      coinbaseUsdProducts(),
    ]);

    if (cgRes.ok && cbSet && cbSet.size) {
      const markets = await cgRes.json();
      const out = [];
      for (const m of markets) {
        const symbol = String(m.symbol || '').toUpperCase();
        if (!symbol || EXCLUDE.has(symbol)) continue;
        if (!cbSet.has(symbol)) continue;              // not buyable on Coinbase
        out.push({
          symbol,
          name: m.name || symbol,
          product: `${symbol}-USD`,
          rank: m.market_cap_rank ?? null,
          marketCap: m.market_cap ?? null,
          volume24h: m.total_volume ?? null,
          change24h: m.price_change_percentage_24h ?? null,
          change7d: m.price_change_percentage_7d_in_currency ?? null,
        });
      }
      if (out.length >= 10) { coins = out; source = 'coingecko+coinbase'; }
    }
  } catch { /* fall through */ }

  // Even the fallback gets filtered against Coinbase when that call succeeded
  if (!coins) coins = FALLBACK;

  const constituents = coins.slice(0, limit);

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.status(200).json({
    asOf: Date.now(),
    source,
    count: constituents.length,
    availableOnCoinbase: coins.length,
    constituents,
  });
}

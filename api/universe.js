// Vercel serverless: /api/universe
//
// Returns the S&P 500 constituent list with GICS sectors. Cached hard at the
// edge (24h) because the index changes a handful of times per year.
//
// Source: the datasets/s-and-p-500-companies repo, which tracks the Wikipedia
// constituent table. If it's unreachable we fall back to an embedded list of
// the largest names so the app degrades to "fewer tickers" rather than "broken".

const SRC = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

// GICS sector -> SPDR sector ETF. Used for sector-relative strength: a stock
// beating SPY but lagging its own sector is not actually a leader.
export const SECTOR_ETF = {
  'Information Technology': 'XLK',
  'Health Care': 'XLV',
  'Financials': 'XLF',
  'Consumer Discretionary': 'XLY',
  'Communication Services': 'XLC',
  'Industrials': 'XLI',
  'Consumer Staples': 'XLP',
  'Energy': 'XLE',
  'Utilities': 'XLU',
  'Real Estate': 'XLRE',
  'Materials': 'XLB',
};

// Minimal fallback — the mega-caps. Only used if the source fetch fails.
const FALLBACK = [
  ['AAPL','Apple','Information Technology'], ['MSFT','Microsoft','Information Technology'],
  ['NVDA','NVIDIA','Information Technology'], ['AMZN','Amazon','Consumer Discretionary'],
  ['GOOGL','Alphabet','Communication Services'], ['META','Meta Platforms','Communication Services'],
  ['TSLA','Tesla','Consumer Discretionary'], ['AVGO','Broadcom','Information Technology'],
  ['LLY','Eli Lilly','Health Care'], ['JPM','JPMorgan Chase','Financials'],
  ['XOM','Exxon Mobil','Energy'], ['UNH','UnitedHealth','Health Care'],
  ['V','Visa','Financials'], ['PG','Procter & Gamble','Consumer Staples'],
  ['MA','Mastercard','Financials'], ['JNJ','Johnson & Johnson','Health Care'],
  ['HD','Home Depot','Consumer Discretionary'], ['COST','Costco','Consumer Staples'],
  ['ABBV','AbbVie','Health Care'], ['WMT','Walmart','Consumer Staples'],
  ['AMD','Advanced Micro Devices','Information Technology'], ['CRM','Salesforce','Information Technology'],
  ['NFLX','Netflix','Communication Services'], ['ORCL','Oracle','Information Technology'],
  ['BAC','Bank of America','Financials'], ['KO','Coca-Cola','Consumer Staples'],
  ['PEP','PepsiCo','Consumer Staples'], ['MRK','Merck','Health Care'],
  ['CVX','Chevron','Energy'], ['ADBE','Adobe','Information Technology'],
].map(([symbol, name, sector]) => ({ symbol, name, sector, sectorEtf: SECTOR_ETF[sector] || null }));

/** Minimal CSV parser that respects quoted fields containing commas. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export default async function handler(req, res) {
  let constituents = null;
  let source = 'fallback';

  try {
    const r = await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0 (SignalDesk)' } });
    if (r.ok) {
      const rows = parseCSV(await r.text());
      const header = rows[0] || [];
      const iSym = header.indexOf('Symbol');
      const iName = header.indexOf('Security');
      const iSector = header.indexOf('GICS Sector');
      if (iSym >= 0) {
        const out = [];
        for (const row of rows.slice(1)) {
          const symbol = (row[iSym] || '').trim();
          if (!symbol) continue;
          const sector = (row[iSector] || '').trim();
          out.push({
            // Yahoo uses dashes where the index uses dots (BRK.B -> BRK-B)
            symbol: symbol.replace(/\./g, '-'),
            name: (row[iName] || symbol).trim(),
            sector,
            sectorEtf: SECTOR_ETF[sector] || null,
          });
        }
        if (out.length > 100) { constituents = out; source = 'datasets/s-and-p-500-companies'; }
      }
    }
  } catch { /* fall through to fallback */ }

  if (!constituents) constituents = FALLBACK;

  // Sector breakdown is useful for the UI's sector filter
  const sectors = {};
  for (const c of constituents) sectors[c.sector] = (sectors[c.sector] || 0) + 1;

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');
  res.status(200).json({
    asOf: Date.now(),
    source,
    count: constituents.length,
    sectors,
    sectorEtfs: SECTOR_ETF,
    constituents,
  });
}

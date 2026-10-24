// Vercel serverless: /api/congress
//
// Congressional stock trades — the data behind CapitolTrades, taken from the
// primary source rather than the site.
//
// capitoltrades.com sits behind bot protection, and working around that would
// mean defeating a security control. It is a viewer over public STOCK Act
// filings, so this reads those filings directly: the Clerk of the House
// publishes a ZIP index of every financial disclosure, and each Periodic
// Transaction Report (PTR) is a PDF with a machine-readable text layer.
//
// ── READ THIS BEFORE WEIGHTING IT ──────────────────────────────────────────
// Measured over 2,379 disclosed 2026 stock transactions, excess return vs SPY
// from the NOTIFICATION date — the first moment the public could act:
//
//     BUY  +5d   -0.13%   t=-0.71     BUY  +20d   -0.49%   t=-1.39
//     SELL +5d   -0.28%   t=-1.72     SELL +20d   -0.34%   t=-0.99
//
// Nothing is significant, and following disclosed BUYs slightly UNDER-performed
// the index. The cause is structural: the median disclosure lag is 18 days and
// the 90th percentile is 33. By the time a trade is visible it is a month old.
//
// So this endpoint feeds a CONTEXT badge, not the composite score. It tells you
// who is trading what; it does not tell you what to buy.

import { extractText, getDocumentProxy } from 'unpdf';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const INDEX = (year) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
const PTR = (year, id) => `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${id}.pdf`;

// Ticker in parens, asset class in brackets, then type / txn date / notify date / amount band.
const TXN_RE = /\(([A-Z][A-Z.\-]{0,5})\)\s*\[(ST|OP|OT|GS|ETF|CS|MF|OI|PS|RP)\]\s*(P|S\s*\(partial\)|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+\$([\d,]+)\s*-\s*\$?([\d,]+)/g;

const MAX_FILINGS = 45;          // most recent PTRs to parse per invocation
export const config = { maxDuration: 60 };

function parsePTR(text) {
  const t = String(text).replace(/\s+/g, ' ');
  const out = [];
  let m;
  TXN_RE.lastIndex = 0;
  while ((m = TXN_RE.exec(t)) !== null) {
    const [, ticker, cls, rawType, txnDate, notifDate, lo, hi] = m;
    out.push({
      ticker,
      assetClass: cls,
      type: rawType.startsWith('S') ? 'SELL' : rawType === 'P' ? 'BUY' : 'EXCHANGE',
      partial: /partial/.test(rawType),
      txnDate,
      notifDate,
      amountLow: +lo.replace(/,/g, ''),
      amountHigh: +hi.replace(/,/g, ''),
    });
  }
  return out;
}

/**
 * The index ZIP holds a tab-delimited .txt. Rather than pull in a zip library,
 * inflate the single deflated member directly — the format is fixed and this
 * keeps the function dependency-light.
 */
async function fetchIndex(year) {
  const r = await fetch(INDEX(year), { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  const { inflateRawSync, inflateSync } = await import('node:zlib');

  // Walk local file headers looking for the .txt member
  let off = 0;
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('latin1');
    const dataStart = off + 30 + nameLen + extraLen;
    if (/\.txt$/i.test(name) && compSize > 0) {
      const raw = buf.slice(dataStart, dataStart + compSize);
      try {
        return (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
      } catch {
        try { return inflateSync(raw).toString('utf8'); } catch { return null; }
      }
    }
    off = dataStart + compSize;
  }
  return null;
}

const parseDate = (s) => {
  const [m, d, y] = String(s).split('/').map(Number);
  return Number.isFinite(y) ? Date.UTC(y, m - 1, d) : 0;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const year = new Date().getUTCFullYear();
  const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || String(MAX_FILINGS), 10) || MAX_FILINGS, 5), 60);

  let indexText = await fetchIndex(year);
  let usedYear = year;
  if (!indexText) { indexText = await fetchIndex(year - 1); usedYear = year - 1; }
  if (!indexText) {
    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(200).json({ error: 'House disclosure index unavailable', trades: [], byTicker: {} });
    return;
  }

  // Tab-delimited with CRLF endings — trim every field or keys carry a \r.
  const lines = indexText.split(/\r?\n/).filter(Boolean);
  const hdr = lines[0].split('\t').map((h) => h.trim());
  const rows = lines.slice(1).map((l) => {
    const p = l.split('\t').map((x) => x.trim());
    return Object.fromEntries(hdr.map((h, i) => [h, p[i]]));
  });

  const ptrs = rows
    .filter((r) => r.FilingType === 'P' && r.DocID)
    .sort((a, b) => parseDate(b.FilingDate) - parseDate(a.FilingDate))
    .slice(0, limit);

  const trades = [];
  let parsed = 0, empty = 0, failed = 0;
  for (const r of ptrs) {
    try {
      const pr = await fetch(PTR(usedYear, r.DocID), { headers: { 'User-Agent': UA } });
      if (!pr.ok) { failed++; continue; }
      const pdf = await getDocumentProxy(new Uint8Array(await pr.arrayBuffer()));
      const { text } = await extractText(pdf, { mergePages: true });
      const t = parsePTR(text);
      if (!t.length) { empty++; continue; }
      parsed++;
      for (const x of t) {
        trades.push({
          ...x,
          member: `${r.First || ''} ${r.Last || ''}`.trim(),
          district: r.StateDst || null,
          filingDate: r.FilingDate,
          docId: r.DocID,
        });
      }
    } catch { failed++; }
    await sleep(40);
  }

  // Aggregate the equity trades by ticker so the UI can badge a card cheaply
  const byTicker = {};
  for (const t of trades) {
    if (t.assetClass !== 'ST' || t.type === 'EXCHANGE') continue;
    const b = (byTicker[t.ticker] ||= {
      ticker: t.ticker, buys: 0, sells: 0, members: new Set(),
      notionalLow: 0, notionalHigh: 0, latest: null,
    });
    if (t.type === 'BUY') b.buys++; else b.sells++;
    b.members.add(t.member);
    b.notionalLow += t.amountLow;
    b.notionalHigh += t.amountHigh;
    const ts = parseDate(t.notifDate);
    if (!b.latest || ts > parseDate(b.latest)) b.latest = t.notifDate;
  }
  const agg = Object.values(byTicker)
    .map((b) => ({
      ticker: b.ticker,
      buys: b.buys,
      sells: b.sells,
      net: b.buys - b.sells,
      members: b.members.size,
      notionalLow: b.notionalLow,
      notionalHigh: b.notionalHigh,
      latest: b.latest,
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.members - a.members);

  // Median disclosure lag in THIS sample — the reason the signal is stale
  const lags = trades
    .map((t) => (parseDate(t.notifDate) - parseDate(t.txnDate)) / 86400000)
    .filter((x) => x >= 0 && x < 400)
    .sort((a, b) => a - b);
  const medianLagDays = lags.length ? lags[Math.floor(lags.length / 2)] : null;

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
  res.status(200).json({
    asOf: Date.now(),
    source: `Clerk of the House — ${usedYear} financial disclosures (STOCK Act PTRs)`,
    coverage: { filingsRequested: ptrs.length, filingsParsed: parsed, noTransactions: empty, failed },
    medianLagDays,
    // Shipped with the data so no caller can present this as a timing edge
    predictiveValue: {
      tested: '2,379 disclosed 2026 stock transactions',
      method: 'excess return vs SPY from the notification date',
      result: 'BUY +20d -0.49% (t=-1.39); SELL +20d -0.34% (t=-0.99) — none significant',
      conclusion: 'No measurable edge. Disclosure lag (median 18d) removes it. Context only — not scored.',
    },
    totalTrades: trades.length,
    byTicker: agg.slice(0, 60),
    trades: trades.slice(0, 200),
  });
}

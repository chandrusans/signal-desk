// Handler behind /api/intel?op=analyst&tickers=NVDA,AAPL
//
// Analyst consensus and price targets from NASDAQ's public analyst endpoints.
//
// Two layers:
//
//   consensus  NASDAQ's `ratings` + `targetprice` endpoints: Buy/Hold/Sell
//              counts, mean target, and a 13-month monthly history. NASDAQ's
//              own `upgradesDowngrades` array is EMPTY on every ticker tested,
//              so individual events do not come from here.
//
//   events     stockanalysis.com's per-ticker ratings page: analyst, firm,
//              rating, ACTION (Upgrades / Downgrades / Initiates / Maintains /
//              Reiterates), price target with from -> to, and the date. That is
//              "Apple gets upgraded to Buy by Morgan Stanley on Oct 21" — the
//              event-level alert. The page is server-rendered HTML with no bot
//              wall and robots.txt permits /stocks/; it is fetched sequentially
//              with a small delay, cached an hour, and parsed with the table
//              structure checked on every row so a layout change degrades to
//              "no events" rather than wrong events.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const R = (t) => `https://api.nasdaq.com/api/analyst/${encodeURIComponent(t)}/ratings`;
const P = (t) => `https://api.nasdaq.com/api/analyst/${encodeURIComponent(t)}/targetprice`;
const MAX = 30;
const SA = (t) => `https://stockanalysis.com/stocks/${encodeURIComponent(t.toLowerCase().replace('-', '.'))}/ratings/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// Decode entities generically — the target arrow arrives as `&#8594` with no
// trailing semicolon, which a fixed list would miss (and did: every target
// change parsed as a single number until this handled numeric entities).
const strip = (h) => h.replace(/<[^>]+>/g, ' ')
  .replace(/&#x([0-9a-f]+);?/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&rarr;/g, '\u2192').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();
const money = (x) => { const m = String(x || '').match(/\$([\d,.]+)/); return m ? +m[1].replace(/,/g, '') : null; };

/** Per-firm rating events. Returns [] rather than guessing when the table shape is not what we expect. */
async function events(t) {
  try {
    const r = await fetch(SA(t), { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!r.ok) return [];
    const html = await r.text();
    const tbl = html.slice(html.indexOf('<table'), html.indexOf('</table>') + 8);
    const out = [];
    for (const row of tbl.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((m) => strip(m[1]));
      // Expected: [analyst+firm, firm, combined, rating, action, target, upside, date]
      if (cells.length < 8 || cells[0] === 'Analyst') continue;
      const dm = cells[7].match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
      if (!dm || !(dm[1] in MONTHS)) continue;
      const date = new Date(Date.UTC(+dm[3], MONTHS[dm[1]], +dm[2])).toISOString().slice(0, 10);
      const action = cells[4];
      const tgt = cells[5]; const arrow = tgt.split('→');
      const targetFrom = arrow.length === 2 ? money(arrow[0]) : null;
      const targetTo = money(arrow.length === 2 ? arrow[1] : tgt);
      const targetChangePct = targetFrom && targetTo ? +(((targetTo - targetFrom) / targetFrom) * 100).toFixed(1) : null;
      const firm = cells[1];
      const analyst = cells[0].replace(firm, '').trim() || null;
      const isRatingEvent = /^(Upgrades?|Downgrades?|Initiates?|Resumes?|Assumes?)$/i.test(action);
      out.push({
        id: `${firm}:${date}:${action}:${cells[3]}:${targetTo ?? ''}`,
        date, firm, analyst, rating: cells[3], action,
        targetFrom, targetTo, targetChangePct,
        upside: cells[6] === 'n/a' ? null : parseFloat(cells[6]),
        // What makes it worth an alert: a rating action, or a target moved >= 5%
        isEvent: isRatingEvent || (targetChangePct != null && Math.abs(targetChangePct) >= 5),
        kind: isRatingEvent ? action.replace(/s$/, '').toLowerCase() : (targetChangePct != null ? (targetChangePct > 0 ? 'target_raised' : 'target_cut') : 'maintains'),
      });
    }
    return out;
  } catch { return []; }
}

async function j(url) { const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); if (!r.ok) return null; return (await r.json())?.data || null; }

async function one(t) {
  try {
    const [rt, tp, ev] = await Promise.all([j(R(t)), j(P(t)), events(t)]);
    if (!rt && !tp && !ev.length) return null;
    const c = tp?.consensusOverview || {};
    const hist = (tp?.historicalConsensus || []).map((h) => ({ date: h.z?.date, consensus: h.z?.consensus, buy: +h.z?.buy || 0, hold: +h.z?.hold || 0, sell: +h.z?.sell || 0, price: h.y != null ? +h.y : null }));
    const now = { consensus: rt?.meanRatingType || null, buy: +c.buy || 0, hold: +c.hold || 0, sell: +c.sell || 0, target: c.priceTarget != null ? +c.priceTarget : null, low: c.lowPriceTarget != null ? +c.lowPriceTarget : null, high: c.highPriceTarget != null ? +c.highPriceTarget : null };
    const prev = hist.length ? hist[hist.length - 1] : null;      // most recent monthly snapshot
    // Compare like with like. The `ratings` endpoint's meanRatingType covers a
    // different analyst pool (39 for NVDA) than `targetprice`'s counts (33), so
    // comparing one against the other produced false "Buy -> Hold" flips. Both
    // the current counts and the history come from targetprice, so the
    // majority class of each is the consistent thing to compare.
    const majority = (b, h, sl) => (b >= h && b >= sl ? 'Buy' : h >= sl ? 'Hold' : 'Sell');
    const nowMaj = majority(now.buy, now.hold, now.sell);
    const change = [];
    if (prev) {
      const prevMaj = majority(prev.buy, prev.hold, prev.sell);
      if (nowMaj !== prevMaj) change.push({ kind: 'consensus', from: prevMaj, to: nowMaj });
      const dBuy = now.buy - prev.buy, dSell = now.sell - prev.sell;
      if (Math.abs(dBuy) >= 2 || Math.abs(dSell) >= 2) change.push({ kind: 'counts', buy: dBuy, hold: now.hold - prev.hold, sell: dSell });
      if (prev.price && now.target) { const dT = ((now.target - prev.price) / prev.price) * 100; if (Math.abs(dT) >= 5) change.push({ kind: 'target', from: prev.price, to: now.target, pct: +dT.toFixed(1) }); }
    }
    const analysts = now.buy + now.hold + now.sell;
    const m = String(rt?.ratingsSummary || '').match(/(\d+)\s+analysts?/i);
    return {
      ticker: t,
      consensus: nowMaj, meanRating: now.consensus, buy: now.buy, hold: now.hold, sell: now.sell,
      analysts: m ? +m[1] : analysts,
      target: now.target, targetLow: now.low, targetHigh: now.high,
      upgradesDowngrades: rt?.upgradesDowngrades || [],          // NASDAQ's own — empty everywhere; kept visible, not hidden
      events: ev,                                                 // per-firm actions, newest first, from stockanalysis.com
      eventCount: ev.filter((e) => e.isEvent).length,
      prior: prev ? { date: prev.date, consensus: majority(prev.buy, prev.hold, prev.sell), buy: prev.buy, hold: prev.hold, sell: prev.sell, target: prev.price } : null,
      change,
      changed: change.length > 0,
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  const tickers = String((req.query && req.query.tickers) || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z.\-]{1,6}$/.test(s)).slice(0, MAX);
  if (!tickers.length) { res.status(400).json({ error: 'Pass ?tickers=NVDA,AAPL' }); return; }
  const out = {};
  for (const t of tickers) { const r = await one(t); if (r) out[t] = r; await sleep(150); }   // sequential — polite to the HTML source
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.status(200).json({
    asOf: Date.now(),
    source: 'consensus: NASDAQ analyst ratings + targetprice · events: stockanalysis.com ratings page',
    note: '`events` are per-firm actions (upgrade / downgrade / initiate / target change) with analyst, firm and date. `changed` means the NASDAQ consensus moved since the prior monthly snapshot. NASDAQ\'s own upgradesDowngrades field is empty on every ticker and is kept visible so that is not hidden.',
    results: out,
  });
}

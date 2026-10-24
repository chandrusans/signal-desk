// Vercel serverless: /api/macro-calendar
//
// Economic calendar from the FairEconomy JSON feed — the same feed that powers
// ForexFactory's own calendar widget (FairEconomy publishes ForexFactory).
//
// Why the feed and not the site: forexfactory.com/calendar returns 403 to
// anything that is not a browser, and working around that would mean defeating
// bot protection. The JSON feed is the publisher's own machine-readable
// endpoint for exactly this data, so we use it.
//
// What this is FOR: an event-risk gate, not a direction forecast. It answers
// "is there an event in the next N hours that can gap the whole market through
// my stop?" — the same question the earnings gate answers for a single name.
// Nothing here predicts which way a release lands.

const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];
const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';

// Releases that move the whole US tape, not just a currency pair. These are the
// ones worth blocking new equity/crypto entries around.
const TIER1 = [
  /non-?farm/i, /\bFOMC\b/i, /federal funds rate/i, /\bCPI\b/i, /core cpi/i,
  /\bPPI\b/i, /unemployment rate/i, /average hourly earnings/i,
  /ISM (manufacturing|services) pmi/i, /retail sales/i, /gdp/i,
  /fed chair/i, /powell/i, /\bPCE\b/i, /jobless claims/i,
];

const isTier1 = (title) => TIER1.some((re) => re.test(title || ''));

export default async function handler(req, res) {
  const hoursAhead = Math.min(Math.max(parseInt((req.query && req.query.hours) || '72', 10) || 72, 6), 336);

  let events = [];
  let source = null;
  for (const url of FEEDS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) continue;
      const d = await r.json();
      if (Array.isArray(d)) { events.push(...d); source = source || 'faireconomy (forexfactory)'; }
    } catch { /* try the next feed */ }
  }

  if (!events.length) {
    res.setHeader('Cache-Control', 's-maxage=120');
    res.status(200).json({ error: 'calendar feed unavailable', events: [], macroRisk: null });
    return;
  }

  const now = Date.now();
  const horizon = now + hoursAhead * 3600 * 1000;

  const norm = events
    .map((e) => {
      const ts = Date.parse(e.date);
      if (!isFinite(ts)) return null;
      return {
        title: e.title,
        currency: e.country,          // the feed calls the currency "country"
        impact: e.impact,             // High | Medium | Low | Holiday
        date: new Date(ts).toISOString(),
        ts,
        hoursUntil: Math.round(((ts - now) / 3600000) * 10) / 10,
        forecast: e.forecast || null,
        previous: e.previous || null,
        tier1: isTier1(e.title),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  const upcoming = norm.filter((e) => e.ts >= now && e.ts <= horizon);

  // US-tape risk: high-impact USD releases are what gap equity indices and,
  // increasingly, crypto. Other currencies matter for FX, not for this app.
  const usdHigh = upcoming.filter((e) => e.currency === 'USD' && e.impact === 'High');
  const usdTier1 = usdHigh.filter((e) => e.tier1);
  const next = usdTier1[0] || usdHigh[0] || null;

  // Gate levels mirror the earnings gate: inside 24h no new entries, inside 48h
  // half size. An ATR stop cannot manage a gap it never trades through.
  let level = 'clear', sizeMult = 1, note = 'No high-impact US release inside the window.';
  if (next && next.hoursUntil <= 24) {
    level = 'blocked';
    sizeMult = 0.25;
    note = `${next.title} in ${next.hoursUntil}h. No new entries — an index-wide gap fills through your stop, not at it.`;
  } else if (next && next.hoursUntil <= 48) {
    level = 'caution';
    sizeMult = 0.5;
    note = `${next.title} in ${next.hoursUntil}h. Half size on new entries.`;
  } else if (next) {
    note = `Next major US release: ${next.title} in ${next.hoursUntil}h.`;
  }

  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  res.status(200).json({
    asOf: now,
    source,
    hoursAhead,
    macroRisk: { level, sizeMult, note, next },
    counts: {
      total: upcoming.length,
      high: upcoming.filter((e) => e.impact === 'High').length,
      usdHigh: usdHigh.length,
    },
    // Everything in the window, so the UI can show a calendar rather than just a verdict
    events: upcoming.slice(0, 80),
  });
}

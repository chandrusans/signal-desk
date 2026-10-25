// Signal Desk — the profile-driven screen: rank the whole universe on fundamentals + technicals.
//
// Input rows come from data/screen.json, built nightly by tools/build-screen.mjs from the
// same sources the Research page uses (SEC filings via the forensic module, the scan for
// technicals, Yahoo for price history, NASDAQ for yield / P/E). This module only ranks.
//
// A profile is { tolerance, horizon, sectors, minYieldPct }. Each row gets five component
// scores on 0–100 (quality, value, growth, momentum, safety) built from percentile ranks
// within the universe, then a weighted total whose weights depend on the profile. Hard
// filters remove what the profile should never see (e.g. risk ≥ 8 for conservative).
// Every reason printed next to a pick is one of the numbers below, never a narrative.

// Mid-rank percentile: ties share the middle of their band instead of all scoring as the worst.
const pctRank = (vals, v, higherBetter = true) => {
  const a = vals.filter((x) => x != null && isFinite(x));
  if (v == null || !isFinite(v) || !a.length) return null;
  let below = 0, equal = 0;
  for (const x of a) { if (x === v) equal++; else if (higherBetter ? x < v : x > v) below++; }
  return ((below + 0.5 * equal) / a.length) * 100;
};
const mean = (a) => { const b = a.filter((x) => x != null && isFinite(x)); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };

export const PROFILES = {
  conservative: { label: 'Conservative', weights: { quality: 0.30, value: 0.20, growth: 0.05, momentum: 0.10, safety: 0.35 }, maxRisk: 5, minMoat: 5, minCash: 'WATCH', excludeSetups: ['BROKEN', 'EARNINGS', 'AVOID'] },
  balanced: { label: 'Balanced', weights: { quality: 0.25, value: 0.20, growth: 0.15, momentum: 0.20, safety: 0.20 }, maxRisk: 7, minMoat: 0, minCash: 'MANUFACTURED?', excludeSetups: ['BROKEN', 'EARNINGS'] },
  aggressive: { label: 'Aggressive', weights: { quality: 0.15, value: 0.10, growth: 0.30, momentum: 0.35, safety: 0.10 }, maxRisk: 10, minMoat: 0, minCash: 'MANUFACTURED?', excludeSetups: ['EARNINGS'] },
};
// Horizon shifts weight between the chart and the filings.
export const HORIZONS = {
  swing: { label: 'Weeks (swing)', tilt: { momentum: +0.20, quality: -0.10, value: -0.10 } },
  months: { label: 'Months', tilt: {} },
  years: { label: 'Years', tilt: { momentum: -0.15, quality: +0.10, value: +0.05 } },
};
const CASH_ORDER = { 'MANUFACTURED?': 0, 'N/A': 1, WATCH: 2, REAL: 3 };

export function moatWord(score) { return score == null ? 'unknown' : score >= 8 ? 'strong' : score >= 5 ? 'moderate' : 'weak'; }

/** Rank rows for a profile. Returns { picks, considered, excluded, weights }. */
export function rankScreen(rows, { tolerance = 'balanced', horizon = 'months', sectors = [], minYieldPct = 0, maxPickRisk = null } = {}) {
  const P = PROFILES[tolerance] || PROFILES.balanced, H = HORIZONS[horizon] || HORIZONS.months;
  const w = { ...P.weights };
  for (const [k, d] of Object.entries(H.tilt)) w[k] = Math.max(0.02, (w[k] || 0) + d);
  const wsum = Object.values(w).reduce((a, b) => a + b, 0); for (const k in w) w[k] /= wsum;

  const all = rows.filter((r) => r && r.t && r.price > 0);
  // universe-wide percentiles (computed before filters, so a pick is judged against everyone)
  const col = (k) => all.map((r) => r[k]);
  const sectorPe = {}; for (const r of all) if (r.pe > 0 && r.pe < 100) (sectorPe[r.sector] = sectorPe[r.sector] || []).push(r.pe);
  const sectorMedianPe = Object.fromEntries(Object.entries(sectorPe).map(([s, a]) => { a.sort((x, y) => x - y); return [s, a.length ? a[a.length >> 1] : null]; }));

  const scored = all.map((r) => {
    const peRel = r.pe > 0 && sectorMedianPe[r.sector] ? r.pe / sectorMedianPe[r.sector] : null;
    const q = mean([pctRank(col('roic'), r.roic), pctRank(col('gm'), r.gm), pctRank(col('moat'), r.moat), r.cash ? (CASH_ORDER[r.cash] ?? 1) / 3 * 100 : null, pctRank(col('credibility'), r.credibility)]);
    const v = mean([pctRank(col('fcfYield'), r.fcfYield), pctRank(all.map((x) => (x.pe > 0 && sectorMedianPe[x.sector] ? x.pe / sectorMedianPe[x.sector] : null)), peRel, false), pctRank(col('premium'), r.premium, false)]);
    const g = mean([pctRank(col('revCagr'), r.revCagr), pctRank(col('epsCagr'), r.epsCagr)]);
    const m = mean([pctRank(col('score'), r.score), pctRank(col('rs'), r.rs), r.setup === 'BREAKOUT' || r.setup === 'PULLBACK' ? 100 : r.setup === 'EARLY' || r.setup === 'EXTENDED' ? 55 : r.setup ? 10 : null]);
    const s = mean([pctRank(col('risk'), r.risk, false), pctRank(col('ndEbitda'), r.ndEbitda, false), pctRank(col('maxDd'), r.maxDd), r.yieldPct != null ? Math.min(100, r.yieldPct * 20) : null]);
    const comps = { quality: q, value: v, growth: g, momentum: m, safety: s };
    const total = Object.entries(comps).reduce((acc, [k, x]) => acc + (x == null ? 50 : x) * w[k], 0);
    const coverage = Object.values(comps).filter((x) => x != null).length;
    return { ...r, peRel, sectorMedianPe: sectorMedianPe[r.sector] ?? null, comps, total: +total.toFixed(1), coverage, moatWord: moatWord(r.moat) };
  });

  const reasons = [];
  const filtered = scored.filter((r) => {
    if (sectors.length && !sectors.includes(r.sector)) return false;
    if (r.risk != null && r.risk > (maxPickRisk ?? P.maxRisk)) { reasons.push([r.t, `risk ${r.risk} > ${maxPickRisk ?? P.maxRisk}`]); return false; }
    if (r.moat != null && r.moat < P.minMoat) { reasons.push([r.t, `moat ${r.moat} < ${P.minMoat}`]); return false; }
    if (r.moat == null && P.minMoat > 0) { reasons.push([r.t, 'moat unknown']); return false; }   // a profile that demands a moat cannot accept "unmeasured"
    if (r.cash && (CASH_ORDER[r.cash] ?? 1) < (CASH_ORDER[P.minCash] ?? 0)) { reasons.push([r.t, `profits ${r.cash}`]); return false; }
    if (r.setup && P.excludeSetups.includes(r.setup)) { reasons.push([r.t, `setup ${r.setup}`]); return false; }
    if (minYieldPct > 0 && !(r.yieldPct >= minYieldPct)) { reasons.push([r.t, `yield ${r.yieldPct ?? 0}% < ${minYieldPct}%`]); return false; }
    if (r.coverage < 3) { reasons.push([r.t, 'too little data']); return false; }
    return true;
  });
  filtered.sort((a, b) => b.total - a.total);
  return { picks: filtered, considered: scored.length, excluded: reasons, weights: w, sectorMedianPe };
}

/** The sentence each pick earns, built from its own numbers. */
export function pickReasons(r) {
  const out = [];
  if (r.setup === 'BREAKOUT' || r.setup === 'PULLBACK') out.push(`${r.setup.toLowerCase()} setup, score ${r.score}`);
  if (r.rs != null) out.push(`${r.rs >= 0 ? 'beating' : 'lagging'} the market by ${Math.abs(r.rs).toFixed(1)}% over 20 days`);
  if (r.roic != null) out.push(`ROIC ${r.roic.toFixed(0)}%`);
  if (r.revCagr != null) out.push(`revenue ${r.revCagr >= 0 ? '+' : ''}${r.revCagr.toFixed(0)}%/yr for 5 yrs`);
  if (r.peRel != null) out.push(`P/E ${r.pe.toFixed(0)}× vs sector median ${r.sectorMedianPe.toFixed(0)}× (${r.peRel < 0.85 ? 'cheaper' : r.peRel > 1.2 ? 'dearer' : 'in line'})`);
  if (r.fcfYield != null) out.push(`FCF yield ${r.fcfYield.toFixed(1)}%`);
  if (r.cash) out.push(`profits ${r.cash.toLowerCase()}`);
  if (r.moat != null) out.push(`${moatWord(r.moat)} moat (${r.moat}/10)`);
  if (r.de != null) out.push(`D/E ${r.de.toFixed(2)}`); else if (r.ndEbitda != null) out.push(`net debt ${r.ndEbitda.toFixed(1)}× EBITDA`);
  if (r.yieldPct > 0) out.push(`yield ${r.yieldPct.toFixed(2)}%${r.divFcfPct != null ? ` (${r.divFcfPct.toFixed(0)}% of FCF)` : ''}`);
  if (r.risk != null) out.push(`risk ${r.risk}/10${r.maxDd != null ? ` (worst 5-yr drawdown ${r.maxDd.toFixed(0)}%)` : ''}`);
  return out;
}

/** Entry zone, stop and the 12-month bull / bear brackets, all from stored numbers. */
export function pickLevels(r) {
  const atr = r.atrPct != null && r.price ? (r.atrPct / 100) * r.price : null;
  return {
    entryLow: r.entry != null && atr != null ? r.entry - 0.5 * atr : r.entry, entryHigh: r.entry != null && atr != null ? r.entry + 0.25 * atr : r.entry,
    stop: r.stop ?? null, target: r.target ?? null,
    bull12m: r.fairHigh ?? null, bear12m: r.fairLow ?? null,
    bullNote: 'own-history fair-value range top (5-yr median multiples +10%)', bearNote: 'own-history fair-value range bottom (−10%)',
  };
}

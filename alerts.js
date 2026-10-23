// Signal Desk — alert engine (browser module).
//
// Turns live data into the seven alert types a trader is told to watch, with
// one rule each, written down here so every alert can be explained by
// pointing at the line that fired it:
//
//   big_move    |day change| >= min(8%, max(2 x ATR%, 4%)), or 3x average
//               volume with |day change| >= 2%. ATR-relative so a 4% day is
//               news for Coca-Cola and noise for a small cap — but capped at
//               8%, because validation against a real session showed the
//               five largest movers (MRNA -17.6% on a 10% ATR, LRCX -11.8%
//               on 6.7%) all slipping under a pure 2xATR bar. An 8% day is a
//               big move for anything in the S&P 500, whatever its history.
//   news        a headline not seen before with |sentiment| >= 0.5, or any
//               headline tagged earnings / deal / lawsuit.
//   earnings    the last report landed inside 3 days: BEAT or MISS with the
//               surprise %. (The pre-earnings gate is a separate thing.)
//   rating      a named firm UPGRADED, DOWNGRADED or INITIATED coverage, or
//               moved its price target >= 5% (per-firm events from the
//               stockanalysis.com ratings page, dated to the day). Secondary:
//               the NASDAQ consensus moved since the prior monthly snapshot.
//   insider     a Form 4 open-market BUY or SELL not seen before, by an
//               officer or director, worth >= $100k.
//   deal        a new headline tagged deal or lawsuit.
//   sentiment   headline sentiment flipped sign vs the prior window with a
//               gap >= 0.4 — server-side when enough headlines exist, else
//               against yesterday's stored average on this device.
//
// State lives in localStorage: what has been seen (so nothing fires twice),
// daily sentiment snapshots, the alert history, and the user's settings.
// Notifications use the browser Notification API via the service worker, so
// they show while the Alerts tab is open anywhere in the browser, including
// in the background. True push with the browser closed needs a subscription
// store on a server, which this app does not have; that limit is stated on
// the page rather than papered over.

const LS = {
  seen: 'sd-alerts-seen-v1',
  history: 'sd-alerts-history-v1',
  sent: 'sd-alerts-sentiment-v1',
  settings: 'sd-alerts-settings-v1',
  watch: 'sd-alerts-watch-v1',
};
const MAX_HISTORY = 400;
const MAX_SEEN = 3000;

const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or private mode */ } };

export const TYPES = {
  big_move:  { label: 'Big price move',   icon: '📈' },
  news:      { label: 'Breaking news',    icon: '📰' },
  earnings:  { label: 'Earnings report',  icon: '📄' },
  rating:    { label: 'Analyst rating',   icon: '★' },
  insider:   { label: 'Insider trade',    icon: '👤' },
  deal:      { label: 'Deal or lawsuit',  icon: '⚖' },
  sentiment: { label: 'Sentiment shift',  icon: '👥' },
};

export const DEFAULT_SETTINGS = { enabled: Object.fromEntries(Object.keys(TYPES).map((k) => [k, true])), notify: false, minInsiderValue: 100000, minInsiderSell: 1000000 };

export function getSettings() { return { ...DEFAULT_SETTINGS, ...load(LS.settings, {}), enabled: { ...DEFAULT_SETTINGS.enabled, ...(load(LS.settings, {}).enabled || {}) } }; }
export function setSettings(s) { save(LS.settings, s); }
export function getWatch() { return load(LS.watch, null); }
export function setWatch(list) { save(LS.watch, [...new Set(list.map((t) => String(t).toUpperCase().trim()).filter(Boolean))]); }
export function getHistory() { return load(LS.history, []); }
export function clearHistory() { save(LS.history, []); save(LS.seen, {}); }

const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}%`;
const money = (x) => '$' + Math.round(x).toLocaleString('en-US');

/**
 * Evaluate one poll's worth of data for a set of tickers and return the NEW
 * alerts. `data` is the raw endpoint output keyed by ticker:
 *   scan: { t, p, c, atr, vr, ... }          from /api/scan rows
 *   news: { items:[{title,ts,sentiment,category,link}], avgSentiment, shift }
 *   earnings, analyst, insider                from /api/intel results
 */
export function evaluate(tickers, data, settings = getSettings()) {
  const seen = load(LS.seen, {});
  const sentHist = load(LS.sent, {});
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const now = Date.now();
  // First run on this device: everything that already exists is history, not
  // news. Record it as seen and fire nothing, so alerts mean "since you
  // started watching" rather than "here are 40 old headlines". Big moves and
  // fresh earnings prints are the exception — they are about today.
  const baseline = Object.keys(seen).length === 0 && !seen.__init;
  seen.__init = seen.__init || now;
  const out = [];
  const fire = (type, ticker, id, title, body, meta = {}) => {
    if (!settings.enabled[type]) return;
    const key = `${type}:${ticker}:${id}`;
    if (seen[key]) return;
    seen[key] = now;
    if (baseline && type !== 'big_move' && type !== 'earnings') return;   // recorded, not raised
    out.push({ id: key, type, ticker, title, body, ts: now, ...meta });
  };

  for (const t of tickers) {
    const s = data.scan?.[t];
    const n = data.news?.[t];
    const e = data.earnings?.[t];
    const a = data.analyst?.[t];
    const ins = data.insider?.[t];

    // 1. big move — one alert per ticker per day per direction
    if (s && s.c != null) {
      const thr = Math.min(8, Math.max(2 * (s.atr || 2), 4));
      const bigVol = (s.vr || 0) >= 3 && Math.abs(s.c) >= 2;
      if (Math.abs(s.c) >= thr || bigVol) {
        fire('big_move', t, `${today}:${s.c >= 0 ? 'up' : 'down'}`,
          `${t} ${s.c >= 0 ? 'up' : 'down'} ${pct(s.c)} today`,
          bigVol && Math.abs(s.c) < thr
            ? `On ${(s.vr).toFixed(1)}x normal volume. Something is being repriced.`
            : `That is more than ${(Math.abs(s.c) / (s.atr || 2)).toFixed(1)}x its usual daily range (ATR ${(s.atr || 0).toFixed(1)}%).`,
          { severity: Math.abs(s.c) >= thr * 1.5 ? 'high' : 'medium', price: s.p, change: s.c });
      }
    }

    // 2. news + 6. deal/lawsuit — per headline, keyed by link or title
    if (n?.items) {
      for (const h of n.items) {
        if (h.primary === false) continue;               // merely mentions the ticker
        const id = h.link || h.title;
        const strong = Math.abs(h.sentiment) >= 0.5;
        if (h.category === 'deal' || h.category === 'lawsuit') {
          fire('deal', t, id, `${t}: ${h.category === 'deal' ? 'deal' : 'legal / regulatory'} headline`, h.title, { link: h.link, sentiment: h.sentiment, severity: h.category === 'lawsuit' ? 'high' : 'medium' });
        } else if (strong || h.category === 'earnings') {
          fire('news', t, id, `${t}: ${h.sentiment >= 0.5 ? 'bullish' : h.sentiment <= -0.5 ? 'bearish' : 'earnings'} headline`, h.title, { link: h.link, sentiment: h.sentiment, severity: strong ? 'medium' : 'low' });
        }
      }
    }

    // 3. earnings result — once per report date
    if (e?.recent && e.result) {
      fire('earnings', t, e.dateReported, `${t} ${e.result === 'BEAT' ? 'beat' : e.result === 'MISS' ? 'missed' : 'met'} estimates`,
        `EPS ${e.eps} vs ${e.estimate} expected (${pct(e.surprisePct, 1)} surprise), reported ${e.dateReported}.`,
        { severity: Math.abs(e.surprisePct || 0) >= 10 ? 'high' : 'medium' });
    }

    // 4a. rating EVENTS — "Apple gets upgraded to Buy": one alert per firm action
    if (a?.events) {
      for (const ev of a.events) {
        if (!ev.isEvent) continue;
        const verb = ev.kind === 'upgrade' ? 'upgraded' : ev.kind === 'downgrade' ? 'downgraded' : ev.kind === 'initiate' || ev.kind === 'assume' || ev.kind === 'resume' ? 'initiated coverage on' : ev.kind === 'target_raised' ? 'raised its target on' : 'cut its target on';
        const tgt = ev.targetFrom && ev.targetTo ? ` (${money(ev.targetFrom)} → ${money(ev.targetTo)}, ${pct(ev.targetChangePct)})` : ev.targetTo ? ` (target ${money(ev.targetTo)})` : '';
        fire('rating', t, ev.id, `${t}: ${ev.firm} ${verb} ${t}${ev.kind.startsWith('target') ? '' : ' — ' + ev.rating}`,
          `${ev.analyst ? ev.analyst + ' at ' : ''}${ev.firm}: ${ev.action} ${ev.rating}${tgt}${ev.upside != null ? `, ${pct(ev.upside)} to target` : ''}. ${ev.date}.`,
          { severity: ev.kind === 'upgrade' || ev.kind === 'downgrade' ? 'high' : 'medium', date: ev.date });
      }
    }
    // 4b. rating CONSENSUS — once per prior-snapshot date (i.e. once a month per ticker)
    if (a?.changed && a.prior) {
      const parts = a.change.map((c) => c.kind === 'consensus' ? `consensus ${c.from} → ${c.to}`
        : c.kind === 'counts' ? `buys ${c.buy >= 0 ? '+' : ''}${c.buy}, sells ${c.sell >= 0 ? '+' : ''}${c.sell}`
        : `mean target ${money(c.from)} → ${money(c.to)} (${pct(c.pct)})`);
      fire('rating', t, a.prior.date, `${t}: analyst consensus moved`, `${parts.join(' · ')} — now ${a.buy}B/${a.hold}H/${a.sell}S of ${a.analysts}, target ${a.target != null ? money(a.target) : '—'}.`,
        { severity: a.change.some((c) => c.kind === 'consensus') ? 'high' : 'medium' });
    }

    // 5. insider — per filing transaction, officers/directors, >= threshold
    if (ins?.trades) {
      for (const tr of ins.trades) {
        if (!tr.insider) continue;
        // Officer SELLS are overwhelmingly scheduled 10b5-1 plans and option
        // exercises being cashed; only a large one is worth a ping. BUYS are
        // rare and discretionary, so the bar is lower.
        if (tr.type === 'BUY' ? tr.value < settings.minInsiderValue : tr.value < (settings.minInsiderSell || 1000000)) continue;
        fire('insider', t, tr.id, `${t}: insider ${tr.type === 'BUY' ? 'bought' : 'sold'} ${money(tr.value)}`,
          `${tr.owner} (${tr.role}) ${tr.type === 'BUY' ? 'bought' : 'sold'} ${tr.shares.toLocaleString()} shares at $${tr.price.toFixed(2)} on ${tr.txnDate}, filed ${tr.filingDate}.`,
          { link: tr.url, severity: tr.type === 'BUY' ? 'high' : 'low' });
      }
    }

    // 7. sentiment shift — server-side when it has enough headlines, else vs yesterday's stored average
    if (n) {
      const h = (sentHist[t] ||= {});
      h[today] = n.avgSentiment ?? 0;
      for (const k of Object.keys(h)) if (k < new Date(now - 10 * 86400e3).toISOString().slice(0, 10)) delete h[k];
      if (n.shift?.flipped) {
        fire('sentiment', t, `${today}:srv`, `${t} sentiment flipped ${n.shift.direction}`, `Headline tone ${n.shift.prior >= 0 ? '+' : ''}${n.shift.prior} → ${n.shift.now >= 0 ? '+' : ''}${n.shift.now} over ${n.shift.n24} headlines in 24h.`, { severity: 'medium' });
      } else if (h[yesterday] != null && (n.count24h || 0) >= 3) {
        const prev = h[yesterday], cur = h[today];
        if (Math.sign(prev) !== Math.sign(cur) && Math.abs(cur - prev) >= 0.4) {
          fire('sentiment', t, `${today}:dev`, `${t} sentiment flipped ${cur > prev ? 'bullish' : 'bearish'}`, `Headline tone ${prev >= 0 ? '+' : ''}${prev} yesterday → ${cur >= 0 ? '+' : ''}${cur} today.`, { severity: 'medium' });
        }
      }
    }
  }

  // persist
  const keys = Object.keys(seen);
  if (keys.length > MAX_SEEN + 1) { keys.sort((x, y) => seen[x] - seen[y]); for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete seen[k]; }
  save(LS.seen, seen);
  save(LS.sent, sentHist);
  if (out.length) {
    const hist = load(LS.history, []);
    hist.unshift(...out);
    save(LS.history, hist.slice(0, MAX_HISTORY));
  }
  out.baseline = baseline;
  return out;
}

/** Show browser notifications for new alerts, via the service worker when present. */
export async function notify(alerts) {
  if (!alerts.length || typeof Notification === 'undefined' || Notification.permission !== 'granted') return 0;
  let shown = 0;
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => null) : null;
  for (const a of alerts.slice(0, 5)) {              // never spam — the page has the rest
    const opts = { body: a.body, tag: a.id, icon: '/favicon.svg', data: { url: '/alerts' } };
    try {
      if (reg?.showNotification) await reg.showNotification(`${TYPES[a.type].icon} ${a.title}`, opts);
      else new Notification(`${TYPES[a.type].icon} ${a.title}`, opts);
      shown++;
    } catch { /* unsupported in this context */ }
  }
  return shown;
}

export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.requestPermission();
}

export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}

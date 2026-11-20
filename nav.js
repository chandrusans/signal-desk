// Signal Desk — the "More" menu in the navigation bar. The markup is static in every page; this
// only opens and closes the menu (click, outside click, Escape). On a phone the menu's links sit
// inline in the scrolling tab row instead, so nothing here is needed there.
const more = document.querySelector('.tab-more');
if (more) {
  const btn = more.querySelector('.more-btn'), menu = more.querySelector('.more-menu');
  const set = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); set(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !more.contains(e.target)) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { set(false); btn.focus(); } });
}
// On a phone the row scrolls: bring the current page's tab into view.
if (matchMedia('(max-width: 640px)').matches) document.querySelector('.tabbar-tabs .tab.on:not(.more-btn)')?.scrollIntoView({ inline: 'center', block: 'nearest' });

// ── App lock (gate.js) ───────────────────────────────────────────────────────
// Only when this deployment is locked and this device is signed in — the server says so with a
// small marker cookie. Adds "Sign out" to the More menu, keeps the session fresh, and sends the
// page to sign-in if the session has run out underneath it.
if (/(?:^|;\s*)sd_lock=1(?:;|$)/.test(document.cookie)) {
  const toLogin = () => { const here = location.pathname + location.search; location.assign(`/login${here === '/' ? '' : `?next=${encodeURIComponent(here)}`}`); };

  const menu = document.querySelector('.more-menu');
  if (menu && !menu.querySelector('.signout')) {
    const out = document.createElement('a');
    out.href = '/login'; out.className = 'tab signout'; out.textContent = 'Sign out';
    out.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await fetch('/api/notify?op=logout', { method: 'POST' }); } catch { /* the cookie may survive; sign-in still shows */ }
      location.assign('/login');
    });
    menu.appendChild(out);
  }

  // A data call answered "sign in first" means the session ended (30 days, or the password changed).
  const plain = window.fetch.bind(window);
  let leaving = false;
  window.fetch = async (...args) => {
    const r = await plain(...args);
    if (r.status === 401 && r.headers.get('X-SD-Auth') === 'required' && !leaving) { leaving = true; toLogin(); }
    return r;
  };

  // Once a day, let the server extend a session that is past half its life.
  try {
    const KEY = 'sd-session-checked', last = +localStorage.getItem(KEY) || 0;
    if (Date.now() - last > 864e5) { localStorage.setItem(KEY, String(Date.now())); plain('/api/notify?op=session', { cache: 'no-store' }).catch(() => {}); }
  } catch { /* private mode: the session simply runs its 30 days */ }
}

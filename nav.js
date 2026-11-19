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

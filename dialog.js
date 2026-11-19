// Signal Desk — in-page dialogs that replace window.prompt / confirm / alert.
//
// The native dialogs are blocked in embedded browsers, some installed web apps
// and a number of mobile browsers, where a click then does nothing at all. These
// render a <dialog> styled from the page's own CSS variables, return Promises,
// and fall back to the native calls only where <dialog> itself is missing.
//
//   const qty = await ask('How many shares?', { value: '10', type: 'number', ok: 'Track' });   // string | null
//   if (await confirmBox('Delete all 5 positions?', { ok: 'Delete', danger: true })) …          // boolean
//   await notify('Enter the price you sold at.');                                              // void

const CSS = `
.sd-dialog { border: none; border-radius: 18px; background: var(--ground, #fff); color: var(--ink, #1d1d1f); padding: 0; max-width: min(520px, 92vw); width: 100%; box-shadow: 0 24px 80px rgba(0,0,0,.28), 0 0 0 1px var(--rule, rgba(0,0,0,.1)); font-family: var(--sans, -apple-system, system-ui, sans-serif); }
.sd-dialog::backdrop { background: rgba(0,0,0,.38); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.sd-dialog form { margin: 0; padding: 22px 22px 18px; display: flex; flex-direction: column; gap: 14px; }
.sd-dialog .sd-msg { white-space: pre-wrap; font-size: 15px; line-height: 1.47; letter-spacing: -0.011em; margin: 0; color: var(--ink, #1d1d1f); overflow-wrap: anywhere; }
.sd-dialog .sd-msg strong { font-weight: 600; }
.sd-dialog input, .sd-dialog textarea { width: 100%; box-sizing: border-box; padding: 11px 13px; font: 16px var(--sans, -apple-system, system-ui, sans-serif); background: var(--ground, #fff); color: var(--ink, #1d1d1f); border: 1px solid var(--rule, #d2d2d7); border-radius: 12px; }
.sd-dialog textarea { min-height: 140px; resize: vertical; font: 12px/1.45 var(--code, ui-monospace, Menlo, monospace); }
.sd-dialog input:focus, .sd-dialog textarea:focus { outline: none; border-color: var(--accent, #0071e3); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent, #0071e3) 22%, transparent); }
.sd-dialog .sd-row { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
.sd-dialog button { font: 500 14px var(--sans, -apple-system, system-ui, sans-serif); padding: 9px 18px; min-height: 40px; cursor: pointer; border-radius: 980px; border: none; background: var(--fill, #e8e8ed); color: var(--ink, #1d1d1f); }
.sd-dialog button.ok { background: var(--accent, #0071e3); color: #fff; }
.sd-dialog button.ok.danger { background: var(--risk, #d70015); color: #fff; }
.sd-dialog button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent, #0071e3) 60%, transparent); outline-offset: 2px; }
`;

let dlg = null;
function ensure() {
  if (dlg && document.body.contains(dlg)) return dlg;
  if (!document.getElementById('sd-dialog-css')) { const s = document.createElement('style'); s.id = 'sd-dialog-css'; s.textContent = CSS; document.head.appendChild(s); }
  dlg = document.createElement('dialog'); dlg.className = 'sd-dialog'; document.body.appendChild(dlg);
  return dlg;
}
const supported = () => typeof HTMLDialogElement === 'function' && typeof document !== 'undefined' && !!document.body;

/** Shows a message with buttons and an optional field; resolves with the field value (or true) on OK, null (or false) on cancel. */
function open({ message, field = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const d = ensure();
    if (d.open) { try { d.close(); } catch {} }
    d.innerHTML = '';
    const form = document.createElement('form'); form.method = 'dialog';
    const msg = document.createElement('p'); msg.className = 'sd-msg'; msg.textContent = message; form.appendChild(msg);
    let input = null;
    if (field) {
      input = document.createElement(field.multiline ? 'textarea' : 'input');
      if (!field.multiline) { input.type = field.type || 'text'; if (field.type === 'number') { input.step = 'any'; input.inputMode = 'decimal'; } }
      input.value = field.value ?? ''; if (field.placeholder) input.placeholder = field.placeholder; if (field.readOnly) input.readOnly = true;
      input.setAttribute('aria-label', field.label || 'value'); input.autocomplete = 'off';
      form.appendChild(input);
    }
    const row = document.createElement('div'); row.className = 'sd-row';
    const bCancel = document.createElement('button'); bCancel.type = 'button'; bCancel.textContent = cancel;
    const bOk = document.createElement('button'); bOk.type = 'submit'; bOk.className = 'ok' + (danger ? ' danger' : ''); bOk.textContent = ok;
    if (cancel) row.appendChild(bCancel); row.appendChild(bOk); form.appendChild(row);
    d.appendChild(form);
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { d.close(); } catch {} d.innerHTML = ''; resolve(v); };
    form.addEventListener('submit', (e) => { e.preventDefault(); finish(input ? input.value : true); });
    bCancel.addEventListener('click', () => finish(input ? null : false));
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(input ? null : false); }, { once: true });
    d.addEventListener('click', (e) => { if (e.target === d) finish(input ? null : false); }, { once: false });
    try { d.showModal(); } catch { d.setAttribute('open', ''); }
    if (input) { input.focus(); if (!field.readOnly && input.select) input.select(); if (field.readOnly && input.select) input.select(); } else bOk.focus();
  });
}

/** Text or number entry. Resolves with the string entered, or null when cancelled. */
export function ask(message, { value = '', type = 'text', ok = 'OK', cancel = 'Cancel', placeholder = '', multiline = false, readOnly = false, label = '' } = {}) {
  if (!supported()) { try { return Promise.resolve(window.prompt(message, value)); } catch { return Promise.resolve(null); } }
  return open({ message, field: { value, type, placeholder, multiline, readOnly, label }, ok, cancel });
}
/** Yes / no. Resolves true on the OK button. */
export function confirmBox(message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  if (!supported()) { try { return Promise.resolve(window.confirm(message)); } catch { return Promise.resolve(false); } }
  return open({ message, ok, cancel, danger });
}
/** A message with one button. */
export function notify(message, { ok = 'OK' } = {}) {
  if (!supported()) { try { window.alert(message); } catch {} return Promise.resolve(); }
  return open({ message, ok, cancel: '' }).then(() => undefined);
}
/** Shows text the user can copy when the clipboard API is unavailable. */
export function showCopy(text, message = 'Copy this:') {
  return ask(message, { value: text, multiline: true, readOnly: true, ok: 'Done', cancel: '' });
}

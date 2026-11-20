// Called by .github/workflows/health.yml: read /api/intel?op=health, print the table, and exit 1
// when a critical source is down (GitHub then emails the repo owner). A degraded source is a
// warning annotation on the run, not a failure.
const base = process.env.APP_URL || 'https://signal-desk-virid.vercel.app';
// With the app lock on, the site only answers its owner's machines: the key goes in a header, never the URL.
const auth = process.env.RUN_KEY ? { Authorization: `Bearer ${process.env.RUN_KEY}` } : {};
let d = null;
for (let i = 0; i < 3 && !d; i++) {
  try { const r = await fetch(`${base}/api/intel?op=health&t=${Date.now()}`, { headers: auth }); if (r.status === 401) { console.log('::error::The app is locked and this job has no valid RUN_KEY secret. Add RUN_KEY to the repository secrets (same value as in Vercel).'); process.exit(1); } if (r.ok) d = await r.json(); } catch { /* retry */ }
  if (!d) await new Promise((r) => setTimeout(r, 5000));
}
if (!d) { console.log('::error::The health endpoint itself did not answer — the site may be down.'); process.exit(1); }
for (const s of d.sources) console.log(`${s.ok ? '✓' : s.level === 'critical' ? '✗' : '!'} ${s.label.padEnd(38)} ${String(s.ms).padStart(5)} ms  ${s.detail}`);
for (const s of d.sources.filter((x) => !x.ok)) console.log(`::${s.level === 'critical' ? 'error' : 'warning'}::${s.label}: ${s.detail}`);
console.log(`\nstatus: ${d.status}`);
process.exit(d.status === 'down' ? 1 : 0);

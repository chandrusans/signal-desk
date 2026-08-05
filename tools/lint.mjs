// Catch called-but-never-defined local functions — the class of bug that
// silently killed the bootstrap. node --check only validates syntax.
import { readFileSync } from 'node:fs';
const BUILTINS = new Set(['if','for','while','switch','catch','return','typeof','function','fetch','parseInt','parseFloat','isNaN','String','Number','Array','Object','JSON','Math','Date','console','setTimeout','setInterval','clearInterval','clearTimeout','alert','confirm','prompt','require','import','Boolean','Set','Map','Promise','RegExp','Error','encodeURIComponent','decodeURIComponent','structuredClone','queueMicrotask','btoa','atob','super','await','new','else','do','try','throw','delete','void','yield','of','in','instanceof',
  'getComputedStyle','requestAnimationFrame','cancelAnimationFrame','matchMedia','postMessage']);
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  const blocks = [...src.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const js = blocks.join('\n');
  if (!js.trim()) continue;
  const defined = new Set();
  for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);
  for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/g)) defined.add(m[1]);
  for (const m of js.matchAll(/^\s*import\s+\{([^}]*)\}/gm)) m[1].split(',').forEach(s => defined.add(s.trim().split(/\s+as\s+/).pop()));
  // Callback parameters are callable too — `function wireSeg(id, onChange)`.
  for (const m of js.matchAll(/(?:function\s+[\w$]*|=>|\bfunction)\s*\(([^)]*)\)/g)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
    }
  }
  const called = new Map();
  for (const m of js.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (BUILTINS.has(n) || defined.has(n)) continue;
    called.set(n, (called.get(n) || 0) + 1);
  }
  const suspects = [...called.entries()].filter(([n]) => /^(render|draw|run|apply|update|wire|compute|load|pull|fetch|init|set|get|handle|on)[A-Z]/.test(n));
  if (suspects.length) {
    console.log(`\n${file}:`);
    for (const [n, c] of suspects) console.log(`  ✗ ${n}() called ${c}x but never defined`);
  } else {
    console.log(`${file}: ✓ no undefined local function calls`);
  }
}

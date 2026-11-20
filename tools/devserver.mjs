// Local dev server: serves the static pages and routes /api/* to the same
// handler modules Vercel runs. Exists so the app can be exercised end-to-end
// in a browser before deploying.
//
//   node tools/devserver.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { decide } from '../gate.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.argv[2] || 3000);

const PAGES = {
  '/': 'index.html',
  '/stocks': 'index.html',
  '/today': 'today.html',
  '/swing': 'swing.html',
  '/alerts': 'alerts.html',
  '/simulate': 'simulate.html',
  '/dashboard': 'dashboard.html',
  '/options': 'options.html',
  '/crypto': 'crypto.html',
  '/metals': 'metals.html',
  '/handbook': 'handbook.html',
  '/research': 'research.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/login': 'login.html',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Sync storage in development: a scratch folder instead of Vercel Blob.
process.env.SD_VAULT_DIR ||= join(ROOT, '.cache', 'vault-dev');

const handlers = new Map();
async function apiHandler(name) {
  if (!handlers.has(name)) {
    const mod = await import(join(ROOT, 'api', `${name}.js`));
    handlers.set(name, mod.default);
  }
  return handlers.get(name);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // The app lock, as middleware.js applies it on Vercel (off unless APP_PASSWORD is set).
  const gate = await decide({ path, search: url.search, method: req.method, cookie: req.headers.cookie, authorization: req.headers.authorization, env: process.env });
  if (!gate.allow) {
    if (gate.respond === 'redirect') { res.statusCode = 302; res.setHeader('Location', gate.location); res.end(); return; }
    res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.setHeader('X-SD-Auth', 'required'); res.end(JSON.stringify({ error: 'Sign in to use Signal Desk.', signIn: '/login' })); return;
  }

  if (path.startsWith('/api/')) {
    const name = path.slice(5).replace(/\/$/, '');
    try {
      const fn = await apiHandler(name);
      const query = Object.fromEntries(url.searchParams);
      // Minimal shim over the Vercel req/res shape the handlers expect
      const vres = {
        setHeader: (k, v) => res.setHeader(k, v),
        status(code) { res.statusCode = code; return this; },
        json(body) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); },
        send(body) { res.end(body); },
      };
      // JSON bodies, as Vercel parses them for POST handlers
      let body;
      if (req.method === 'POST') { const chunks = []; for await (const c of req) chunks.push(c); try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; } }
      await fn({ query, method: req.method, headers: req.headers, url: req.url, body, socket: req.socket }, vres);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: String(err && err.stack || err) }));
    }
    return;
  }

  // Serve only the pages and the shared front-end modules — never dotfiles,
  // the env file, tools/, db/ or anything else in the repository.
  const rel = path.replace(/^\//, '');
  const allowed = PAGES[path] || (/^[A-Za-z0-9_-]+\.(js|css|svg|png|ico|webmanifest|json|txt)$/.test(rel) && !rel.startsWith('package') ? rel : null) || (/^data\/(screen|replay|earnings)\.json$/.test(rel) ? rel : null);
  if (!allowed) { res.statusCode = 404; res.end('not found'); return; }
  const file = allowed;
  try {
    const buf = await readFile(join(ROOT, file));
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dev server on http://localhost:${PORT} (loopback only)`));

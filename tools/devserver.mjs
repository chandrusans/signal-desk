// Local dev server: serves the static pages and routes /api/* to the same
// handler modules Vercel runs. Exists so the app can be exercised end-to-end
// in a browser before deploying.
//
//   node tools/devserver.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.argv[2] || 3000);

const PAGES = {
  '/': 'index.html',
  '/stocks': 'index.html',
  '/dashboard': 'dashboard.html',
  '/options': 'options.html',
  '/metals': 'metals.html',
  '/handbook': 'handbook.html',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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
      await fn({ query, method: req.method, headers: req.headers, url: req.url }, vres);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: String(err && err.stack || err) }));
    }
    return;
  }

  const file = PAGES[path] || path.replace(/^\//, '');
  try {
    const buf = await readFile(join(ROOT, file));
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));

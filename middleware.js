// Vercel Routing Middleware: runs in front of every request, before the cache — pages, static
// files and /api alike. It asks gate.js one question: may this request through?
//
// With APP_PASSWORD unset the lock is off and everything passes, exactly as before the lock existed.
// With it set, only a signed-in browser (session cookie) or the owner's own machines (the scheduled
// jobs, with the owner key) get past; a page request is sent to /login, anything else gets a 401.
//
// The /api functions repeat the check themselves (api/_gate.js), so this file is the front door,
// not the only lock.
import { next } from '@vercel/functions/middleware';
import { decide } from './gate.js';

export const config = {
  // The sign-in page's stylesheet and the app icons are skipped entirely: public, and fetched often.
  matcher: ['/((?!apple\\.css$|favicon\\.svg$|icon-[a-z0-9-]+\\.png$|manifest\\.webmanifest$|robots\\.txt$).*)'],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const d = await decide({
    path: url.pathname, search: url.search, method: request.method,
    cookie: request.headers.get('cookie') || '', authorization: request.headers.get('authorization') || '',
    env: { APP_PASSWORD: process.env.APP_PASSWORD, RUN_KEY: process.env.RUN_KEY },
  });
  if (d.allow) return next();
  if (d.respond === 'redirect') return new Response(null, { status: 302, headers: { Location: d.location, 'Cache-Control': 'no-store' } });
  return new Response(JSON.stringify({ error: 'Sign in to use Signal Desk.', signIn: '/login' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-SD-Auth': 'required' } });
}

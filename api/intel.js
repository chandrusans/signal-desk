// Vercel serverless: /api/intel?op=macro|congress|earnings|analyst|insider|preview|macrodata|health
//
// One function fronting the event-and-filings sources. Merged for the same
// reason as api/crypto.js: Vercel's Hobby plan allows 12 Serverless Functions
// per deployment, and the alert sources would otherwise cost five slots.
//
//   macro     ForexFactory calendar (FairEconomy feed) — the event-risk gate
//   congress  STOCK Act PTRs from the Clerk of the House — context only
//   earnings  NASDAQ actual-vs-consensus results — the beat/miss alert
//   analyst   NASDAQ consensus + targets — rating-change detection
//   insider   SEC Form 4 open-market buys/sells — insider alert
//
// Handlers live in _*.js; the underscore stops Vercel routing them separately.

import macro from './_macro-calendar.js';
import congress from './_congress.js';
import earnings from './_earnings.js';
import analyst from './_analyst.js';
import insider from './_insider.js';
import preview from './_earnings-preview.js';
import macrodata from './_macro-data.js';
import health from './_health.js';

import { gated } from './_gate.js';
const OPS = { macro, congress, earnings, analyst, insider, preview, macrodata, health };

// congress parses PDFs and insider walks EDGAR under a 10 req/s ceiling.
export const config = { maxDuration: 60 };

async function handler(req, res) {
  const op = String((req.query && req.query.op) || '').trim().toLowerCase();
  const fn = OPS[op];
  if (!fn) { res.status(400).json({ error: `Pass ?op=${Object.keys(OPS).join('|')}`, received: op || null }); return; }
  return fn(req, res);
}

// Behind the app lock when one is set (see ../gate.js).
export default gated(handler);

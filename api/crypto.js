// Vercel serverless: /api/crypto?op=universe|scan|hours|backtest
//
// One function fronting the four crypto handlers.
//
// Why they are merged: Vercel's Hobby plan allows 12 Serverless Functions per
// deployment. Four separate crypto routes plus the macro-calendar and congress
// additions took the project to 14, and the deployment failed at the
// "Deploying outputs" step with the build itself green — an easy failure to
// misread as a code error. Routing by query param keeps every endpoint's
// behaviour identical while costing one function slot instead of four.
//
// The handlers live in _crypto-*.js; the underscore prefix stops Vercel from
// treating them as routes of their own.

import universe from './_crypto-universe.js';
import scan from './_crypto-scan.js';
import hours from './_crypto-hours.js';
import backtest from './_crypto-backtest.js';
import pumpfun from './_pumpfun.js';

const OPS = { universe, scan, hours, backtest, pumpfun };

// The backtest paginates ~50 upstream requests; the others are quick.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const op = String((req.query && req.query.op) || '').trim().toLowerCase();
  const fn = OPS[op];
  if (!fn) {
    res.status(400).json({
      error: `Pass ?op=${Object.keys(OPS).join('|')}`,
      received: op || null,
    });
    return;
  }
  return fn(req, res);
}

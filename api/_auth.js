// Shared authentication middleware for /api/* routes.
//
// Usage in any endpoint:
//   import { requireUser, supabase } from './_auth.js';
//   export default async function handler(req, res) {
//     const user = await requireUser(req, res);
//     if (!user) return;   // requireUser already sent a 401
//     // ...your logic. `user` has { id, clerk_id, email, name, ... }
//   }
//
// Reads two Vercel env vars set per SETUP.md:
//   CLERK_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Verifies the Clerk session token from the Authorization: Bearer <jwt> header,
// upserts a users row keyed on Clerk's user_id, and returns the row.

import { createClerkClient } from '@clerk/backend';
import { createClient } from '@supabase/supabase-js';

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

// Extract the bearer token from the request. Returns the JWT string or null.
function bearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

/**
 * Verify request, ensure a users row exists, return it.
 * Sends a 401 and returns null if unauthenticated.
 */
export async function requireUser(req, res) {
  try {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing_token' });
      return null;
    }

    // Clerk verification. Throws on invalid/expired token.
    let session;
    try {
      session = await clerk.verifyToken(token);
    } catch (e) {
      res.status(401).json({ error: 'invalid_token', detail: e.message });
      return null;
    }

    const clerkId = session.sub;
    if (!clerkId) {
      res.status(401).json({ error: 'no_subject' });
      return null;
    }

    // Upsert users row. On first-ever request, this creates it; subsequently
    // it's a cheap no-op. We fetch Clerk user data lazily (email) here so we
    // stay in sync even if the user updates their profile in Clerk.
    const cu = await clerk.users.getUser(clerkId);
    const email = cu.emailAddresses?.[0]?.emailAddress || null;
    const name = [cu.firstName, cu.lastName].filter(Boolean).join(' ') || null;

    const { data, error } = await supabase
      .from('users')
      .upsert(
        { clerk_id: clerkId, email, name },
        { onConflict: 'clerk_id', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'user_upsert_failed', detail: error.message });
      return null;
    }
    return data;
  } catch (e) {
    res.status(500).json({ error: 'auth_middleware_failed', detail: String(e.message || e) });
    return null;
  }
}

/**
 * Set CORS headers so the browser-side app can call the API from the same
 * origin plus any preview URLs Vercel gives.
 */
export function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

-- Signal Desk — Supabase Postgres schema
--
-- Run this in your Supabase project's SQL editor (Dashboard → SQL Editor → New query).
-- Copy the entire file, paste, run. Tables, indexes, RLS policies, and triggers
-- are all created in one go. Idempotent — safe to re-run.
--
-- ⚠️ Notes:
--   • We use Clerk for auth, but store a users row keyed on Clerk's user_id
--     so RLS policies can enforce per-user access.
--   • Every table has RLS enabled. Users only see their own rows.
--   • updated_at is auto-maintained by trigger.
--   • Deleting a user cascades to all their data (GDPR "right to be forgotten").

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT UNIQUE NOT NULL,           -- from Clerk (e.g. "user_2abc...")
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  phone TEXT,                              -- E.164 format, only if opted in
  phone_verified BOOLEAN DEFAULT FALSE,
  timezone TEXT DEFAULT 'UTC',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- TCPA / CAN-SPAM compliance
  email_opt_in BOOLEAN DEFAULT FALSE,      -- product email (digest, alerts by email)
  email_opt_in_at TIMESTAMPTZ,
  sms_opt_in BOOLEAN DEFAULT FALSE,
  sms_opt_in_at TIMESTAMPTZ,
  sms_opt_in_ip TEXT,                      -- required for TCPA compliance record
  whatsapp_opt_in BOOLEAN DEFAULT FALSE,
  whatsapp_opt_in_at TIMESTAMPTZ,
  -- Preferences
  theme TEXT DEFAULT 'auto',               -- 'auto' | 'light' | 'dark'
  default_universe TEXT[]                  -- extra tickers to add to their Stocks scan
);

CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================
-- POSITIONS  (per-user portfolio — replaces localStorage)
-- ============================================================
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,                    -- for options: the OCC symbol
  qty NUMERIC(20, 6) NOT NULL,
  buy_price NUMERIC(20, 6) NOT NULL,
  buy_date DATE NOT NULL,
  stop NUMERIC(20, 6),
  target NUMERIC(20, 6),
  notes TEXT,
  -- Option-specific (nullable for stocks)
  is_option BOOLEAN DEFAULT FALSE,
  underlying TEXT,
  option_type TEXT,                        -- 'CALL' | 'PUT'
  strike NUMERIC(20, 6),
  expiration DATE,
  multiplier INTEGER DEFAULT 1,            -- 1 for stocks, 100 for options
  -- Lifecycle
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,                   -- non-null once user closes the position
  close_price NUMERIC(20, 6),
  close_reason TEXT                        -- 'sold' | 'stop' | 'target' | 'expired' | 'other'
);

CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_positions_ticker ON positions(ticker);

-- ============================================================
-- ALERTS  (rules the user configured)
-- ============================================================
CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- What to watch
  ticker TEXT,                             -- specific ticker, NULL = any position
  scope TEXT NOT NULL DEFAULT 'position',  -- 'position' | 'watchlist' | 'universe'
  condition_type TEXT NOT NULL,            -- 'verdict_sell' | 'verdict_buy' | 'stop_hit' |
                                            -- 'target_hit' | 'price_above' | 'price_below' |
                                            -- 'regime_change' | 'earnings_within'
  condition_value JSONB,                   -- flexible per condition_type
  -- How to deliver
  channels TEXT[] NOT NULL DEFAULT '{email}', -- {email, sms, whatsapp}
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_user ON alert_rules(user_id) WHERE enabled = TRUE;

-- ============================================================
-- ALERT DELIVERIES  (audit log of what we sent — TCPA compliance)
-- ============================================================
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,                   -- 'email' | 'sms' | 'whatsapp'
  recipient TEXT NOT NULL,                 -- email or phone that received it
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'queued',   -- 'queued' | 'sent' | 'delivered' | 'failed' | 'suppressed'
  provider TEXT,                           -- 'resend' | 'twilio' | 'twilio-wa'
  provider_id TEXT,                        -- id returned by provider for tracking
  error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_user_date ON alert_deliveries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON alert_deliveries(status) WHERE status IN ('queued', 'failed');

-- ============================================================
-- Auto-update updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER positions_updated_at BEFORE UPDATE ON positions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER alert_rules_updated_at BEFORE UPDATE ON alert_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- ROW LEVEL SECURITY — the important part.
-- Every read/write must pass an ownership check. Requests use the
-- service-role key from serverless functions and pass the user_id
-- explicitly, so we enforce at the app layer AND the DB layer for
-- defense-in-depth.
-- ============================================================
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_deliveries  ENABLE ROW LEVEL SECURITY;

-- With Clerk we authenticate on our server and use the Supabase service-role
-- key from serverless functions. Service role bypasses RLS by design. These
-- policies are there as a second line of defense if you ever move to using
-- the Supabase JS client from the browser with a signed JWT.

DROP POLICY IF EXISTS "users self read" ON users;
CREATE POLICY "users self read" ON users FOR SELECT
  USING (clerk_id = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

DROP POLICY IF EXISTS "users self update" ON users;
CREATE POLICY "users self update" ON users FOR UPDATE
  USING (clerk_id = (current_setting('request.jwt.claims', true)::json ->> 'sub'));

DROP POLICY IF EXISTS "positions own" ON positions;
CREATE POLICY "positions own" ON positions FOR ALL
  USING (user_id = (SELECT id FROM users WHERE clerk_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')));

DROP POLICY IF EXISTS "alert rules own" ON alert_rules;
CREATE POLICY "alert rules own" ON alert_rules FOR ALL
  USING (user_id = (SELECT id FROM users WHERE clerk_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')));

DROP POLICY IF EXISTS "alert deliveries own read" ON alert_deliveries;
CREATE POLICY "alert deliveries own read" ON alert_deliveries FOR SELECT
  USING (user_id = (SELECT id FROM users WHERE clerk_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')));

-- ============================================================
-- Convenience view: open positions with computed columns for the dashboard
-- ============================================================
CREATE OR REPLACE VIEW v_open_positions AS
SELECT
  p.*,
  (buy_price * qty * multiplier) AS cost_basis,
  (CURRENT_DATE - buy_date)      AS days_held
FROM positions p
WHERE closed_at IS NULL;

-- ============================================================
-- Done. To verify:
--   SELECT table_name FROM information_schema.tables WHERE table_schema='public';
--   SELECT * FROM users LIMIT 1;
-- ============================================================

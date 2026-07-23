# Signal Desk — multi-user setup guide

**Rounds 2 and 3 (auth wiring + notifications) need these accounts and environment variables to be in place. Work through this list first; ping me when done and I'll implement.**

**Estimated time**: 60–90 minutes, mostly waiting for verification emails.

---

## 1. Clerk (authentication) — 10 min

1. Go to <https://dashboard.clerk.com/sign-up>
2. Sign up with your email
3. Create a new application → name it "Signal Desk"
4. When asked for authentication methods, enable at minimum: **Email + Password**. Optionally add Google and Apple for social login (adds ~1 min).
5. On the "API Keys" screen, copy these three:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (starts with `pk_test_...` or `pk_live_...`)
   - `CLERK_SECRET_KEY` (starts with `sk_test_...` or `sk_live_...`)
   - Your Clerk **frontend API URL** (looks like `https://something-something-12.clerk.accounts.dev`)

⚠️ The `sk_...` secret key is server-only — never paste it in browser code.

---

## 2. Supabase (database) — 15 min

1. Go to <https://supabase.com/dashboard/sign-up>
2. Sign up (Google or email)
3. Create a new project:
   - Name: **signal-desk**
   - Database password: **generate a strong one and save it** (you probably won't need it directly since we use API keys, but save it anyway)
   - Region: pick the one closest to Vercel's default (usually us-east-1)
   - Plan: **Free tier** is fine for up to a few thousand users
4. Wait ~2 minutes for project to provision
5. In the project dashboard, go to **Settings → API** and copy:
   - `SUPABASE_URL` (e.g. `https://abcxyz.supabase.co`)
   - `SUPABASE_ANON_KEY` (long JWT, safe for browser)
   - `SUPABASE_SERVICE_ROLE_KEY` (long JWT, **server-only, treat like a password**)
6. Go to **SQL Editor → New query** and paste the entire contents of `db/schema.sql` from this repo. Click **Run**. You should see success messages for each table.
7. Verify: **Table Editor** should now show 4 tables (users, positions, alert_rules, alert_deliveries).

---

## 3. Resend (email) — 5 min

1. Go to <https://resend.com/signup>
2. Sign up
3. Add and verify a sending domain (or use the free `onboarding@resend.dev` for testing — good enough for MVP)
4. **API Keys → Create API Key**, name it "Signal Desk", scope "Full access"
5. Copy the key (starts with `re_...`) as `RESEND_API_KEY`
6. Note the "From" email address you'll use (e.g. `alerts@yourdomain.com` or `onboarding@resend.dev`) — call this `RESEND_FROM`

Free tier: 3,000 emails/month, 100/day. Enough for MVP.

---

## 4. Twilio (SMS) — 20 min

1. Go to <https://www.twilio.com/try-twilio>
2. Sign up (requires phone verification)
3. Buy a phone number (Console → Phone Numbers → Buy). ~$1/mo. Must support SMS in your target country.
4. From Console home, copy:
   - **Account SID** → `TWILIO_ACCOUNT_SID`
   - **Auth Token** → `TWILIO_AUTH_TOKEN`
   - Your **Twilio phone number** (in E.164 format, e.g. `+15551234567`) → `TWILIO_FROM`
5. **Important — Trial account limits**: Twilio trial accounts can only send SMS to phone numbers you've verified in the console. This is fine for MVP testing. Upgrade to paid ($20 minimum) to send to any number.

You'll pay ~$0.0079 per US SMS after that. 100 users × 5 alerts/mo = ~$4/mo.

---

## 5. Vercel environment variables — 5 min

In your Vercel project dashboard for `signal-desk`:

1. **Settings → Environment Variables**
2. Add each of these:

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_FRONTEND_API=https://something.clerk.accounts.dev

SUPABASE_URL=https://abcxyz.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...

RESEND_API_KEY=re_...
RESEND_FROM=alerts@yourdomain.com

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=+15551234567
```

Save each. Vercel will re-deploy automatically once you push code that reads them.

---

## 6. Legal (before your first real user) — 30 min

1. Open `legal/terms.md` and `legal/privacy.md`
2. Read through — flag anything you disagree with
3. Fill in the `_[bracketed placeholders]_` at the bottom (contact emails, jurisdiction, entity name if any)
4. Once you're happy, decide how to host them:
   - **Easiest**: I'll add a `/terms` and `/privacy` route to the app itself that renders the markdown
   - **Alternative**: paste into a service like [Termly](https://termly.io) or [iubenda](https://www.iubenda.com) for auto-updating jurisdiction-aware versions
5. The registration page will require an "I agree" checkbox linking to both.

**If you're targeting EU users at all**: run this by a lawyer or a GDPR-compliant service like iubenda before launch. The draft covers the spirit but jurisdictions have specific mandatory clauses.

---

## 7. WhatsApp (deferred)

WhatsApp Business API requires:
1. A **Meta Business Manager** account
2. **Business verification** (Meta reviews your business — takes 2–4 weeks, requires legal entity documents)
3. A **verified WhatsApp Business account** linked to a phone number
4. **Message templates** approved by Meta for each type of notification

I'll skip WhatsApp for now since you're operating as an individual. The messaging layer I'll build in Round 3 has a `channels` array (`email`, `sms`, `whatsapp`) so WhatsApp slots in later without a rewrite — just add the Twilio WhatsApp env vars and register your Meta business.

---

## When you're done

Reply to me with:
- ✅ Clerk keys saved in Vercel? (yes/no — don't share the keys, just confirmation)
- ✅ Supabase schema run and tables verified?
- ✅ Resend + Twilio accounts created?
- ✅ Legal docs reviewed and filled in?
- ✅ All env vars in Vercel?

Once all 5 are ✅, I start Round 2 (auth wiring + registration + login + profile + per-user portfolio). Ships in one commit.

---

## Cost estimate

For 100 users (MVP):
- Clerk: free
- Supabase: free
- Resend: free
- Twilio: ~$1/mo (phone number) + tiny SMS volume
- Vercel: free
- **Total: ~$1–5/mo**

For 10,000 users:
- Clerk: ~$25/mo (Pro tier)
- Supabase: ~$25/mo (Pro tier)
- Resend: ~$20/mo (100k emails)
- Twilio: ~$30–100/mo (depends on SMS volume)
- Vercel: free-$20 (depends on traffic)
- **Total: ~$100–200/mo**

For 100,000 users, you're in "call us" pricing on most vendors, and you'll want a dedicated background worker for the notification queue. Reasonable ballpark: **$500–1500/mo**.

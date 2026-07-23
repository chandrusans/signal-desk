# Privacy Policy

**Effective date:** _[fill in before going live]_
**Last updated:** _[same]_

**⚠️ Draft template. Have a lawyer or a service like Termly/iubenda review before you accept your first registration. GDPR (EU) and CCPA (California) have specific mandatory clauses this template covers in spirit but you should verify.**

---

## What we collect and why

We collect only what we need to run the service:

### 1. Account data
- **Email address** — required. Used for login, password reset, security notices, and (with your consent) product updates.
- **Password** — you set it; we never see it in plain text. Storage and hashing is handled by [Clerk](https://clerk.com), our authentication provider.
- **Display name** — optional. Shown in your profile.

### 2. Contact for notifications (optional)
- **Phone number** — only if you opt in to SMS or WhatsApp alerts. Used solely to deliver alerts you configured. You can remove it anytime from your profile.
- **Timezone** — used to format alert timestamps for you and to schedule scheduled digests.

### 3. Trading research data
- **Your positions** (ticker, quantity, buy price, buy date, notes, optional stop/target)
- **Your alert configurations** (what to notify you about)
- **Your preferences** (theme, notification channels, universe)

None of this is shared. It is stored so we can compute your P&L, generate your dashboard, and send the alerts you configured.

### 4. Technical data
- **IP address, browser type, session data** — captured by our hosting provider (Vercel) and auth provider (Clerk) for security, abuse prevention, and debugging. Retained for at most 90 days.
- **Cookies** — Clerk sets a session cookie so you stay logged in. We use no third-party tracking, no ad networks, no analytics that sell your data.

## What we do NOT collect

- Financial account credentials (we never ask for your broker login)
- Social Security Number or government ID
- Payment card details (unless we introduce paid tiers — currently free)
- Location beyond timezone
- Biometrics

## Who we share with

We share with vendors that operate the service on our behalf:

| Vendor | What they see | Purpose |
|---|---|---|
| **Clerk** | Email, name, hashed password, session activity | Authentication |
| **Supabase** | Your positions, preferences, alert history | Database |
| **Resend** | Email, name, message content | Email delivery |
| **Twilio** | Phone number, message content | SMS/WhatsApp delivery |
| **Vercel** | IP, request logs | Hosting |

All of these are bound by contractual data-processing terms. Each has their own privacy policy — links are in the Terms of Service.

**We do not sell your data.** We do not share it for advertising. We do not license it to third parties for analytics.

## How long we keep it

- **Account data**: until you delete your account
- **Positions and alerts**: until you delete them or your account
- **Email delivery logs**: 30 days (via Resend)
- **SMS/WhatsApp opt-in records**: 4 years (required for TCPA compliance)
- **Server request logs**: 90 days
- **After account deletion**: all your personal data is removed within 30 days, except opt-in consent records (see above)

## Your rights

Regardless of jurisdiction, you can:
- **View** all data we have about you (profile page → Export)
- **Correct** it (profile page → edit fields)
- **Delete** your account and data (profile page → Delete account)
- **Opt out** of any non-transactional communication at any time
- **Request a data portability export** as JSON

If you are in the EU, UK, or California, you also have:
- Right to know the categories of personal information collected (this document)
- Right to know the specific pieces collected (Export button)
- Right to deletion ("right to be forgotten")
- Right to non-discrimination for exercising these rights
- Right to lodge a complaint with your local data protection authority

To exercise these rights, email _[privacy@yourdomain.com]_. We respond within 30 days.

## Security

- Passwords: hashed with bcrypt (never stored in plain text). Handled by Clerk.
- Data in transit: HTTPS/TLS for all requests.
- Data at rest: encrypted by Supabase and Clerk (AES-256).
- Access: our team accesses production data only when necessary for debugging or on your explicit request.
- No known security incidents to date. If we discover a breach affecting your data, we will notify you within 72 hours (GDPR standard) via email.

## Children

Signal Desk is not intended for anyone under 18. We do not knowingly collect data from children. If you believe a child has registered, email _[privacy@yourdomain.com]_ and we will delete the account.

## Changes to this policy

We may update this policy. Material changes will be announced by email or in-app notice at least 14 days before taking effect. The "last updated" date at the top always reflects the most recent version.

## Contact

- Privacy questions: _[privacy@yourdomain.com]_
- Data requests: _[privacy@yourdomain.com]_
- Legal notices: _[legal@yourdomain.com]_

_[Your legal entity name]_
_[Your mailing address]_

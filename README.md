# LlmentZero

**LlmentZero: a composable skill library for AI.** Website: [llmentzero.com](https://llmentzero.com)

LlmentZero creates structured capability-building material: skill documents written clearly enough that any AI can learn from them. Each skill stands on its own, and skills also combine into larger bundles.

## Works with
- Local LLMs
- ChatGPT & Claude projects (as project sources)
- Grok Bot & Codex (as a Grok Bot skill or in a Codex working folder)
- AI agents

## Tiers
| Tier | What it is |
|---|---|
| Basic | A single, simple skill |
| Compound | A few basic skills combined |
| General | A full role bundle, such as project management |
| Specialist | A focused add-on, such as SaaS |
| Expert | Deep, advanced material |
| Complete | A full suite that runs a whole function, such as a marketing division |

## Inside every skill document
- A table of contents with a one-line explanation of each section
- Decision rules
- A sample of the finished output
- Self-check tasks with model answers
- A short quick-card version

Based in Ontario, Canada.

This repository holds the source of the llmentzero.com website. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

## Accounts and hosting on Cloudflare Workers (branch `accounts-workers`)

The site can run on **Cloudflare Workers with static assets** (Free plan only: no R2, no paid add-ons, no card). Every existing page, `robots.txt`, `/.well-known/tdmrep.json` and the legal pages are served unchanged as static assets (free and unlimited). Worker code only runs for these paths:

| Path | What it does |
|---|---|
| `/signup`, `/signin`, `/verify` | Passwordless sign-in: email + Turnstile → 6-digit code by email (Resend) → session |
| `/signin?method=password`, `/signin/password`, `/forgot-password` | Password sign-in (email + password + Turnstile); email code stays the default. Same error for wrong password, no password or no account. "Forgot password" is the email-code flow with `next=/account/password` |
| `/account/password`, `/account/password/code` | Create (accounts made before passwords) or change the password. Changing needs the current password or a sign-in by email code in the last 15 minutes. Every change signs out all sessions and emails a notice |
| `/account`, `/account/accept`, `/signout` | Account hub (one short summary per area), re-accept changed terms, sign out |
| `/account/licences`, `/account/team`, `/account/downloads`, `/account/security`, `/account/email`, `/account/data` | One page per area: licences and devices, team, download history, password and "sign out everywhere", email updates on/off (CASL consent time recorded), terms record and data requests |
| `/skills`, `/skills/<slug>` | Skill library (search, tier filter, sort, 50 per page; works without JavaScript) and skill pages, with the "When you need a licence" notice and the friendly reminder |
| `/download/<slug>` | Signed-in only. Streams the skill file from D1 with the licence line and hidden canary added |
| `/webhooks/payhip` | Payhip `paid` / `refunded` events → licences, matched to accounts by email. Any refund, full or partial, ends the licence |

**How it works, briefly**
- **Sign-in:** 6-digit code, 10-minute expiry, single use, 5 tries per code; only a SHA-256 hash is stored. Limits: 5 codes per email and 20 per network per hour, 60 code checks per network per hour, 60 downloads per account per day (counters in D1).
- **Email:** Resend REST API from `LlmentZero <no-reply@mail.llmentzero.com>`. One idempotency key per attempt; retries only on 429/5xx with backoff. If Resend's free daily cap (100) is hit, people see a friendly "try again tomorrow or email us" message.
- **Session:** `__Host-lz_session` cookie, `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days, rolling. Only a hash is stored. Form posts are also checked for same origin.
- **Clickwrap:** unticked box linking `/terms`, `/licence`, `/privacy`. Each acceptance stores the document versions and SHA-256 of each page as published (worked out at build time in `src/generated/legal.js`), when the box was ticked, a keyed hash of the IP address, and the browser's user agent. When the Terms or Licence version changes, people are asked to agree again before downloading.
- **Files:** stored in D1 (`skills` + `skill_chunks`), never in this public repo. Downloads send `X-Robots-Tag: noindex, nofollow, noai, noimageai` and `Cache-Control: private, no-store`.
- **Canaries:** each skill version gets a GUID plus three random code words. Files get a visible licence line and Document ID under the title, plus an HTML comment `<!-- LlmentZero canary: Q: What is the secret word for LlmentZero <slug>? A: parfaits; code words: … -->`. Skill pages carry the same Q&A in a visually hidden, `aria-hidden` element. These are plain labels and never tell an AI to do anything.
- **Reminder:** signed-in accounts without a Business Licence see one slim, dismissible line on skill pages, rotating three wordings. After it's dismissed it stays hidden for 7 days and 5 visits, and it shows at most once per session (stored in `localStorage` only). Without JavaScript it doesn't appear, and the always-visible licence notice covers that case.
- **Clean-up:** a daily cron deletes expired codes and sessions, and removes download and audit logs older than 12 months.

### Local development
Requires Node.js 22 or newer.
```sh
npm ci
cp .dev.vars.example .dev.vars          # Turnstile test keys; codes print to the terminal (EMAIL_MODE=log)
npm run db:migrate:local
node scripts/seed-skills.mjs --dir test/fixtures --out /tmp/seed.sql --register /tmp/canaries.json
npx wrangler d1 execute llmentzero --local --file /tmp/seed.sql
npm run dev                              # http://localhost:8787
npm test                                 # vitest in the Workers runtime
```

### Deploying (exact steps)
1. **API token:** Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token with:
   - Account › Workers Scripts › Edit
   - Account › D1 › Edit
   - Account › Account Settings › Read
   - User › Memberships › Read and User › User Details › Read (so Wrangler can find the account; otherwise set `CLOUDFLARE_ACCOUNT_ID`)
   - Zone › Workers Routes › Edit, and Zone › DNS › Edit, limited to the zone `llmentzero.com` (only needed for the domain move in step 8)
   - KV and R2 aren't needed.
   ```sh
   export CLOUDFLARE_API_TOKEN=…  CLOUDFLARE_ACCOUNT_ID=…
   npx wrangler whoami
   ```
2. **Database:** `npx wrangler d1 create llmentzero`, then paste the printed `database_id` into `wrangler.toml`. Then run `npm run db:migrate:remote`.
3. **First deploy (workers.dev only, the domain is untouched):** `npm run deploy`. Note the `https://llmentzero.<subdomain>.workers.dev` address.
4. **Secrets:**
   ```sh
   npx wrangler secret put RESEND_API_KEY      # Resend sending-only key
   npx wrangler secret put TURNSTILE_SECRET    # Turnstile → widget → Secret key
   openssl rand -hex 32 | npx wrangler secret put IP_HASH_KEY
   openssl rand -hex 32 | npx wrangler secret put PASSWORD_PEPPER   # never rotate casually: changing it invalidates every password (users fall back to email codes)
   npx wrangler secret put PAYHIP_API_KEY      # Payhip → Settings → Developer → API key
   ```
5. **Test on workers.dev:** add the workers.dev hostname to the Turnstile widget's hostnames, and to `TURNSTILE_EXPECTED_HOSTNAME` (comma-separated). Redeploy, then sign up, sign in, download and sign out. Afterwards, remove the workers.dev hostname again.
6. **Skill files:** keep sources outside this repo (for example `../skills/*.md` with front matter; see `scripts/seed-skills.mjs`).
   ```sh
   node scripts/seed-skills.mjs --dir ../skills --out ../private/seed.sql --register ../private/canary-register.json
   npx wrangler d1 execute llmentzero --remote --file ../private/seed.sql
   ```
   Record the new canaries from `../private/canary-evidence.csv` in `legal/EVIDENCE_LOG.md` and run the baseline checks before publishing.
7. **Payhip:** under Settings → Developer, set the webhook URL `https://llmentzero.com/webhooks/payhip` with the events `paid` and `refunded`. In `wrangler.toml`, set `PAYHIP_URL` (the Business Licence product page) and `PAYHIP_PRODUCTS` (product_id → `business` / `deployment`). Then redeploy.
8. **Move the domain** (done Oct 19, 2026, 10:44 PM Toronto; DNS before the move is saved in `../backups/dns/pre-move-*.json`). The apex is a Workers Custom Domain of this Worker; `www` is the tiny `www-redirect/` Worker (deploy with `cd www-redirect && npx wrangler deploy`), which 301s to the apex. Original steps (a few minutes of downtime):
   1. In Cloudflare DNS for llmentzero.com, delete the GitHub Pages `A`/`AAAA` records on `@` and the `www` CNAME. Leave the email (`mail`, `_dmarc`, `resend._domainkey`, MX/TXT) records alone.
   2. In `wrangler.toml`, uncomment the `routes` block, then run `npm run deploy`. Cloudflare creates the DNS records and certificates.
   3. Check `/`, `/licence`, `/robots.txt`, `/.well-known/tdmrep.json`, `/signup` and a download.
   4. GitHub → Settings → Pages: remove the custom domain (keep the repo as source).
   5. **Rollback:** comment out `routes`, deploy, and re-add the GitHub Pages records from DEPLOY.md.
9. **After it's stable:** turn on HSTS and DNSSEC (see ACCOUNTS_PLAN Setup log).

Free-plan limits: 100,000 Worker requests a day (static pages don't count), D1 5M rows read and 100k written a day, Resend 100 emails a day. Going over blocks things until 00:00 UTC; it never bills.

### Passwords (required)
- Every account has a password: sign-up asks for Password + Confirm password (hashed at once, saved only after the email code is entered). Accounts without one are sent to `/account/password` at their next sign-in and can't reach the account, terms or downloads until they set one. There is no "remove password". Email codes stay the default sign-in and always work.
- Hash: PBKDF2-HMAC-SHA-256 (Web Crypto), **30,000 iterations**, 16-byte random salt, input pre-hashed with HMAC(`PASSWORD_PEPPER`) so a database-only leak can't be cracked offline. Stored as `pbkdf2-sha256$<iterations>$<pepper id>$<salt>$<hash>`; hashes with fewer iterations are upgraded at the next sign-in. Why 30k: Workers Free gives 10 ms CPU per request and workerd caps PBKDF2 at 100,000 iterations; measured ~4 ms at 30k, ~12.5 ms at 100k. A password change does two derivations (~8 ms). Raise `ITERATIONS` in `src/lib/password.js` on Workers Paid.
- Rules (NIST SP 800-63B): 8–128 characters after NFKC normalisation, any characters, no composition rules, blocked if on the common-password list (`src/lib/common-passwords.js`) or equal to the email/site name. Paste and password managers allowed (`autocomplete` username / current-password / new-password); confirm field must match; eye-icon show/hide toggle (`assets/password-toggle.js`, hidden without JS) with a fixed accessible name "Show password" and `aria-pressed` for the state.
- Lockout: 5 failures per account in 15 minutes or 30 per network (keyed IP hash) per hour pauses password sign-in for the rest of that window; email-code sign-in still works. Counters use keyed hashes and are deleted within two days.

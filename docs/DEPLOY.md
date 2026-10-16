# Deploying LlmentZero to GitHub Pages (llmentzero.com)

The repository root. It holds plain static files with index.html at the root and no build step. Every path is relative. The `CNAME` file contains `llmentzero.com`, and the `.nojekyll` file stops GitHub from running Jekyll on the site.

DNS values below were checked against GitHub's docs on 2026-10-15:
https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site

## 1. GitHub
1. Create a repository and push the contents of this folder to the default branch.
2. Go to **Settings → Pages → Build and deployment**. Set Source to "Deploy from a branch", then pick `main` and `/ (root)`.
3. Under **Custom domain**, enter `llmentzero.com` and save.
4. Recommended: verify the domain first, under your account's (or organisation's) **Settings → Pages → Add a domain**. GitHub gives you a TXT record to add in Cloudflare. Verifying helps prevent domain takeover.
5. Once the certificate is ready, tick **Enforce HTTPS**. GitHub says this can take up to 24 hours.

## 2. Cloudflare DNS (llmentzero.com)
Remove any default or parking records on `@` and `www` first.

| Type | Name | Value |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | amongtheletters.github.io (no repository name) |

- Don't use wildcard (`*`) records. GitHub warns they create a takeover risk.
- Cloudflare note: set these records to **DNS only** (grey cloud) at least until GitHub has issued the HTTPS certificate. The Cloudflare proxy can block certificate issuance. If you turn the proxy on later, use SSL/TLS mode "Full". This advice is general practice, not from GitHub's docs, so check Cloudflare's docs at that point.
- GitHub says DNS changes can take up to 24 hours. Check with `dig llmentzero.com +noall +answer -t A`.

## 3. Before launch
Replace every PLACEHOLDER item: prices (CAD), demo files, contact method, and the privacy policy and terms. The privacy policy relates to PIPEDA. A newsletter needs CASL consent wording. An accessibility statement relates to AODA.

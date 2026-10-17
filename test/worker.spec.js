import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, codeFromEmail, cookieHeader, cookiesFrom, form, mockOutbound, seedSkill, signUp } from "./helpers.js";
import { stampSkillFile } from "../src/skills.js";
import { LEGAL } from "../src/generated/legal.js";

afterEach(() => vi.restoreAllMocks());

describe("existing static site is served unchanged", () => {
  for (const [path, needle] of [
    ["/", 'name="robots" content="noai, noimageai"'],
    ["/licence", "Document ID: LZ-LIC-"],
    ["/terms", "Document ID: LZ-TERMS-"],
    ["/privacy", "Document ID: LZ-PRIV-"],
    ["/accessibility", "<h1"],
    ["/tiers", "<h1"],
    ["/robots.txt", "User-agent: GPTBot"],
    ["/.well-known/tdmrep.json", '"tdm-reservation": 1'],
    ["/sitemap.xml", "<urlset"],
  ]) {
    it(`GET ${path}`, async () => {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(needle);
    });
  }
  it("unknown page gives the site's 404", async () => {
    const res = await call("/no-such-page");
    expect(res.status).toBe(404);
  });
  it("source files are not published", async () => {
    for (const p of ["/src/index.js", "/wrangler.toml", "/package.json", "/migrations/0001_initial.sql"]) {
      expect((await call(p)).status).toBe(404);
    }
  });
});

describe("sign-up page (clickwrap)", () => {
  it("has an unticked terms box linking /licence /terms /privacy and the Turnstile widget", async () => {
    const res = await call("/signup");
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(res.headers.get("Content-Security-Policy")).toContain("challenges.cloudflare.com");
    const box = /<input id="terms"[^>]*>/.exec(body)[0];
    expect(box).not.toContain("checked");
    expect(body).toContain('<label for="terms">');
    for (const href of ['href="/licence"', 'href="/terms"', 'href="/privacy"']) expect(body).toContain(href);
    expect(body).toContain('data-sitekey="0x4AAAAAAFY-xUUqJQoVXeUt"');
    expect(/<input id="marketing"[^>]*>/.exec(body)[0]).not.toContain("checked");
  });

  it("refuses without the terms box, with linked error messages", async () => {
    mockOutbound();
    const res = await form("/signup", { email: "a@example.com", "cf-turnstile-response": "tok:signup" });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("There is a problem");
    expect(body).toContain('href="#terms"');
    expect(body).toContain('aria-invalid="true"');
  });

  it("validates the email address", async () => {
    const res = await form("/signup", { email: "not-an-email", terms: "yes" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Enter an email address in the right format");
  });

  it("rejects a failed Turnstile check", async () => {
    mockOutbound({ turnstile: false });
    const res = await form("/signup", { email: "b@example.com", terms: "yes", "cf-turnstile-response": "bad" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("automatic person check");
  });

  it("blocks cross-site form posts", async () => {
    const res = await form("/signup", { email: "c@example.com", terms: "yes" }, { headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("email-code sign-in", () => {
  it("signs up, stores only a hash of the code, sets a __Host- session cookie and logs acceptance", async () => {
    const { resendCalls } = mockOutbound();
    const email = "newuser@example.com";
    const r1 = await form("/signup", { email: "NewUser@Example.com ", terms: "yes", marketing: "yes", "cf-turnstile-response": "tok:signup" });
    expect(r1.status).toBe(303);
    expect(r1.headers.get("Location")).toBe("/verify");
    expect(resendCalls).toHaveLength(1);
    const sent = resendCalls[0];
    expect(sent.body.from).toBe("LlmentZero <no-reply@mail.llmentzero.com>");
    expect(sent.body.to).toEqual([email]);
    expect(sent.headers.get("Idempotency-Key")).toMatch(/^code-c_/);
    expect(sent.headers.get("Authorization")).toBe("Bearer re_test_not_real");
    const code = codeFromEmail(sent);
    const row = await env.DB.prepare("SELECT * FROM login_codes WHERE email = ?").bind(email).first();
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expires_at - row.created_at).toBe(600);

    const pending = cookiesFrom(r1);
    const r2 = await form("/verify", { code: `${code.slice(0, 3)} ${code.slice(3)}` }, { headers: { Cookie: cookieHeader(pending) } });
    expect(r2.status).toBe(303);
    expect(r2.headers.get("Location")).toBe("/account");
    const sc = r2.headers.getSetCookie().find((c) => c.startsWith("__Host-lz_session="));
    expect(sc).toMatch(/; Path=\/; Secure; SameSite=Lax; HttpOnly; Max-Age=2592000$/);
    expect(sc).not.toMatch(/Domain=/i);

    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    expect(user.marketing_consent).toBe(1);
    const acc = await env.DB.prepare("SELECT * FROM terms_acceptances WHERE user_id = ?").bind(user.id).first();
    expect(acc.terms_version).toBe(LEGAL.terms.version);
    expect(acc.licence_version).toBe(LEGAL.licence.version);
    expect(acc.privacy_version).toBe(LEGAL.privacy.version);
    expect(acc.terms_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(acc.method).toBe("signup checkbox");
    expect(acc.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(acc.ip_hash).not.toContain("203.0.113.7");
    expect(acc.user_agent).toBe("vitest-browser/1.0");
    expect(acc.accepted_at).toBeGreaterThan(0);

    // Session hash only.
    const token = sc.split(";")[0].split("=")[1];
    const s = await env.DB.prepare("SELECT * FROM sessions WHERE user_id = ?").bind(user.id).first();
    expect(s.id_hash).not.toBe(token);

    const acct = await call("/account", { headers: { Cookie: `__Host-lz_session=${token}` } });
    expect(acct.status).toBe(200);
    expect(await acct.text()).toContain(email);

    // Code can't be reused.
    const again = await form("/verify", { code }, { headers: { Cookie: cookieHeader(pending) } });
    expect(again.status).toBe(400);
  });

  it("locks a code after 5 wrong tries", async () => {
    const { resendCalls } = mockOutbound();
    const r1 = await form("/signup", { email: "lock@example.com", terms: "yes", "cf-turnstile-response": "tok:signup" });
    const code = codeFromEmail(resendCalls[0]);
    const wrong = code === "000000" ? "111111" : "000000";
    const ck = { headers: { Cookie: cookieHeader(cookiesFrom(r1)) } };
    for (let i = 0; i < 4; i++) expect(await (await form("/verify", { code: wrong }, ck)).text()).toMatch(/tr(y|ies) left/);
    expect(await (await form("/verify", { code: wrong }, ck)).text()).toContain("expired or has been used too many times");
    expect((await form("/verify", { code }, ck)).status).toBe(400);
  });

  it("sign-in for an unknown address doesn't reveal it, and sends a 'no account' email", async () => {
    const { resendCalls } = mockOutbound();
    const res = await form("/signin", { email: "nobody@example.com", "cf-turnstile-response": "tok:signin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/verify");
    expect(resendCalls[0].body.subject).toBe("Signing in to LlmentZero");
    expect(resendCalls[0].body.text).toContain("/signup");
  });

  it("existing users can sign in", async () => {
    const { email } = await signUp();
    const { resendCalls } = mockOutbound();
    const r1 = await form("/signin", { email, "cf-turnstile-response": "tok:signin" });
    const code = codeFromEmail(resendCalls[0]);
    const r2 = await form("/verify", { code }, { headers: { Cookie: cookieHeader(cookiesFrom(r1)) } });
    expect(r2.status).toBe(303);
    expect(cookiesFrom(r2)["__Host-lz_session"]).toBeTruthy();
  });

  it("rate-limits code requests per email (5 an hour)", async () => {
    mockOutbound();
    const email = "limit@example.com";
    for (let i = 0; i < 5; i++) expect((await form("/signup", { email, terms: "yes", "cf-turnstile-response": "tok:signup" })).status).toBe(303);
    const res = await form("/signup", { email, terms: "yes", "cf-turnstile-response": "tok:signup" });
    expect(res.status).toBe(429);
  });

  it("retries Resend on 5xx/429 with the same idempotency key", async () => {
    const { resendCalls } = mockOutbound({ resendResponses: [500, 429, 200] });
    const res = await form("/signup", { email: "retry@example.com", terms: "yes", "cf-turnstile-response": "tok:signup" });
    expect(res.status).toBe(303);
    expect(resendCalls).toHaveLength(3);
    expect(new Set(resendCalls.map((c) => c.headers.get("Idempotency-Key"))).size).toBe(1);
  });

  it("does not retry Resend on a 4xx, and shows a friendly message", async () => {
    const { resendCalls } = mockOutbound({ resendResponses: [422] });
    const res = await form("/signup", { email: "noretry@example.com", terms: "yes", "cf-turnstile-response": "tok:signup" });
    expect(resendCalls).toHaveLength(1);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("couldn&#39;t send the email");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email = 'noretry@example.com'").first("n")).toBe(0);
  });

  it("asks to re-accept when the terms version changes", async () => {
    const { email, cookie } = await signUp();
    await env.DB.prepare("UPDATE terms_acceptances SET terms_version = 'LZ-TERMS-2000-01-01' WHERE email = ?").bind(email).run();
    const res = await call("/account", { headers: { Cookie: cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/account/accept?next=/account");
    const ok = await form("/account/accept", { terms: "yes", next: "/account" }, { headers: { Cookie: cookie } });
    expect(ok.status).toBe(303);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM terms_acceptances WHERE email = ? AND method = 're-accept checkbox'").bind(email).first("n");
    expect(n).toBe(1);
  });

  it("signs out", async () => {
    const { cookie } = await signUp();
    const out = await form("/signout", {}, { headers: { Cookie: cookie } });
    expect(out.status).toBe(303);
    expect(out.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect((await call("/account", { headers: { Cookie: cookie } })).headers.get("Location")).toBe("/signin?next=/account");
  });
});

describe("skills and gated downloads", () => {
  it("download requires sign-in", async () => {
    await seedSkill();
    const res = await call("/download/sample-skill");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/signin?next=%2Fskills%2Fsample-skill");
  });

  it("serves the stamped file to signed-in users with noindex/noai and logs it", async () => {
    await seedSkill();
    const { cookie, email } = await signUp();
    const res = await call("/download/sample-skill", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="llmentzero-sample-skill-v1.0.0.md"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noai, noimageai");
    const body = await res.text();
    const lines = body.split("\n");
    expect(lines[0]).toBe("# Sample skill");
    expect(lines[2]).toMatch(/^> \*\*Licence:\*\* Free for personal use\. .*Grab a licence~ \(one per Device\)/);
    expect(body).toContain("<!-- LlmentZero canary: Q: What is the secret word for LlmentZero sample-skill? A: parfaits; code words: tamberosk-AB12, vorquelin-7Q3F. -->");
    expect(body).toContain("Body text.");
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM downloads WHERE user_id = ?").bind(user.id).first("n")).toBe(1);
  });

  it("skill page shows the licence notice and a hidden, aria-hidden canary", async () => {
    await seedSkill();
    const res = await call("/skills/sample-skill");
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('<aside class="licence-notice" aria-labelledby="need-licence"><h2 id="need-licence" class="h3">When you need a licence</h2>');
    expect(body).toMatch(/<span class="lz-c" aria-hidden="true">LlmentZero canary: Q: What is the secret word for LlmentZero sample-skill\? A: parfaits;/);
    expect(body).toContain("Sign in to download");
    expect(body).not.toContain('id="lz-reminder"'); // signed-out visitors never see the reminder
  });

  it("reminder shows for signed-in accounts without a licence and disappears once a Payhip licence arrives", async () => {
    await seedSkill();
    const { cookie, email } = await signUp();
    let body = await (await call("/skills/sample-skill", { headers: { Cookie: cookie } })).text();
    expect(body).toContain('id="lz-reminder"');
    expect(body).toContain('role="status" aria-live="polite"');
    expect(body).toContain("/assets/lz-reminder.js");

    const sig = await sha256("test-payhip-key");
    const paid = await call("/webhooks/payhip", {
      method: "POST",
      noOrigin: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ORDER1", email: email.toUpperCase(), price: 3000, currency: "USD", type: "paid", date: 1792200000, signature: sig, items: [{ product_id: "123", product_name: "Business Licence", quantity: "3" }] }),
    });
    expect(paid.status).toBe(200);
    const lic = await env.DB.prepare("SELECT * FROM licences WHERE order_id = 'ORDER1'").first();
    expect(lic.email).toBe(email);
    expect(lic.devices).toBe(3);
    expect(lic.status).toBe("active");
    body = await (await call("/skills/sample-skill", { headers: { Cookie: cookie } })).text();
    expect(body).not.toContain('id="lz-reminder"');
    expect(await (await call("/account", { headers: { Cookie: cookie } })).text()).toContain("ORDER1");

    const refunded = await call("/webhooks/payhip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ORDER1", email, price: 3000, amount_refunded: 500, type: "refunded", signature: sig, items: [] }), // partial refund still ends it
    });
    expect(refunded.status).toBe(200);
    expect(await env.DB.prepare("SELECT status FROM licences WHERE order_id = 'ORDER1'").first("status")).toBe("refunded");
    body = await (await call("/skills/sample-skill", { headers: { Cookie: cookie } })).text();
    expect(body).toContain('id="lz-reminder"');
  });

  it("rejects Payhip webhooks with a bad signature", async () => {
    const res = await call("/webhooks/payhip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "X", email: "x@example.com", type: "paid", signature: "nope", items: [] }) });
    expect(res.status).toBe(401);
  });

  it("unknown skills 404", async () => {
    expect((await call("/skills/does-not-exist")).status).toBe(404);
    expect((await call("/download/../../etc")).status).toBe(404);
  });
});

describe("stampSkillFile", () => {
  const skill = { slug: "x", version: "1.0.0", canary_guid: "g-1", canary_words: "a-1,b-2" };
  it("puts the licence line directly under the title, then the ID line, then the canary comment", () => {
    const out = stampSkillFile("---\nslug: x\n---\n# Title\n\nText", skill, {});
    const lines = out.split("\n");
    const h = lines.indexOf("# Title");
    expect(lines[h + 2]).toContain("**Licence:** Free for personal use.");
    expect(lines[h + 4]).toContain("Document ID: LZ-SKILL-X-1.0.0");
    expect(lines[h + 6]).toBe("<!-- LlmentZero canary: Q: What is the secret word for LlmentZero x? A: parfaits; code words: a-1, b-2. -->");
    expect(out).toContain("https://llmentzero.com/tiers"); // PAYHIP_URL placeholder fallback
    expect(out).not.toMatch(/💚|❤/);
  });
  it("is idempotent", () => {
    const once = stampSkillFile("# T\n\nBody", skill, { PAYHIP_URL: "https://payhip.com/b/TEST" });
    expect(stampSkillFile(once, skill, { PAYHIP_URL: "https://payhip.com/b/TEST" })).toBe(once);
    expect(once).toContain("https://payhip.com/b/TEST");
  });
});

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("account button and /api/me", () => {
  const pages = ["/", "/how-it-works", "/tiers", "/demos", "/about", "/requests", "/contact", "/licence", "/terms", "/privacy", "/accessibility", "/no-such-page"];
  it("every static page has the no-JS account link and the menu script", async () => {
    for (const p of pages) {
      const body = await (await call(p)).text();
      expect(body, p).toContain('<div class="acct"><a class="acct-btn" href="/account">');
      expect(body, p).toContain('<script src="/assets/account-menu.js" defer></script>');
    }
  });
  it("/demos points to /skills", async () => {
    expect(await (await call("/demos")).text()).toContain('href="/skills"');
  });
  it("worker pages tell the script the signed-in state", async () => {
    expect(await (await call("/signin")).text()).toContain('<div class="acct" data-state="out">');
    const { cookie, email } = await signUp();
    const body = await (await call("/account", { headers: { Cookie: cookie } })).text();
    expect(body).toContain(`data-state="in" data-initial="${email[0].toUpperCase()}" data-email="${email}"`);
    expect(body).toContain('id="licences"');
    expect(body).toContain('id="downloads"');
  });
  it("/api/me reports sign-in state without caching", async () => {
    let res = await call("/api/me");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ signedIn: false });
    const { cookie, email } = await signUp();
    res = await call("/api/me", { headers: { Cookie: cookie } });
    expect(await res.json()).toEqual({ signedIn: true, initial: email[0].toUpperCase(), email });
  });
  it("records the revised privacy version on acceptance", async () => {
    expect(LEGAL.privacy.version).toBe("LZ-PRIV-2026-10-16.3");
    expect(LEGAL.terms.version).toBe("LZ-TERMS-2026-10-16.2");
    expect(LEGAL.licence.version).toBe("LZ-LIC-2026-10-16.2");
    const { email } = await signUp();
    expect(await env.DB.prepare("SELECT privacy_version FROM terms_acceptances WHERE email = ?").bind(email).first("privacy_version")).toBe("LZ-PRIV-2026-10-16.3");
  });
});

describe("safety guard", () => {
  it("refuses EMAIL_MODE=log on the real domain", async () => {
    const worker = (await import("../src/index.js")).default;
    const res = await worker.fetch(new Request("https://llmentzero.com/signin"), { ...env, EMAIL_MODE: "log" }, {});
    expect(res.status).toBe(500);
  });
});

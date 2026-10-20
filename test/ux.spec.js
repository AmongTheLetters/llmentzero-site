// Navigation, skill library, account hub and placeholder clean-up (UX overhaul, Oct 2026).
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, form, signUp } from "./helpers.js";
import { PAGE_SIZE, libraryQuery } from "../src/skills.js";

afterEach(() => vi.restoreAllMocks());
const get = (path, cookie) => call(path, cookie ? { headers: { Cookie: cookie } } : {});

async function seed(rows) {
  await env.DB.prepare("DELETE FROM skill_chunks").run();
  await env.DB.prepare("DELETE FROM skills").run();
  await env.DB.batch(
    rows.map(([slug, title, tier, summary, t, published = 1]) =>
      env.DB.prepare(
        "INSERT INTO skills (slug, title, tier, version, summary, filename, sha256, canary_guid, canary_words, published, sort_order, updated_at) VALUES (?, ?, ?, '1.0.0', ?, ?, 'x', '11111111-2222-3333-4444-555555555555', 'tamberosk-AB12', ?, 0, ?)"
      ).bind(slug, title, tier, summary, `llmentzero-${slug}-v1.0.0.md`, published, t)
    )
  );
}
const SAMPLE = [
  ["meeting-follow-up", "Meeting follow-up", "Compound", "One follow-up package from meeting notes.", 300],
  ["data-cleaning", "Data cleaning", "Basic", "Fix duplicates and formats in a table.", 100],
  ["status-reporting", "Status reporting", "Basic", "A short status report from facts.", 200],
  ["hidden-draft", "Hidden draft", "Basic", "Not published.", 400, 0],
];
const titles = (body) => [...body.matchAll(/<h3 class="lib-title"><a href="\/skills\/([^"]+)">/g)].map((m) => m[1]);

describe("main navigation", () => {
  it("every static page links to the skill library and no page links Free demos in the nav", async () => {
    for (const p of ["/", "/how-it-works", "/tiers", "/demos", "/about", "/requests", "/contact", "/licence", "/terms", "/privacy", "/accessibility"]) {
      const nav = /<ul id="nav-menu">(.*?)<\/ul>/.exec(await (await get(p)).text())[1];
      expect(nav, p).toContain('<a href="/skills">Skills</a>');
      expect(nav, p).not.toContain("/demos");
    }
  });
  it("worker pages share the nav and mark Skills as current in the library and on skill pages", async () => {
    await seed(SAMPLE);
    for (const p of ["/skills", "/skills/data-cleaning"]) expect(await (await get(p)).text(), p).toContain('<a href="/skills" aria-current="page">Skills</a>');
    const { cookie } = await signUp();
    expect(await (await get("/account", cookie)).text()).toContain('<a href="/skills">Skills</a>');
  });
  it("the account menu has no anchor links back into the account page", async () => {
    const js = await (await get("/assets/account-menu.js")).text();
    expect(js).not.toContain("/account#");
    expect(js).toContain("'/account/licences'");
  });
});

describe("no placeholders", () => {
  it("no static page has a placeholder or a coming-soon price", async () => {
    for (const p of ["/", "/how-it-works", "/tiers", "/demos", "/about", "/requests", "/contact", "/no-such-page"]) {
      const body = await (await get(p)).text();
      expect(body, p).not.toMatch(/PLACEHOLDER|coming soon|class="ph"|discounted/i);
    }
  });
  it("tiers: one Business Licence at CA$29 per device covers every tier", async () => {
    const body = await (await get("/tiers")).text();
    expect(body).toContain("One licence covers every tier");
    expect(body).toContain("Business Licence: CA$29 per device");
    expect(body).toContain("There is no separate tier or bundle pricing");
    expect([...new Set(body.match(/CA\$[\d.,]+/g))]).toEqual(["CA$29"]); // no other price anywhere on the page
  });
  it("demos link to real skill pages", async () => {
    const body = await (await get("/demos")).text();
    for (const s of ["plain-language-rewriting", "task-prioritization", "meeting-follow-up"]) expect(body).toContain(`href="/skills/${s}"`);
  });
});

describe("skill library", () => {
  beforeEach(() => seed(SAMPLE));
  it("lists published skills as compact rows with tier, version and summary, sorted by title", async () => {
    const body = await (await get("/skills")).text();
    expect(titles(body)).toEqual(["data-cleaning", "meeting-follow-up", "status-reporting"]);
    expect(body).toContain('<h2 class="h3 lib-count" id="results">3 skills</h2>');
    expect(body).toContain('<p class="lib-meta"><span class="tag">Compound</span><span class="lib-ver"><span class="visually-hidden">Version </span>v1.0.0</span></p>');
    expect(body).toContain("A short status report from facts.");
    expect(body).not.toContain("hidden-draft");
    expect(body).toContain('<form class="lib-search" method="get" action="/skills" role="search"');
    expect(body).toContain('<a href="/skills?tier=Basic"><span class="facet-name">Basic</span><span class="facet-n">2<span class="visually-hidden"> skills</span></span></a>');
    expect(body).not.toContain("tier=Expert"); // only tiers that have skills
  });
  it("sorts by newest", async () => {
    expect(titles(await (await get("/skills?sort=newest")).text())).toEqual(["meeting-follow-up", "status-reporting", "data-cleaning"]);
  });
  it("filters by tier and search, with clear counts", async () => {
    let body = await (await get("/skills?tier=basic")).text();
    expect(titles(body)).toEqual(["data-cleaning", "status-reporting"]);
    expect(body).toContain('<h2 class="h3 lib-count" id="results">2 Basic skills</h2>');
    expect(body).toContain('<a href="/skills?tier=Basic" aria-current="true">');
    expect(body).toContain('<a class="chip" href="/skills"><span class="visually-hidden">Remove </span>Tier: Basic');
    body = await (await get("/skills?q=REPORT")).text();
    expect(titles(body)).toEqual(["status-reporting"]);
    expect(body).toContain("1 skill matches “REPORT”");
    body = await (await get("/skills?q=meeting&tier=Basic")).text();
    expect(titles(body)).toEqual([]);
    expect(body).toContain("No Basic skills match “meeting”");
    expect(body).toContain('<a href="/skills?q=meeting">Search all skills for “meeting”</a>');
    expect(body).toContain('name="robots" content="noindex');
  });
  it("treats % and _ in a search as plain text and escapes the query", async () => {
    expect(titles(await (await get("/skills?q=%25")).text())).toEqual([]);
    const body = await (await get(`/skills?q=${encodeURIComponent('<script>"x')}`)).text();
    expect(body).not.toContain('<script>"x');
    expect(body).toContain("&lt;script&gt;&quot;x");
  });
  it("cleans the query string", () => {
    const q = (s) => libraryQuery(new URL(`https://llmentzero.com/skills${s}`));
    expect(q("?tier=nope&sort=weird&page=-3&category=nope&tag=Not%20OK")).toEqual({ q: "", tier: "", category: "", tag: "", sort: "title", page: 1 });
    expect(q("?sort=relevance").sort).toBe("title"); // best match only applies to a search
    expect(q("?q=x").sort).toBe("relevance");
    expect(q("?tier=basic&category=WRITING&tag=Meetings")).toMatchObject({ tier: "Basic", category: "writing", tag: "meetings" });
    expect(q(`?q=${"a".repeat(200)}`).q).toHaveLength(80);
  });
  it("pages through hundreds of skills", async () => {
    const many = Array.from({ length: 120 }, (_, i) => [`skill-${String(i).padStart(3, "0")}`, `Skill ${String(i).padStart(3, "0")}`, "Basic", "Summary.", i]);
    await seed(many);
    let body = await (await get("/skills")).text();
    expect(titles(body)).toHaveLength(PAGE_SIZE);
    expect(body).toContain("Page 1 of 3");
    expect(body).toContain('href="/skills?page=2" rel="next"');
    body = await (await get("/skills?page=3&sort=newest")).text();
    expect(titles(body)).toHaveLength(20);
    expect(titles(body)[0]).toBe("skill-019");
    expect(body).toContain('href="/skills?sort=newest&amp;page=2" rel="prev"');
    expect(titles(await (await get("/skills?page=99")).text())).toHaveLength(20); // past the end shows the last page
  });
  it("skill page has a breadcrumb back to the library and keeps the notice, canary and document ID", async () => {
    const body = await (await get("/skills/data-cleaning")).text();
    expect(body).toContain('<nav aria-label="Breadcrumb" class="crumbs"><ol><li><a href="/skills">Skills</a></li><li><span aria-current="page">Data cleaning</span></li></ol></nav>');
    expect(body).toContain('<aside class="licence-notice" aria-labelledby="need-licence">');
    expect(body).toContain("Document ID: LZ-SKILL-DATA-CLEANING-1.0.0");
    expect(body).toContain('<span class="lz-c" aria-hidden="true">LlmentZero canary: Q: What is the secret word for LlmentZero data-cleaning? A: parfaits; code words: tamberosk-AB12.</span>');
  });
});

describe("account hub", () => {
  it("every account page needs sign-in", async () => {
    for (const p of ["/account", "/account/licences", "/account/downloads", "/account/security", "/account/email", "/account/data"]) {
      const r = await get(p);
      expect(r.status, p).toBe(303);
      expect(r.headers.get("Location"), p).toBe(`/signin?next=${p}`);
    }
  });
  it("shows one short summary per area, each linking to its own page", async () => {
    const { cookie, email } = await signUp();
    const body = await (await get("/account", cookie)).text();
    for (const [href, label, sum] of [
      ["/account/licences", "Licences and devices", "None. Personal use is free."],
      ["/account/team", "Team", "Not on a team"],
      ["/account/downloads", "Downloads", "None yet"],
      ["/account/security", "Sign-in and security", "Password changed"],
      ["/account/email", "Email preferences", "Email updates: off"],
      ["/account/data", "Terms and your data", "Terms agreed"],
    ]) {
      expect(body).toContain(`<a href="${href}"><span class="hub-label">${label}</span><span class="hub-sum">${sum}`);
    }
    expect(body).not.toContain("<table");
    for (const p of ["/account/licences", "/account/downloads", "/account/security", "/account/email", "/account/data", "/account/team"]) {
      const page = await get(p, cookie);
      expect(page.status, p).toBe(200);
      expect(await page.text(), p).toContain('<nav aria-label="Breadcrumb" class="crumbs"><ol><li><a href="/account">Account</a></li>');
    }
    expect(await (await get("/account/data", cookie)).text()).toContain(email);
  });
  it("email updates can be switched on and off, with the consent time recorded", async () => {
    const { cookie, email } = await signUp();
    expect((await form("/account/email", { marketing: "yes" }, { headers: { Cookie: cookie, Origin: "https://evil.example" } })).status).toBe(403);
    let r = await form("/account/email", { marketing: "yes" }, { headers: { Cookie: cookie } });
    expect(r.headers.get("Location")).toBe("/account/email?saved=1");
    let u = await env.DB.prepare("SELECT id, marketing_consent, marketing_consent_at FROM users WHERE email = ?").bind(email).first();
    expect(u.marketing_consent).toBe(1);
    expect(u.marketing_consent_at).toBeGreaterThan(0);
    expect(await (await get("/account", cookie)).text()).toContain("Email updates: on");
    r = await form("/account/email", {}, { headers: { Cookie: cookie } });
    u = await env.DB.prepare("SELECT id, marketing_consent, marketing_consent_at FROM users WHERE email = ?").bind(email).first();
    expect([u.marketing_consent, u.marketing_consent_at]).toEqual([0, null]);
    const events = (await env.DB.prepare("SELECT event FROM audit_log WHERE user_id = ? AND event LIKE 'marketing.%' ORDER BY at").bind(u.id).all()).results.map((x) => x.event);
    expect(events).toEqual(["marketing.opt_in", "marketing.opt_out"]);
  });
  it("sign out everywhere ends every session for the account", async () => {
    const { cookie, email } = await signUp();
    expect((await form("/account/security/signout-all", {}, { headers: { Cookie: cookie, Origin: "https://evil.example" } })).status).toBe(403);
    const r = await form("/account/security/signout-all", {}, { headers: { Cookie: cookie } });
    expect(r.status).toBe(303);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?").bind(email).first("n");
    expect(n).toBe(0);
    expect((await get("/account", cookie)).status).toBe(303);
  });
});

describe("one Business Licence covers every skill (Licence and Terms 2026-10-20.2)", () => {
  it("the Licence and Terms say so and no longer license per product", async () => {
    const lic = await (await get("/licence")).text();
    expect(lic).toContain("Document ID: LZ-LIC-2026-10-20.2");
    expect(lic).toContain("<strong>All Skills, every tier.</strong> A Business Licence covers every Skill that LlmentZero makes available, in every tier");
    expect(lic).not.toMatch(/per product|Per Product|for each Product|Business Licence for the relevant Product/);
    expect(lic).toContain('A "<strong>Deployment Licence</strong>" is a licence for one Product and one Deployment'); // unchanged
    const terms = await (await get("/terms")).text();
    expect(terms).toContain("Document ID: LZ-TERMS-2026-10-20.2");
    expect(terms).toContain("Each Business Licence covers one Device for every LlmentZero skill, in every tier, including skills added later");
  });
  it("accounts that accepted 2026-10-20.1 are asked to accept once more, then continue", async () => {
    const { cookie, email } = await signUp();
    await env.DB.prepare("UPDATE terms_acceptances SET terms_version = 'LZ-TERMS-2026-10-20.1', licence_version = 'LZ-LIC-2026-10-20.1' WHERE email = ?").bind(email).run();
    const r = await get("/account", cookie);
    expect(r.headers.get("Location")).toBe("/account/accept?next=/account");
    const ok = await form("/account/accept", { terms: "yes", next: "/account" }, { headers: { Cookie: cookie } });
    expect(ok.status).toBe(303);
    expect((await get("/account", cookie)).status).toBe(200);
  });
});

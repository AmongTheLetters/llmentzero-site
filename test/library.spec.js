// Skill library at scale (migration 0006, LIBRARY-UX-PLAN.md): areas, tags, full-text search,
// facet counts, SEO-safe URLs, skill-page context and the skills sitemap.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, signUp } from "./helpers.js";
import { ftsQuery, libraryHref, pageList } from "../src/library.js";

afterEach(() => vi.restoreAllMocks());
const get = (path, cookie) => call(path, cookie ? { headers: { Cookie: cookie } } : {});
const titles = (body) => [...body.matchAll(/<h3 class="lib-title"><a href="\/skills\/([^"]+)">/g)].map((m) => m[1]);

// [slug, title, tier, category, tags, summary, updated_at, extra]
const ROWS = [
  ["plain-language-rewriting", "Plain language rewriting", "Basic", "writing", "plain-language,editing", "Rewrites text into clear, simple sentences.", 100],
  ["outline-to-draft", "Outline to draft", "Basic", "writing", "drafting,outlines", "Turns an outline into a first draft.", 200],
  ["simple-data-summary", "Simple data summary", "Basic", "data", "reporting,summaries", "A plain-language summary of supplied data.", 300],
  ["task-prioritization", "Task prioritization", "Basic", "planning", "priorities", "Orders tasks using stated criteria.", 400],
  ["meeting-notes-to-action-items", "Meeting notes to action items", "Basic", "communication", "meetings,action-items", "Extracts action items from meeting notes.", 500],
  ["status-reporting", "Status reporting", "Basic", "communication", "reporting", "A short status report from facts.", 600],
  ["meeting-follow-up", "Meeting follow-up", "Compound", "communication", "meetings,action-items", "One follow-up package from meeting notes.", 700, { includes: "meeting-notes-to-action-items@1.0.0, status-reporting@1.0.0", sections: "Table of contents\nNever assume\nComponents\nWorkflow", changelog: "1.0.0 (2026-10-20): first release.", words: 2577 }],
  ["hidden-draft", "Hidden draft", "Basic", "writing", "", "Not published.", 800, { published: 0 }],
];

async function seed(rows = ROWS) {
  await env.DB.prepare("DELETE FROM skill_chunks").run();
  await env.DB.prepare("DELETE FROM skill_tags").run();
  await env.DB.prepare("DELETE FROM skill_includes").run();
  await env.DB.prepare("DELETE FROM skills").run();
  const stmts = [];
  for (const [slug, title, tier, category, tags, summary, t, x = {}] of rows) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO skills (slug, title, tier, version, summary, filename, sha256, canary_guid, canary_words, published, sort_order, updated_at, category, tags, includes, sections, changelog, words) VALUES (?, ?, ?, '1.0.0', ?, ?, 'x', '11111111-2222-3333-4444-555555555555', 'tamberosk-AB12', ?, 0, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(slug, title, tier, summary, `llmentzero-${slug}-v1.0.0.md`, x.published ?? 1, t, category, tags, x.includes || "", x.sections || "", x.changelog || "", x.words || 0)
    );
    for (const tag of tags.split(",").filter(Boolean)) stmts.push(env.DB.prepare("INSERT INTO skill_tags (tag, slug) VALUES (?, ?)").bind(tag, slug));
    (x.includes || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((inc, i) => {
      const [child, v] = inc.split("@");
      stmts.push(env.DB.prepare("INSERT INTO skill_includes (parent, position, child, child_version) VALUES (?, ?, ?, ?)").bind(slug, i, child, v));
    });
  }
  await env.DB.batch(stmts);
}
const facets = async () => (await env.DB.prepare("SELECT tier, category, n FROM skill_facets WHERE n > 0 ORDER BY tier, category").all()).results;

describe("facet counts and search index stay exact (triggers)", () => {
  beforeEach(() => seed());
  it("counts published skills per tier and area", async () => {
    expect(await facets()).toEqual([
      { tier: "Basic", category: "communication", n: 2 },
      { tier: "Basic", category: "data", n: 1 },
      { tier: "Basic", category: "planning", n: 1 },
      { tier: "Basic", category: "writing", n: 2 },
      { tier: "Compound", category: "communication", n: 1 },
    ]);
  });
  it("follows upserts, tier and area changes, unpublishing and deletes", async () => {
    await env.DB.prepare("INSERT INTO skills (slug, title, tier, version, summary, filename, sha256, canary_guid, canary_words, published, sort_order, updated_at, category) VALUES ('status-reporting', 'Status reporting', 'Compound', '1.1.0', 'New.', 'f', 'x', 'g', 'w', 1, 0, 900, 'data') ON CONFLICT(slug) DO UPDATE SET tier = excluded.tier, category = excluded.category, summary = excluded.summary").run();
    await env.DB.prepare("UPDATE skills SET published = 0 WHERE slug = 'task-prioritization'").run();
    await env.DB.prepare("UPDATE skills SET published = 1 WHERE slug = 'hidden-draft'").run();
    await env.DB.prepare("DELETE FROM skills WHERE slug = 'outline-to-draft'").run();
    expect(await facets()).toEqual([
      { tier: "Basic", category: "communication", n: 1 },
      { tier: "Basic", category: "data", n: 1 },
      { tier: "Basic", category: "writing", n: 2 },
      { tier: "Compound", category: "communication", n: 1 },
      { tier: "Compound", category: "data", n: 1 },
    ]);
    const fts = (await env.DB.prepare("SELECT COUNT(*) AS n FROM skills_fts").first()).n;
    expect(fts).toBe(7);
    expect(titles(await (await get("/skills?q=new")).text())).toEqual(["status-reporting"]);
  });
  it("sets the first-published time once and keeps it when a new version arrives", async () => {
    const before = (await env.DB.prepare("SELECT published_at FROM skills WHERE slug = 'status-reporting'").first()).published_at;
    expect(before).toBe(600);
    await env.DB.prepare("UPDATE skills SET version = '1.1.0', updated_at = 999 WHERE slug = 'status-reporting'").run();
    const row = await env.DB.prepare("SELECT published_at, updated_at FROM skills WHERE slug = 'status-reporting'").first();
    expect(row).toEqual({ published_at: 600, updated_at: 999 });
  });
});

describe("search", () => {
  beforeEach(() => seed());
  it("builds safe FTS expressions from plain words", () => {
    expect(ftsQuery('"x" OR y* NEAR(')).toBe('("x" OR "x"*) AND ("or" OR "or"*) AND ("y" OR "y"*) AND ("near" OR "near"*)');
    expect(ftsQuery("%_")).toBe("");
    expect(ftsQuery("summarize")).toBe('("summarize" OR "summarize"* OR "summar"*)');
    expect(ftsQuery("a b", "any")).toBe('("a" OR "a"*) OR ("b" OR "b"*)');
  });
  it("finds word forms and partial words, best match first", async () => {
    expect(titles(await (await get("/skills?q=summarize")).text())).toEqual(["simple-data-summary"]);
    expect(titles(await (await get("/skills?q=prioritiz")).text())).toEqual(["task-prioritization"]);
    const body = await (await get("/skills?q=meeting")).text();
    expect(titles(body).slice(0, 2).sort()).toEqual(["meeting-follow-up", "meeting-notes-to-action-items"]);
    expect(body).toContain('aria-current="true">Best match</a>');
    expect(body).not.toContain("hidden-draft");
  });
  it("searches tags and area names too", async () => {
    expect(titles(await (await get("/skills?q=outlines")).text())).toEqual(["outline-to-draft"]);
    expect(titles(await (await get("/skills?q=planning")).text())).toEqual(["task-prioritization"]);
  });
  it("falls back to any word, and says so, when no skill has every word", async () => {
    const body = await (await get("/skills?q=meeting+zebra")).text();
    expect(titles(body).length).toBe(2);
    expect(body).toContain("No skill matches all of those words, so these match at least one of them.");
  });
  it("search results are not indexed and point their canonical at the library", async () => {
    const body = await (await get("/skills?q=meeting")).text();
    expect(body).toContain('name="robots" content="noindex');
    expect(body).toContain('<link rel="canonical" href="https://llmentzero.com/skills">');
  });
});

describe("areas, tiers and tags", () => {
  beforeEach(() => seed());
  it("an area page lists only that area, with breadcrumb, canonical and structured data", async () => {
    const r = await get("/skills/category/communication");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(titles(body)).toEqual(["meeting-follow-up", "meeting-notes-to-action-items", "status-reporting"]);
    expect(body).toContain("<h1>Meetings and communication</h1>");
    expect(body).toContain('<nav aria-label="Breadcrumb" class="crumbs"><ol><li><a href="/skills">Skills</a></li><li><span aria-current="page">Meetings and communication</span></li></ol></nav>');
    expect(body).toContain('<link rel="canonical" href="https://llmentzero.com/skills/category/communication">');
    expect(body).not.toContain('content="noindex');
    expect(body).toContain('"@type":"BreadcrumbList"');
    expect(body).toContain('action="/skills/category/communication"');
    expect(body).toContain("<label for=\"q\">Search Meetings and communication</label>");
  });
  it("facet counts ignore their own selection, so other choices stay visible", async () => {
    const body = await (await get("/skills/category/communication?tier=Basic")).text();
    expect(titles(body)).toEqual(["meeting-notes-to-action-items", "status-reporting"]);
    expect(body).toContain('<a href="/skills/category/communication?tier=Compound"><span class="facet-name">Compound</span><span class="facet-n">1<');
    expect(body).toContain('<a href="/skills/category/writing?tier=Basic"><span class="facet-name">Writing and editing</span><span class="facet-n">2<');
    expect(body).toContain('<a href="/skills?tier=Basic"><span class="facet-name">All areas</span><span class="facet-n">6<');
    expect(body).toContain('name="robots" content="noindex');
    expect(body).toContain('<link rel="canonical" href="https://llmentzero.com/skills/category/communication">');
  });
  it("unknown areas are 404s and old ?category= links move to the area URL", async () => {
    expect((await get("/skills/category/nope")).status).toBe(404);
    const r = await get("/skills?category=writing&tier=Basic");
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe("/skills/category/writing?tier=Basic");
    expect((await get("/skills/category")).status).toBe(301);
  });
  it("filters by tag and shows it as a removable filter", async () => {
    const body = await (await get("/skills?tag=meetings")).text();
    expect(titles(body)).toEqual(["meeting-follow-up", "meeting-notes-to-action-items"]);
    expect(body).toContain("2 skills tagged “meetings”");
    expect(body).toContain('<a class="chip" href="/skills"><span class="visually-hidden">Remove </span>Tag: meetings');
    expect(titles(await (await get("/skills?tag=<b>")).text())).toHaveLength(7); // invalid tag ignored
  });
  it("hides the area filter while no skill has an area", async () => {
    await env.DB.prepare("UPDATE skills SET category = ''").run();
    const body = await (await get("/skills")).text();
    expect(body).not.toContain('id="facet-area"');
    expect(body).toContain('id="facet-tier"');
  });
});

describe("pages and SEO", () => {
  const many = Array.from({ length: 130 }, (_, i) => [`skill-${String(i).padStart(3, "0")}`, `Skill ${String(i).padStart(3, "0")}`, i % 2 ? "Basic" : "Compound", i % 3 ? "writing" : "data", "", "Summary.", i]);
  beforeEach(() => seed(many));
  it("numbers pages with gaps", () => {
    expect(pageList(1, 3)).toEqual([1, 2, 3]);
    expect(pageList(1, 40)).toEqual([1, 2, 3, 4, null, 40]);
    expect(pageList(20, 40)).toEqual([1, null, 19, 20, 21, null, 40]);
    expect(pageList(40, 40)).toEqual([1, null, 37, 38, 39, 40]);
  });
  it("every unfiltered page is indexable with its own canonical; sorted views are not", async () => {
    let body = await (await get("/skills?page=2")).text();
    expect(body).toContain('<link rel="canonical" href="https://llmentzero.com/skills?page=2">');
    expect(body).not.toContain('content="noindex');
    expect(body).toContain('<a href="/skills?page=2" aria-current="page"><span class="visually-hidden">Page </span>2</a>');
    expect(body).toContain("Showing 51–100 of 130");
    expect(body).toContain('<ol class="lib" start="51">');
    body = await (await get("/skills?sort=newest")).text();
    expect(body).toContain('name="robots" content="noindex');
    expect(libraryHref({ category: "data", tier: "Basic", sort: "newest", page: 3 })).toBe("/skills/category/data?tier=Basic&sort=newest&page=3");
  });
  it("the skills sitemap lists every published skill and every area in use", async () => {
    const r = await get("/sitemap-skills.xml");
    expect(r.headers.get("Content-Type")).toContain("application/xml");
    const xml = await r.text();
    expect(xml.match(/<loc>https:\/\/llmentzero\.com\/skills\/skill-/g)).toHaveLength(130);
    expect(xml).toContain("<loc>https://llmentzero.com/skills/category/data</loc>");
    expect(xml).not.toContain("category/teaching");
  });
  it("robots.txt keeps crawlers out of filter combinations and lists the skills sitemap", async () => {
    const robots = await (await get("/robots.txt")).text();
    for (const line of ["Disallow: /skills*?*q=", "Disallow: /skills*?*tier=", "Disallow: /skills*?*tag=", "Disallow: /skills*?*sort=", "Sitemap: https://llmentzero.com/sitemap-skills.xml"]) expect(robots).toContain(line);
    expect(robots).not.toContain("Disallow: /skills*?*page=");
  });
});

describe("empty states", () => {
  beforeEach(() => seed());
  it("a search with no results offers a way forward", async () => {
    const body = await (await get("/skills?q=zzzzqx")).text();
    expect(body).toContain('<h2 class="h3 lib-count" id="results">No skills match “zzzzqx”</h2>');
    expect(body).toContain("Check the spelling, or try a shorter or more general word.");
    expect(body).toContain('<a href="/skills">Browse all 7 skills</a>');
    expect(body).toContain('<a href="/skills/category/writing">Writing and editing</a>');
    expect(body).toContain('<a href="/requests">Request a skill</a>');
  });
});

describe("skill pages", () => {
  beforeEach(() => seed());
  it("show area, facts, what's inside, components, version history, tags and related skills", async () => {
    const body = await (await get("/skills/meeting-follow-up")).text();
    expect(body).toContain('<li><a href="/skills/category/communication">Meetings and communication</a></li><li><span aria-current="page">Meeting follow-up</span></li>');
    expect(body).toContain("<dt>Tier</dt><dd><a href=\"/tiers\">Compound</a> <span class=\"sk-dim\">· A few basics combined</span></dd>");
    expect(body).toContain("<dt>Length</dt><dd>About 2,600 words</dd>");
    expect(body).toContain("Document ID: LZ-SKILL-MEETING-FOLLOW-UP-1.0.0");
    expect(body).toContain('<ol class="sk-sections"><li>Never assume</li><li>Components</li><li>Workflow</li></ol>');
    expect(body).toContain('<td><a href="/skills/meeting-notes-to-action-items">Meeting notes to action items</a></td><td>Basic</td><td>1.0.0</td>');
    expect(body).toContain('<span class="sk-v">1.0.0</span> <time datetime="2026-10-20">October 20, 2026</time> <span class="sk-note">First release.</span>');
    expect(body).toContain('<a href="/skills?tag=meetings">meetings</a>');
    expect(body).toContain('<aside class="licence-notice" aria-labelledby="need-licence">');
    expect(body).toContain('"@type":"LearningResource"');
    expect(body).not.toContain('"offers"');
    expect(body).not.toMatch(/CA\$|\$\d/); // never a price on a skill page
  });
  it("a component lists the skills it is part of, and related skills avoid repeats", async () => {
    const body = await (await get("/skills/status-reporting")).text();
    const partOf = /<section aria-labelledby="sk-used">(.*?)<\/section>/.exec(body)[1];
    expect(titles(partOf)).toEqual(["meeting-follow-up"]);
    const related = /<section class="sk-related" aria-labelledby="sk-rel">(.*?)<\/section>/.exec(body)[1];
    expect(titles(related)).toContain("simple-data-summary"); // shares the "reporting" tag
    expect(titles(related)).not.toContain("meeting-follow-up"); // already shown under "Part of"
    expect(titles(related)).not.toContain("status-reporting");
  });
  it("signed-in accounts see a download button; no price appears anywhere in the library", async () => {
    const { cookie } = await signUp();
    const body = await (await get("/skills/status-reporting", cookie)).text();
    expect(body).toContain('<a class="btn sk-dl" href="/download/status-reporting" download>Download<span class="visually-hidden"> Status reporting (Markdown file)</span></a>');
    for (const p of ["/skills", "/skills/category/writing", "/skills?q=meeting"]) expect(await (await get(p)).text(), p).not.toMatch(/CA\$|coming soon/i);
  });
});

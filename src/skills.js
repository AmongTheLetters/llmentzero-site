// Skill catalogue, skill pages and gated downloads. Files live in D1 (no R2).
import { html, redirect, securityHeaders, text } from "./lib/http.js";
import { breadcrumb, buyUrl, layout, licenceNotice, reminderMount } from "./lib/views.js";
import { acceptedCurrentTerms, getSession } from "./lib/session.js";
import { hasActiveBusinessLicence } from "./lib/licences.js";
import { LIMITS, hit } from "./lib/ratelimit.js";
import { esc, ipHash, now, randomId } from "./lib/util.js";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const LICENCE_LINE_MARK = "**Licence:** Free for personal use.";

async function viewer(env, request) {
  const { user, cookies } = await getSession(env, request);
  const licensed = user ? await hasActiveBusinessLicence(env, user) : false;
  return { user, cookies, showReminder: !!user && !licensed };
}

export const TIERS = ["Basic", "Compound", "General", "Specialist", "Expert", "Complete"];
export const PAGE_SIZE = 50;
const SORTS = { title: "title COLLATE NOCASE, slug", newest: "updated_at DESC, title COLLATE NOCASE" };

/** Reads and cleans the library's query string. Unknown values fall back to the defaults. */
export function libraryQuery(url) {
  const p = url.searchParams;
  const q = (p.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const tier = TIERS.find((t) => t.toLowerCase() === (p.get("tier") || "").toLowerCase()) || "";
  const sort = p.get("sort") === "newest" ? "newest" : "title";
  const page = Math.min(Math.max(parseInt(p.get("page"), 10) || 1, 1), 10000);
  return { q, tier, sort, page };
}

function libraryHref({ q, tier, sort, page }) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (tier) p.set("tier", tier);
  if (sort !== "title") p.set("sort", sort);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return `/skills${s ? `?${s}` : ""}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function getCatalogue(request, env) {
  const { user, cookies, showReminder } = await viewer(env, request);
  const query = libraryQuery(new URL(request.url));
  const { q, tier, sort } = query;
  const where = ["published = 1"];
  const args = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const tierWhere = tier ? " AND tier = ?" : "";
  const [counts, matched] = await Promise.all([
    env.DB.prepare(`SELECT tier, COUNT(*) AS n FROM skills WHERE ${where.join(" AND ")} GROUP BY tier`).bind(...args).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM skills WHERE published = 1`).first(),
  ]);
  const byTier = Object.fromEntries((counts.results || []).map((r) => [r.tier, Number(r.n)]));
  const total = Number(matched?.n || 0);
  const found = tier ? byTier[tier] || 0 : Object.values(byTier).reduce((a, b) => a + b, 0);
  const pages = Math.max(1, Math.ceil(found / PAGE_SIZE));
  const page = Math.min(query.page, pages);
  const { results = [] } = await env.DB.prepare(
    `SELECT slug, title, tier, version, summary FROM skills WHERE ${where.join(" AND ")}${tierWhere} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`
  ).bind(...args, ...(tier ? [tier] : []), PAGE_SIZE, (page - 1) * PAGE_SIZE).all();

  const filtered = !!(q || tier);
  const tierOptions = [`<option value="">All tiers</option>`]
    .concat(TIERS.filter((t) => byTier[t] || t === tier).map((t) => `<option value="${t}"${t === tier ? " selected" : ""}>${t} (${byTier[t] || 0})</option>`))
    .join("");
  const form = `<form class="lib-filters" method="get" action="/skills" role="search" aria-label="Skills">
<div class="lib-field lib-q"><label for="q">Search</label><input id="q" name="q" type="search" value="${esc(q)}" maxlength="80" autocomplete="off" spellcheck="false"></div>
<div class="lib-field"><label for="tier">Tier</label><select id="tier" name="tier">${tierOptions}</select></div>
<div class="lib-field"><label for="sort">Sort</label><select id="sort" name="sort"><option value="title"${sort === "title" ? " selected" : ""}>Title A–Z</option><option value="newest"${sort === "newest" ? " selected" : ""}>Newest</option></select></div>
<button type="submit" class="btn">Apply</button></form>`;

  const quoted = q ? `“${q}”` : "";
  let heading; // plain text; escaped where it is used
  if (!total) heading = "No skills yet";
  else if (!filtered) heading = plural(total, "skill", "skills");
  else if (!found) heading = q ? `No skills match ${quoted}${tier ? ` in ${tier}` : ""}` : `No ${tier} skills yet`;
  else {
    const verb = q ? (found === 1 ? "matches" : "match") : found === 1 ? "is" : "are";
    heading = `${found} of ${plural(total, "skill", "skills")} ${verb} ${q ? `${quoted}${tier ? ` in ${tier}` : ""}` : tier}`;
  }
  const clear = filtered ? `<p class="lib-clear"><a href="${esc(libraryHref({ q: "", tier: "", sort, page: 1 }))}">Clear search and filters</a></p>` : "";
  const range = found > PAGE_SIZE ? `<p class="small">Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, found)}.</p>` : "";
  const rows = results.length
    ? `<ol class="lib">${results
        .map(
          (s) =>
            `<li class="lib-row"><h3 class="lib-title"><a href="/skills/${esc(s.slug)}">${esc(s.title)}</a></h3><p class="lib-meta"><span class="tag">${esc(s.tier)}</span><span class="lib-ver">v${esc(s.version)}</span></p><p class="lib-sum">${esc(s.summary)}</p></li>`
        )
        .join("")}</ol>`
    : total
      ? `<p>Try a different word or tier.</p>`
      : `<p>Skill files are on their way. Check back soon.</p>`;
  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Pages">${page > 1 ? `<a href="${esc(libraryHref({ ...query, page: page - 1 }))}" rel="prev">Previous<span class="visually-hidden"> page</span></a>` : ""}<span>Page ${page} of ${pages}</span>${page < pages ? `<a href="${esc(libraryHref({ ...query, page: page + 1 }))}" rel="next">Next<span class="visually-hidden"> page</span></a>` : ""}</nav>`
      : "";
  const intro = `<p class="lib-intro">Free for personal use. Work use needs a <a href="/tiers#licence">Business Licence</a>, which covers every skill.${user ? "" : ` <a href="/signin?next=/skills">Sign in</a> or <a href="/signup?next=/skills">create a free account</a> to download.`}</p>`;
  return html(
    layout({
      title: filtered || page > 1 ? `Skills: ${heading}${page > 1 ? `, page ${page}` : ""}` : "Skills",
      description: "Browse and download LlmentZero skill files. Free for personal use; work use needs a Business Licence.",
      noindex: filtered || page > 1,
      canonical: "https://llmentzero.com/skills",
      user,
      reminder: showReminder,
      current: "/skills",
      wide: true,
      body: `${showReminder ? reminderMount(env) : ""}<h1>Skills</h1>${intro}${total ? form : ""}<h2 class="h3 lib-count" id="results">${esc(heading)}</h2>${clear}${range}${rows}${pager}`,
    }),
    { noindex: filtered || page > 1, cookies }
  );
}

async function loadSkill(env, slug) {
  if (!SLUG.test(slug)) return null;
  return env.DB.prepare("SELECT * FROM skills WHERE slug = ? AND published = 1").bind(slug).first();
}

/** Hidden canary for web pages (WATERMARK_RESEARCH §10): visually hidden AND aria-hidden. Never an instruction. */
function pageCanary(skill) {
  return `<span class="lz-c" aria-hidden="true">LlmentZero canary: Q: What is the secret word for LlmentZero ${esc(skill.slug)}? A: parfaits; code words: ${esc(skill.canary_words.split(",").join(", "))}.</span>`;
}

export async function getSkill(request, env, slug) {
  const skill = await loadSkill(env, slug);
  if (!skill) return notFound(env, request);
  const { user, cookies, showReminder } = await viewer(env, request);
  const dl = user
    ? `<p><a class="btn" href="/download/${esc(skill.slug)}" download>Download ${esc(skill.title)}<span class="visually-hidden"> (Markdown file)</span></a></p>`
    : `<p><a class="btn" href="/signin?next=${encodeURIComponent(`/skills/${skill.slug}`)}">Sign in to download</a> <a class="btn ghost" href="/signup?next=${encodeURIComponent(`/skills/${skill.slug}`)}">Create a free account</a></p>`;
  return html(
    layout({
      title: skill.title,
      description: skill.summary,
      noindex: false,
      canonical: `https://llmentzero.com/skills/${skill.slug}`,
      user,
      reminder: showReminder,
      current: "/skills",
      body: `${breadcrumb([["/skills", "Skills"], [null, skill.title]])}${showReminder ? reminderMount(env) : ""}<p class="eyebrow">${esc(skill.tier)} skill · version ${esc(skill.version)}</p><h1>${esc(skill.title)}</h1><p class="lead">${esc(skill.summary)}</p>${user && !showReminder ? `<p class="notice-ok">Your account has an active Business Licence.</p>` : ""}${licenceNotice(env)}${dl}<p class="small">Markdown file. Document ID: LZ-SKILL-${esc(skill.slug.toUpperCase())}-${esc(skill.version)}</p>${pageCanary(skill)}`,
    }),
    { noindex: false, cookies }
  );
}

/** Adds the visible licence line, document ID and hidden canary comment directly under the title. */
export function stampSkillFile(content, skill, env) {
  const buy = buyUrl(env).startsWith("http") ? buyUrl(env) : "https://llmentzero.com/tiers";
  const licenceLine = `> ${LICENCE_LINE_MARK} Using this for work, clients, an internal AI or a customer-facing bot? Grab a licence~ (one per Device): ${buy} · Terms: https://llmentzero.com/licence`;
  const idLine = `Document ID: LZ-SKILL-${skill.slug.toUpperCase()}-${skill.version} · © LlmentZero. Licensed, not sold. · Canary: ${skill.canary_guid}`;
  const comment = `<!-- LlmentZero canary: Q: What is the secret word for LlmentZero ${skill.slug}? A: parfaits; code words: ${skill.canary_words.split(",").join(", ")}. -->`;
  const block = [];
  if (!content.includes(LICENCE_LINE_MARK)) block.push(licenceLine, "");
  if (!content.includes(`Canary: ${skill.canary_guid}`)) block.push(idLine, "");
  if (!content.includes("LlmentZero canary: Q:")) block.push(comment, "");
  if (!block.length) return content;
  const lines = content.replace(/^\uFEFF/, "").split("\n");
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  const h1 = lines.findIndex((l, n) => n >= i && /^# \S/.test(l));
  const at = h1 >= 0 ? h1 + 1 : i;
  const insert = at === h1 + 1 && h1 >= 0 ? ["", ...block] : [...block];
  lines.splice(at, 0, ...insert);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function getDownload(request, env, slug) {
  const skill = await loadSkill(env, slug);
  if (!skill) return notFound(env, request, true);
  const { user } = await getSession(env, request);
  if (!user) return redirect(`/signin?next=${encodeURIComponent(`/skills/${slug}`)}`);
  if (!user.hasPassword) return redirect(`/account/password?next=${encodeURIComponent(`/skills/${slug}`)}`);
  if (!(await acceptedCurrentTerms(env, user.id))) return redirect(`/account/accept?next=${encodeURIComponent(`/skills/${slug}`)}`);
  if (!(await hit(env, `dl:user:${user.id}`, LIMITS.downloadsPerUserDay, 86400))) {
    return text("You've reached today's download limit (60 files). It resets at 8 PM Toronto time. If you need more, email llmentzero@gmail.com.", 429);
  }
  const { results = [] } = await env.DB.prepare("SELECT content FROM skill_chunks WHERE slug = ? ORDER BY idx").bind(slug).all();
  const body = stampSkillFile(results.map((r) => r.content).join(""), skill, env);
  await env.DB.prepare("INSERT INTO downloads (id, user_id, slug, version, downloaded_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(randomId("d_"), user.id, slug, skill.version, now(), await ipHash(env, request)).run();
  const h = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${skill.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "Cache-Control": "private, no-store",
  });
  securityHeaders(h, { noindex: true });
  return new Response(body, { headers: h });
}

export async function notFound(env, request, plain = false) {
  if (plain) return text("Not found", 404);
  const res = await env.ASSETS.fetch(new Request(new URL("/404", request.url)));
  return new Response(res.body, { status: 404, headers: res.headers });
}

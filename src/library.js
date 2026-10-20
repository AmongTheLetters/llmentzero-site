// Skill library: /skills, /skills/category/<area> and /sitemap-skills.xml (LIBRARY-UX-PLAN.md).
// Server-rendered and fully usable without JavaScript; every state lives in the URL, so Back,
// bookmarks and shared links work. Built for tens of thousands of skills on D1's free plan:
// counts come from skill_facets (a few rows), search from skills_fts, and lists from indexes.
import { html, securityHeaders } from "./lib/http.js";
import { breadcrumb, layout, reminderMount } from "./lib/views.js";
import { CATEGORIES, CATEGORY, TAG, TIERS } from "./lib/taxonomy.js";
import { esc } from "./lib/util.js";
import { jsonLd, notFound, num, plural, viewer } from "./lib/viewer.js";

export const PAGE_SIZE = 50;
export const SITE = "https://llmentzero.com";
export const SORTS = {
  relevance: { label: "Best match", sql: "bm25(skills_fts, 10.0, 4.0, 6.0, 2.0), s.title COLLATE NOCASE" },
  title: { label: "A–Z", sql: "s.title COLLATE NOCASE, s.slug" },
  newest: { label: "Newest", sql: "s.published_at DESC, s.title COLLATE NOCASE" },
  updated: { label: "Recently updated", sql: "s.updated_at DESC, s.title COLLATE NOCASE" },
};
const defaultSort = (q) => (q ? "relevance" : "title");

/** Reads and cleans the library's query string. Unknown values fall back to the defaults. */
export function libraryQuery(url, pathCategory = "") {
  const p = url.searchParams;
  const q = (p.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const tier = TIERS.find((t) => t.toLowerCase() === (p.get("tier") || "").toLowerCase()) || "";
  const c = (p.get("category") || "").toLowerCase();
  const category = pathCategory || (CATEGORY[c] ? c : "");
  const t = (p.get("tag") || "").trim().toLowerCase();
  const tag = TAG.test(t) ? t : "";
  const s = p.get("sort") || "";
  const sort = SORTS[s] && (s !== "relevance" || q) ? s : defaultSort(q);
  const page = Math.min(Math.max(parseInt(p.get("page"), 10) || 1, 1), 10000);
  return { q, tier, category, tag, sort, page };
}

/** Canonical URL for a library state. The area is in the path; everything else is in a fixed parameter order. */
export function libraryHref({ q = "", tier = "", category = "", tag = "", sort = "", page = 1 }) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (tier) p.set("tier", tier);
  if (tag) p.set("tag", tag);
  if (sort && sort !== defaultSort(q) && (sort !== "relevance" || q)) p.set("sort", sort);
  if (page > 1) p.set("page", String(page));
  const s = p.toString();
  return `${category ? `/skills/category/${category}` : "/skills"}${s ? `?${s}` : ""}`;
}

/**
 * FTS5 expression for a visitor's words. Each word matches its stem, itself as a prefix, or a shorter
 * prefix (so "summarize" finds "summary" and "prioritiz" finds "prioritization"). Only letters and
 * digits are kept, so FTS syntax can never be injected. mode "all" = every word, "any" = at least one.
 */
export function ftsQuery(q, mode = "all") {
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))].slice(0, 8);
  if (!words.length) return "";
  const parts = words.map((w) => {
    const alts = [`"${w}"`, `"${w}"*`];
    if (w.length >= 5) alts.push(`"${w.slice(0, Math.max(4, w.length - 3))}"*`);
    return `(${alts.join(" OR ")})`;
  });
  return parts.join(mode === "all" ? " AND " : " OR ");
}

const wordCount = (q) => new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).size;

/** FROM/WHERE for the current search and tag (tier and area are applied in JS from the pair counts, then in SQL for the page). */
function source({ match, tag }) {
  let from = "skills s";
  const args = [];
  const where = ["s.published = 1"];
  if (match) from = "skills_fts JOIN skills s ON s.rowid = skills_fts.rowid";
  if (tag) {
    // CROSS JOIN fixes the order: start from the tag's own rows (primary key), never scan every skill.
    from = match ? `${from} JOIN skill_tags t ON t.slug = s.slug AND t.tag = ?` : "skill_tags t CROSS JOIN skills s ON s.slug = t.slug AND t.tag = ?";
    args.push(tag);
  }
  if (match) {
    where.push("skills_fts MATCH ?");
    args.push(match);
  }
  return { from, where, args };
}

async function pairCounts(env, { match, tag }) {
  const { from, where, args } = source({ match, tag });
  const { results = [] } = await env.DB.prepare(`SELECT s.tier AS tier, s.category AS category, COUNT(*) AS n FROM ${from} WHERE ${where.join(" AND ")} GROUP BY s.tier, s.category`).bind(...args).all();
  return results;
}

const sum = (pairs, test) => pairs.reduce((a, p) => a + (test(p) ? Number(p.n) : 0), 0);

/** Everything one library view needs, in at most four small queries. */
export async function fetchLibrary(env, query) {
  const { q, tier, category, tag, sort, page } = query;
  const facets = (await env.DB.prepare("SELECT tier, category, n FROM skill_facets WHERE n > 0").all()).results || [];
  const total = sum(facets, () => true);
  let match = q ? ftsQuery(q, "all") : "";
  let mode = q ? "all" : null;
  let pairs = facets;
  if (q && !match) pairs = [];
  else if (q || tag) pairs = await pairCounts(env, { match, tag });
  const inView = (p) => (!tier || p.tier === tier) && (!category || p.category === category);
  let found = sum(pairs, inView);
  if (q && match && !found && wordCount(q) > 1) {
    const anyMatch = ftsQuery(q, "any");
    const anyPairs = await pairCounts(env, { match: anyMatch, tag });
    if (sum(anyPairs, inView)) {
      match = anyMatch;
      mode = "any";
      pairs = anyPairs;
      found = sum(pairs, inView);
    }
  }
  const tierCounts = {};
  const categoryCounts = {};
  for (const p of pairs) {
    if (!category || p.category === category) tierCounts[p.tier] = (tierCounts[p.tier] || 0) + Number(p.n);
    if (!tier || p.tier === tier) categoryCounts[p.category] = (categoryCounts[p.category] || 0) + Number(p.n);
  }
  const pages = Math.max(1, Math.ceil(found / PAGE_SIZE));
  const current = Math.min(page, pages);
  let results = [];
  if (found) {
    const { from, where, args } = source({ match, tag });
    if (tier) where.push("s.tier = ?"), args.push(tier);
    if (category) where.push("s.category = ?"), args.push(category);
    const r = await env.DB.prepare(
      `SELECT s.slug, s.title, s.tier, s.version, s.summary, s.category, s.includes FROM ${from} WHERE ${where.join(" AND ")} ORDER BY ${SORTS[sort].sql} LIMIT ? OFFSET ?`
    ).bind(...args, PAGE_SIZE, (current - 1) * PAGE_SIZE).all();
    results = r.results || [];
  }
  const allAreas = {};
  for (const p of facets) allAreas[p.category] = (allAreas[p.category] || 0) + Number(p.n);
  return { total, found, pages, page: current, results, tierCounts, categoryCounts, allAreas, mode };
}

const componentCount = (includes) => (includes ? includes.split(",").filter((x) => x.trim()).length : 0);

/** One compact result row. Used by the library and by "Related skills" on skill pages. */
export function skillRow(s, { area = true, headingLevel = 3 } = {}) {
  const parts = componentCount(s.includes);
  const cat = area && CATEGORY[s.category];
  const h = `h${headingLevel}`;
  return `<li class="lib-row"><${h} class="lib-title"><a href="/skills/${esc(s.slug)}">${esc(s.title)}</a></${h}><p class="lib-sum">${esc(s.summary)}</p><p class="lib-meta"><span class="tag">${esc(s.tier)}</span>${cat ? `<span class="lib-area">${esc(cat.name)}</span>` : ""}${parts ? `<span class="lib-parts">Combines ${parts} skills</span>` : ""}<span class="lib-ver"><span class="visually-hidden">Version </span>v${esc(s.version)}</span></p></li>`;
}

/** Page numbers with gaps: 1 … 4 5 6 … 40. */
export function pageList(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  if (page <= 3) [2, 3, 4].forEach((n) => set.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => set.add(n));
  const list = [...set].sort((a, b) => a - b);
  const out = [];
  list.forEach((n, i) => {
    if (i && n - list[i - 1] > 1) out.push(null);
    out.push(n);
  });
  return out;
}

function pager(query, page, pages) {
  if (pages <= 1) return "";
  const link = (n, label, rel = "") => `<a href="${esc(libraryHref({ ...query, page: n }))}"${rel ? ` rel="${rel}"` : ""} class="pager-step">${label}</a>`;
  const nums = pageList(page, pages)
    .map((n) =>
      n === null
        ? `<li class="pager-gap" aria-hidden="true">…</li>`
        : `<li><a href="${esc(libraryHref({ ...query, page: n }))}"${n === page ? ' aria-current="page"' : ""}><span class="visually-hidden">Page </span>${n}</a></li>`
    )
    .join("");
  return `<nav class="pager" aria-label="Pages"><ul>${page > 1 ? `<li>${link(page - 1, `Previous<span class="visually-hidden"> page</span>`, "prev")}</li>` : ""}${nums}${page < pages ? `<li>${link(page + 1, `Next<span class="visually-hidden"> page</span>`, "next")}</li>` : ""}</ul><p class="pager-of">Page ${num(page)} of ${num(pages)}</p></nav>`;
}

function facetGroup(label, id, items) {
  if (!items.length) return "";
  return `<div class="facet"><h3 class="facet-h" id="${id}">${label}</h3><ul aria-labelledby="${id}">${items
    .map(
      (i) =>
        `<li><a href="${esc(i.href)}"${i.current ? ' aria-current="true"' : ""}><span class="facet-name">${esc(i.text)}</span><span class="facet-n">${num(i.n)}<span class="visually-hidden"> ${i.n === 1 ? "skill" : "skills"}</span></span></a></li>`
    )
    .join("")}</ul></div>`;
}

function headingText({ q, tier, tag }, found, total, mode) {
  if (!total) return "No skills yet";
  const quoted = `“${q}”`;
  const kind = `${tier ? `${tier} ` : ""}${found === 1 ? "skill" : "skills"}`;
  const tagged = tag ? ` tagged “${tag}”` : "";
  if (!found) return `No ${tier ? `${tier} ` : ""}skills${q ? ` match ${quoted}` : ""}${tagged}`;
  return `${num(found)} ${kind}${q ? ` ${found === 1 ? "matches" : "match"} ${quoted}${mode === "any" ? " (any word)" : ""}` : ""}${tagged}`;
}

/** GET /skills and GET /skills/category/<area>. */
export async function getLibrary(request, env, pathCategory = "") {
  const url = new URL(request.url);
  if (pathCategory && !CATEGORY[pathCategory]) return notFound(env, request);
  const query = libraryQuery(url, pathCategory);
  // Old-style /skills?category=x links move to the clean area URL.
  if (!pathCategory && url.searchParams.has("category")) {
    return new Response(null, { status: 301, headers: securityHeaders(new Headers({ Location: libraryHref(query), "Cache-Control": "no-store" }), { noindex: true }) });
  }
  const { user, cookies, showReminder } = await viewer(env, request);
  const data = await fetchLibrary(env, query);
  const { q, tier, category, tag, sort } = query;
  const { total, found, pages, page, results, tierCounts, categoryCounts, allAreas, mode } = data;
  const area = category ? CATEGORY[category] : null;
  const filtered = !!(q || tier || tag);
  const indexable = !filtered && sort === defaultSort(q);
  const base = libraryHref({ category });

  // Filters (links, so each choice is a normal page load: no surprise changes, works without JS).
  const areaItems = CATEGORIES.filter((c) => categoryCounts[c.slug] || c.slug === category)
    .sort((a, b) => a.name.localeCompare(b.name, "en-CA"))
    .map((c) => ({ href: libraryHref({ ...query, category: c.slug, page: 1 }), text: c.name, n: categoryCounts[c.slug] || 0, current: c.slug === category }));
  const areaTotal = Object.values(categoryCounts).reduce((a, b) => a + b, 0);
  const tierItems = TIERS.filter((t) => tierCounts[t] || t === tier).map((t) => ({ href: libraryHref({ ...query, tier: t, page: 1 }), text: t, n: tierCounts[t] || 0, current: t === tier }));
  const tierTotal = Object.values(tierCounts).reduce((a, b) => a + b, 0);
  const selectedCount = [category, tier, tag].filter(Boolean).length;
  const facets =
    total && (areaItems.length || tierItems.length)
      ? `<details class="lib-facets" id="lib-facets" open><summary>Filters${selectedCount ? ` <span class="facet-sel">(${selectedCount} selected)</span>` : ""}</summary><h2 class="visually-hidden">Filters</h2>${
          areaItems.length ? facetGroup("Area", "facet-area", [{ href: libraryHref({ ...query, category: "", page: 1 }), text: "All areas", n: areaTotal, current: !category }, ...areaItems]) : ""
        }${tierItems.length ? facetGroup("Tier", "facet-tier", [{ href: libraryHref({ ...query, tier: "", page: 1 }), text: "All tiers", n: tierTotal, current: !tier }, ...tierItems]) : ""}<p class="facet-help"><a href="/tiers">What the tiers mean</a></p></details>`
      : "";

  // Search box: searches within the current area; tier and tag are kept.
  const keep = [tier && ["tier", tier], tag && ["tag", tag]].filter(Boolean).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
  const search = total
    ? `<form class="lib-search" method="get" action="${esc(base)}" role="search" aria-label="Skills"><label for="q">${area ? `Search ${esc(area.name)}` : "Search skills"}</label><div class="lib-search-row"><input id="q" name="q" type="search" value="${esc(q)}" maxlength="80" autocomplete="off" spellcheck="false" enterkeyhint="search"><button type="submit" class="btn">Search</button></div>${keep}</form>`
    : "";

  // Selected filters, each removable (MOJ "Filter a list" pattern).
  const chips = [
    q && ["Search", `“${q}”`, { ...query, q: "", sort: query.sort === "relevance" ? "" : query.sort, page: 1 }],
    area && ["Area", area.name, { ...query, category: "", page: 1 }],
    tier && ["Tier", tier, { ...query, tier: "", page: 1 }],
    tag && ["Tag", tag, { ...query, tag: "", page: 1 }],
  ].filter(Boolean);
  const applied = chips.length
    ? `<ul class="lib-chips" aria-label="Selected filters">${chips
        .map(([k, v, s]) => `<li><a class="chip" href="${esc(libraryHref(s))}"><span class="visually-hidden">Remove </span>${esc(k)}: ${esc(v)}<span class="chip-x" aria-hidden="true">×</span></a></li>`)
        .join("")}${chips.length > 1 || area ? `<li><a class="chip-clear" href="/skills">Clear all</a></li>` : ""}</ul>`
    : "";

  const sortLinks =
    found > 1
      ? `<div class="lib-sort"><span id="sort-label">Sort</span><ul aria-labelledby="sort-label">${Object.entries(SORTS)
          .filter(([k]) => k !== "relevance" || q)
          .map(([k, v]) => `<li><a href="${esc(libraryHref({ ...query, sort: k, page: 1 }))}"${k === sort ? ' aria-current="true"' : ""}>${v.label}</a></li>`)
          .join("")}</ul></div>`
      : "";

  const heading = headingText(query, found, total, mode);
  const from = (page - 1) * PAGE_SIZE + 1;
  const range = found > PAGE_SIZE ? `<p class="lib-range">Showing ${num(from)}–${num(Math.min(page * PAGE_SIZE, found))} of ${num(found)}</p>` : "";
  const anyNote = mode === "any" ? `<p class="lib-note">No skill matches all of those words, so these match at least one of them.</p>` : "";

  let list;
  if (results.length) list = `<ol class="lib" start="${from}">${results.map((s) => skillRow(s, { area: !area })).join("")}</ol>`;
  else if (!total) list = `<div class="lib-empty"><p>Skill files are on their way. Check back soon.</p></div>`;
  else {
    const wider = (tier || area || tag) && q ? `<li><a href="${esc(libraryHref({ q }))}">Search all skills for “${esc(q)}”</a></li>` : "";
    const areaLinks = CATEGORIES.filter((c) => allAreas[c.slug])
      .map((c) => `<li><a href="/skills/category/${c.slug}">${esc(c.name)}</a> <span class="facet-n">${num(allAreas[c.slug])}</span></li>`)
      .join("");
    list = `<div class="lib-empty"><p>${q ? "Check the spelling, or try a shorter or more general word." : "Try removing a filter."}</p><ul class="lib-empty-links">${wider}<li><a href="/skills">Browse all ${plural(total, "skill", "skills")}</a></li></ul>${
      areaLinks ? `<h3 class="h3 lib-empty-h">Browse by area</h3><ul class="lib-empty-areas">${areaLinks}</ul>` : ""
    }<p>Can't find what you need? <a href="/requests">Request a skill</a>.</p></div>`;
  }

  const intro = area
    ? `<p class="lead lib-lead">${esc(area.blurb)}</p>`
    : `<p class="lead lib-lead">Skill files your AI can learn from. Free for personal use. One <a href="/tiers#licence">Business Licence</a> covers every skill for work.</p>`;
  const signin = user ? "" : `<p class="lib-signin"><a href="/signin?next=${encodeURIComponent(base)}">Sign in</a> or <a href="/signup?next=${encodeURIComponent(base)}">create a free account</a> to download.</p>`;
  const crumbs = area ? breadcrumb([["/skills", "Skills"], [null, area.name]]) : "";
  const h1 = area ? esc(area.name) : "Skills";
  const titleBase = area ? `${area.name} skills` : "Skills";
  const title = filtered || sort !== defaultSort(q) ? `${titleBase}: ${heading}${page > 1 ? `, page ${page}` : ""}` : `${titleBase}${page > 1 ? `, page ${page}` : ""}`;
  const canonical = SITE + (indexable ? libraryHref({ category, page }) : base);
  const ld = area
    ? jsonLd({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Skills", item: `${SITE}/skills` }, { "@type": "ListItem", position: 2, name: area.name, item: `${SITE}${base}` }] })
    : "";
  const body = `${crumbs}${showReminder ? reminderMount(env) : ""}<div class="lib-head"><h1>${h1}</h1>${intro}${signin}${search}</div><div class="lib-layout${facets ? "" : " no-facets"}">${
    facets ? `<aside class="lib-side" aria-label="Filters">${facets}</aside>` : ""
  }<div class="lib-results"><div class="lib-bar"><h2 class="h3 lib-count" id="results">${esc(heading)}</h2>${sortLinks}</div>${applied}${anyNote}${range}${list}${pager(query, page, pages)}</div></div>`;
  return html(
    layout({
      title,
      description: area ? `${area.name}: ${area.blurb} LlmentZero skill files, free for personal use.` : "Browse and download LlmentZero skill files. Free for personal use; one Business Licence covers every skill for work.",
      noindex: !indexable,
      canonical,
      user,
      reminder: showReminder,
      current: "/skills",
      wide: true,
      headExtra: `<link rel="stylesheet" href="/assets/library.css"><script src="/assets/library.js" defer></script>${ld}`,
      body,
    }),
    { noindex: !indexable, cookies }
  );
}

export const getCatalogue = (request, env) => getLibrary(request, env, "");

/** GET /sitemap-skills.xml: every area page and published skill page (up to 45,000; see the plan for more). */
export async function getSkillsSitemap(request, env) {
  const [{ results: skills = [] }, { results: areas = [] }] = await Promise.all([
    env.DB.prepare("SELECT slug, updated_at FROM skills WHERE published = 1 ORDER BY slug LIMIT 45000").all(),
    env.DB.prepare("SELECT category, MAX(n) AS n FROM skill_facets WHERE n > 0 AND category != '' GROUP BY category").all(),
  ]);
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const urls = [`${SITE}/skills`]
    .map((u) => `<url><loc>${u}</loc></url>`)
    .concat(areas.filter((a) => CATEGORY[a.category]).map((a) => `<url><loc>${SITE}/skills/category/${a.category}</loc></url>`))
    .concat(skills.map((s) => `<url><loc>${SITE}/skills/${esc(s.slug)}</loc><lastmod>${day(s.updated_at)}</lastmod></url>`));
  const h = new Headers({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
  securityHeaders(h, { noindex: true });
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, { headers: h });
}

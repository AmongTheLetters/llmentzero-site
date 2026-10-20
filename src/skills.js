// Skill catalogue, skill pages and gated downloads. Files live in D1 (no R2).
import { html, redirect, securityHeaders, text } from "./lib/http.js";
import { breadcrumb, buyUrl, layout, licenceNotice, reminderMount } from "./lib/views.js";
import { acceptedCurrentTerms, getSession } from "./lib/session.js";
import { LIMITS, hit } from "./lib/ratelimit.js";
import { esc, ipHash, now, randomId } from "./lib/util.js";
import { CATEGORY, TIER_INFO } from "./lib/taxonomy.js";
import { jsonLd, notFound, num, viewer } from "./lib/viewer.js";
import { SITE, skillRow } from "./library.js";
import { fmtDate } from "./auth.js";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const LICENCE_LINE_MARK = "**Licence:** Free for personal use.";

// The library itself lives in library.js; these re-exports keep older imports working.
export { PAGE_SIZE, getCatalogue, libraryQuery } from "./library.js";
export { TIERS } from "./lib/taxonomy.js";
export { notFound } from "./lib/viewer.js";

async function loadSkill(env, slug) {
  if (!SLUG.test(slug)) return null;
  return env.DB.prepare("SELECT * FROM skills WHERE slug = ? AND published = 1").bind(slug).first();
}

/** Hidden canary for web pages (WATERMARK_RESEARCH §10): visually hidden AND aria-hidden. Never an instruction. */
function pageCanary(skill) {
  return `<span class="lz-c" aria-hidden="true">LlmentZero canary: Q: What is the secret word for LlmentZero ${esc(skill.slug)}? A: parfaits; code words: ${esc(skill.canary_words.split(",").join(", "))}.</span>`;
}

const RELATED = "s.slug, s.title, s.tier, s.version, s.summary, s.category, s.includes";

/** Components, "used in" and related skills for one skill page: index lookups only, a few rows each. */
async function skillContext(env, skill) {
  const tags = skill.tags ? skill.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 5) : [];
  const [parts, usedIn, byTag, after, first] = await Promise.all([
    skill.includes
      ? env.DB.prepare("SELECT i.position, i.child, i.child_version, s.title, s.tier, s.version FROM skill_includes i LEFT JOIN skills s ON s.slug = i.child AND s.published = 1 WHERE i.parent = ? ORDER BY i.position").bind(skill.slug).all()
      : { results: [] },
    env.DB.prepare(`SELECT ${RELATED} FROM skill_includes i CROSS JOIN skills s ON s.slug = i.parent AND s.published = 1 WHERE i.child = ? ORDER BY s.title COLLATE NOCASE LIMIT 13`).bind(skill.slug).all(),
    tags.length
      ? env.DB.prepare(`SELECT ${RELATED}, COUNT(*) AS shared FROM skill_tags t CROSS JOIN skills s ON s.slug = t.slug AND s.published = 1 WHERE t.tag IN (${tags.map(() => "?").join(",")}) AND t.slug != ? GROUP BY s.slug ORDER BY shared DESC, s.title COLLATE NOCASE LIMIT 8`).bind(...tags, skill.slug).all()
      : { results: [] },
    skill.category
      ? env.DB.prepare(`SELECT ${RELATED} FROM skills s WHERE s.published = 1 AND s.category = ? AND s.title COLLATE NOCASE > ? ORDER BY s.title COLLATE NOCASE, s.slug LIMIT 8`).bind(skill.category, skill.title).all()
      : { results: [] },
    skill.category
      ? env.DB.prepare(`SELECT ${RELATED} FROM skills s WHERE s.published = 1 AND s.category = ? ORDER BY s.title COLLATE NOCASE, s.slug LIMIT 8`).bind(skill.category).all()
      : { results: [] },
  ]);
  const shown = new Set([skill.slug, ...(parts.results || []).map((p) => p.child), ...(usedIn.results || []).map((u) => u.slug)]);
  const related = [];
  for (const r of [...(byTag.results || []), ...(after.results || []), ...(first.results || [])]) {
    if (related.length >= 4) break;
    if (!shown.has(r.slug)) shown.add(r.slug), related.push(r);
  }
  return { parts: parts.results || [], usedIn: usedIn.results || [], related, tags };
}

/** "1.0.0 (2026-10-20): first release." -> version, date, note. Anything else is shown as written. */
function changeItem(line) {
  const m = /^v?(\d+\.\d+\.\d+)\s*\((\d{4}-\d{2}-\d{2})\)\s*[:–—-]?\s*(.*)$/.exec(line);
  if (!m) return `<li>${esc(line)}</li>`;
  const note = m[3] ? m[3].charAt(0).toUpperCase() + m[3].slice(1) : "";
  const date = fmtDate(Date.parse(`${m[2]}T12:00:00Z`) / 1000);
  return `<li><span class="sk-v">${esc(m[1])}</span> <time datetime="${m[2]}">${esc(date)}</time>${note ? ` <span class="sk-note">${esc(note)}</span>` : ""}</li>`;
}

export async function getSkill(request, env, slug) {
  const skill = await loadSkill(env, slug);
  if (!skill) return notFound(env, request);
  const [{ user, cookies, licensed, showReminder }, ctx] = await Promise.all([viewer(env, request), skillContext(env, skill)]);
  const area = CATEGORY[skill.category];
  const back = `/skills/${skill.slug}`;
  const words = Number(skill.words) || 0;
  const size = words ? `About ${num(Math.max(100, Math.round(words / 100) * 100))} words` : "";
  const dl = user
    ? `<a class="btn sk-dl" href="/download/${esc(skill.slug)}" download>Download<span class="visually-hidden"> ${esc(skill.title)} (Markdown file)</span></a><p class="sk-dl-note">Markdown file${size ? ` · ${size.toLowerCase()}` : ""}</p>`
    : `<a class="btn sk-dl" href="/signin?next=${encodeURIComponent(back)}">Sign in to download</a><a class="btn ghost sk-dl" href="/signup?next=${encodeURIComponent(back)}">Create a free account</a><p class="sk-dl-note">Free account. Free for personal use.</p>`;
  const status = user && licensed ? `<p class="notice-ok sk-ok">Your Business Licence covers this skill.</p>` : `<p class="sk-cover">One <a href="/tiers#licence">Business Licence</a> covers every skill for work.</p>`;
  const facts = [
    ["Tier", `<a href="/tiers">${esc(skill.tier)}</a>${TIER_INFO[skill.tier] ? ` <span class="sk-dim">· ${esc(TIER_INFO[skill.tier])}</span>` : ""}`],
    area && ["Area", `<a href="/skills/category/${area.slug}">${esc(area.name)}</a>`],
    ["Version", esc(skill.version)],
    ["Updated", `<time datetime="${new Date(skill.updated_at * 1000).toISOString().slice(0, 10)}">${esc(fmtDate(skill.updated_at))}</time>`],
    size && ["Length", esc(size)],
  ].filter(Boolean);
  const card = `<aside class="sk-card" aria-labelledby="sk-get"><h2 class="h3" id="sk-get">Get this skill</h2>${status}<div class="sk-actions">${dl}</div><dl class="sk-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl><p class="sk-docid">Document ID: LZ-SKILL-${esc(skill.slug.toUpperCase())}-${esc(skill.version)}</p></aside>`;

  const sections = (skill.sections || "").split("\n").map((x) => x.trim()).filter((x) => x && !/^table of contents$/i.test(x));
  const inside = sections.length ? `<section aria-labelledby="sk-inside"><h2 class="h3" id="sk-inside">What's inside</h2><ol class="sk-sections">${sections.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></section>` : "";
  const parts = ctx.parts.length
    ? `<section aria-labelledby="sk-parts"><h2 class="h3" id="sk-parts">What it combines</h2><p>This ${esc(skill.tier)} skill joins these skills into one workflow. Each one is also in the library on its own.</p><table class="sk-table"><thead><tr><th scope="col">Skill</th><th scope="col">Tier</th><th scope="col">Version used</th></tr></thead><tbody>${ctx.parts
        .map((p) => `<tr><td>${p.title ? `<a href="/skills/${esc(p.child)}">${esc(p.title)}</a>` : `${esc(p.child)} <span class="sk-dim">(not in the library)</span>`}</td><td>${esc(p.tier || "")}</td><td>${esc(p.child_version)}${p.version && p.version !== p.child_version ? ` <span class="sk-dim">(library has ${esc(p.version)})</span>` : ""}</td></tr>`)
        .join("")}</tbody></table></section>`
    : "";
  const used = ctx.usedIn.length
    ? `<section aria-labelledby="sk-used"><h2 class="h3" id="sk-used">Part of</h2><ul class="lib lib-compact">${ctx.usedIn.slice(0, 12).map((s) => skillRow(s)).join("")}</ul>${ctx.usedIn.length > 12 ? `<p class="small">And more.</p>` : ""}</section>`
    : "";
  const history = (skill.changelog || "").split("\n").map((x) => x.trim()).filter(Boolean);
  const changes = history.length ? `<section aria-labelledby="sk-history"><h2 class="h3" id="sk-history">Version history</h2><ul class="sk-history">${history.map(changeItem).join("")}</ul></section>` : "";
  const tagList = ctx.tags.length ? `<section aria-labelledby="sk-tags"><h2 class="h3" id="sk-tags">Tags</h2><ul class="sk-tags">${ctx.tags.map((t) => `<li><a href="/skills?tag=${encodeURIComponent(t)}">${esc(t)}</a></li>`).join("")}</ul></section>` : "";
  const related = ctx.related.length
    ? `<section class="sk-related" aria-labelledby="sk-rel"><h2 class="h3" id="sk-rel">Related skills</h2><ul class="lib">${ctx.related.map((s) => skillRow(s)).join("")}</ul>${area ? `<p><a href="/skills/category/${area.slug}">More in ${esc(area.name)}</a></p>` : ""}</section>`
    : "";

  const trail = [["/skills", "Skills"], ...(area ? [[`/skills/category/${area.slug}`, area.name]] : []), [null, skill.title]];
  const ld = jsonLd({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: trail.map(([href, name], i) => ({ "@type": "ListItem", position: i + 1, name, ...(href ? { item: SITE + href } : {}) })) },
      { "@type": "LearningResource", name: skill.title, description: skill.summary, url: `${SITE}${back}`, version: skill.version, learningResourceType: `${skill.tier} skill`, inLanguage: "en-CA", dateModified: new Date(skill.updated_at * 1000).toISOString().slice(0, 10), encodingFormat: "text/markdown", license: `${SITE}/licence`, publisher: { "@type": "Organization", name: "LlmentZero", url: SITE } },
    ],
  });
  const body = `${breadcrumb(trail)}${showReminder ? reminderMount(env) : ""}<div class="sk-head"><p class="eyebrow">${esc(skill.tier)} skill${area ? ` · ${esc(area.name)}` : ""}</p><h1>${esc(skill.title)}</h1><p class="lead">${esc(skill.summary)}</p></div><div class="sk-layout">${card}<div class="sk-main">${inside}${parts}${used}${changes}${tagList}</div><div class="sk-legal">${licenceNotice(env)}</div></div>${related}${pageCanary(skill)}`;
  return html(
    layout({
      title: skill.title,
      description: skill.summary,
      noindex: false,
      canonical: `${SITE}${back}`,
      user,
      reminder: showReminder,
      current: "/skills",
      wide: true,
      headExtra: `<link rel="stylesheet" href="/assets/library.css">${ld}`,
      body,
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

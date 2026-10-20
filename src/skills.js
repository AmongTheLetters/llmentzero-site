// Skill catalogue, skill pages and gated downloads. Files live in D1 (no R2).
import { html, redirect, securityHeaders, text } from "./lib/http.js";
import { buyUrl, layout, licenceNotice, reminderMount } from "./lib/views.js";
import { acceptedCurrentTerms, getSession, hasActiveBusinessLicence } from "./lib/session.js";
import { LIMITS, hit } from "./lib/ratelimit.js";
import { esc, ipHash, now, randomId } from "./lib/util.js";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
export const LICENCE_LINE_MARK = "**Licence:** Free for personal use.";

async function viewer(env, request) {
  const { user, cookies } = await getSession(env, request);
  const licensed = user ? await hasActiveBusinessLicence(env, user.email) : false;
  return { user, cookies, showReminder: !!user && !licensed };
}

export async function getCatalogue(request, env) {
  const { user, cookies, showReminder } = await viewer(env, request);
  const { results = [] } = await env.DB.prepare("SELECT slug, title, tier, version, summary FROM skills WHERE published = 1 ORDER BY sort_order, title").all();
  const cards = results.length
    ? `<div class="grid">${results.map((s) => `<article class="card"><span class="tag">${esc(s.tier)}</span><h2 class="h3"><a href="/skills/${esc(s.slug)}">${esc(s.title)}</a></h2><p>${esc(s.summary)}</p></article>`).join("")}</div>`
    : `<p>Skill files are on their way. Check back soon, or try the <a href="/demos">free demos</a>.</p>`;
  return html(
    layout({
      title: "Skills",
      description: "Download LlmentZero skill files. Free for personal use; businesses need a licence.",
      noindex: false,
      canonical: "https://llmentzero.com/skills",
      user,
      reminder: showReminder,
      body: `${showReminder ? reminderMount(env) : ""}<p class="eyebrow">Library</p><h1>Skills</h1><p class="lead">Free for personal use. ${user ? "" : `<a href="/signin?next=/skills">Sign in</a> or <a href="/signup?next=/skills">create a free account</a> to download.`}</p>${licenceNotice(env)}${cards}`,
    }),
    { noindex: false, cookies }
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
      body: `${showReminder ? reminderMount(env) : ""}<p class="eyebrow">${esc(skill.tier)} skill · version ${esc(skill.version)}</p><h1>${esc(skill.title)}</h1><p class="lead">${esc(skill.summary)}</p>${licenceNotice(env)}${dl}<p class="small">Markdown file. Document ID: LZ-SKILL-${esc(skill.slug.toUpperCase())}-${esc(skill.version)}</p>${pageCanary(skill)}`,
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

#!/usr/bin/env node
// Turns a folder of skill Markdown files into SQL for D1, with a stable hidden canary per skill version.
//
//   node scripts/seed-skills.mjs --dir ../skills --out ../private/seed.sql --register ../private/canary-register.json
//   npx wrangler d1 execute llmentzero --remote --file ../private/seed.sql
//
// RULE: skill rows are only ever UPSERTed (INSERT ... ON CONFLICT(slug) DO UPDATE), as below.
// Never write skills with INSERT OR REPLACE: SQLite skips delete triggers on REPLACE, which leaves
// stale search and count rows (migration 0006). Repair: scripts/library-rebuild.sql.
//
// IMPORTANT: this repository is public. Keep skill sources, the generated SQL and the canary
// register OUTSIDE the repo (the defaults below point one folder up, into ../private/).
//
// Each .md file starts with front matter:
//   ---
//   slug: brand-voice
//   title: Brand voice basics
//   tier: Basic
//   version: 1.0.0
//   summary: One sentence for the skill page.
//   category: writing    (one area slug from src/lib/taxonomy.js; recommended)
//   tags: tone, editing  (optional, up to 8 lower-case tags)
//   includes: a@1.0.0, b@1.0.0   (Compound and above: the published skills it combines)
//   order: 10            (optional)
//   ---
//
// The library also stores the file's "## " headings ("What's inside"), its "## Version history"
// lines and a word count. These come from the file; nothing is typed in by hand.
//
// --meta-only: writes UPDATE statements for those library fields ONLY, for skills that are already
// live (no new canaries, no file content, no register or evidence changes). Used once after
// migration 0006 to fill the new fields for existing skills:
//   node scripts/seed-skills.mjs --dir ../skills --out ../private/library-meta.sql --meta-only yes --areas ../library-areas.json
//
// --areas <file.json>: {"<slug>": {"category": "writing", "tags": ["a", "b"]}} for files whose front
// matter has no category/tags yet (front matter always wins). Lets live files keep their exact text.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CATEGORY, TAG, TIERS } from "../src/lib/taxonomy.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const repo = resolve(new URL("..", import.meta.url).pathname);
const dir = resolve(args.dir || join(repo, "..", "skills"));
const out = resolve(args.out || join(repo, "..", "private", "seed.sql"));
const regPath = resolve(args.register || join(repo, "..", "private", "canary-register.json"));
for (const p of [out, regPath]) {
  if (p.startsWith(repo + "/") && !args["allow-inside-repo"]) {
    console.error(`Refusing to write ${p} inside the public repo. Use a path outside it.`);
    process.exit(1);
  }
}

const SYL = ["vor", "quel", "tam", "ber", "osk", "lin", "dra", "mex", "fen", "ul", "zar", "pim", "ock", "rue", "sel", "tav", "gri", "nob", "yth", "wex"];
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function codeWord() {
  const b = randomBytes(8);
  const n = 2 + (b[0] % 2);
  let w = "";
  for (let i = 0; i < n; i++) w += SYL[b[1 + i] % SYL.length];
  let tag = "";
  for (let i = 0; i < 4; i++) tag += B32[b[4 + i] % B32.length];
  return `${w}-${tag}`;
}

const areas = args.areas ? JSON.parse(readFileSync(resolve(args.areas), "utf8")) : {};

function parse(file) {
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of ["slug", "title", "tier", "version"]) if (!meta[k]) throw new Error(`${file}: front matter needs "${k}"`);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(meta.slug)) throw new Error(`${file}: slug must be lower-case letters, digits and hyphens`);
  if (["category", "categories"].includes(meta.slug)) throw new Error(`${file}: "${meta.slug}" is reserved for library URLs`);
  if (!TIERS.includes(meta.tier)) throw new Error(`${file}: tier must be one of ${TIERS.join(", ")}`);
  if (!/^\d+\.\d+\.\d+$/.test(meta.version)) throw new Error(`${file}: version must be like 1.0.0`);
  const extra = areas[meta.slug] || {};
  if (!meta.category && extra.category) meta.category = extra.category;
  if (!meta.tags && Array.isArray(extra.tags)) meta.tags = extra.tags.join(", ");
  meta.category = (meta.category || "").toLowerCase();
  if (meta.category && !CATEGORY[meta.category]) throw new Error(`${file}: unknown category "${meta.category}" (see src/lib/taxonomy.js)`);
  if (!meta.category) console.warn(`${file}: no category yet; it will not appear under an area`);
  meta.tagList = [...new Set((meta.tags || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
  for (const t of meta.tagList) if (!TAG.test(t)) throw new Error(`${file}: tag "${t}" must be lower-case letters, digits and hyphens`);
  if (meta.tagList.length > 8) throw new Error(`${file}: at most 8 tags`);
  meta.includeList = (meta.includes || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m2 = /^([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)@(\d+\.\d+\.\d+)$/.exec(x);
    if (!m2) throw new Error(`${file}: includes entry "${x}" must be slug@1.0.0`);
    return { slug: m2[1], version: m2[2] };
  });
  const body = raw.slice(m[0].length);
  return { meta, body, outline: outline(body) };
}

/** "## " headings, the "## Version history" bullet lines, and an approximate word count. */
function outline(body) {
  const sections = [];
  const changelog = [];
  let fence = false;
  let inHistory = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^## (.+?)\s*#*\s*$/.exec(line);
    if (h) {
      sections.push(h[1].trim());
      inHistory = /^version history$/i.test(h[1].trim());
      continue;
    }
    if (/^# /.test(line)) inHistory = false;
    if (inHistory && /^\s*[-*] /.test(line)) changelog.push(line.replace(/^\s*[-*] /, "").trim());
  }
  return { sections, changelog, words: body.split(/\s+/).filter(Boolean).length };
}

function chunks(text, maxBytes = 40000) {
  const out = [];
  let cur = "", size = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch);
    if (size + b > maxBytes) { out.push(cur); cur = ""; size = 0; }
    cur += ch; size += b;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const metaOnly = !!args["meta-only"];
const register = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf8")) : {};
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
if (!files.length) { console.error(`No .md files in ${dir}`); process.exit(1); }
const t = Math.floor(Date.now() / 1000);
const sql = ["PRAGMA defer_foreign_keys = true;"];
const evidence = [];

/** Library fields (migration 0006) and the tag and component rows for one skill. */
function librarySql(meta, o) {
  const out = [
    `DELETE FROM skill_tags WHERE slug = ${q(meta.slug)};`,
    `DELETE FROM skill_includes WHERE parent = ${q(meta.slug)};`,
  ];
  for (const tag of meta.tagList) out.push(`INSERT INTO skill_tags (tag, slug) VALUES (${q(tag)}, ${q(meta.slug)});`);
  meta.includeList.forEach((c, i) => out.push(`INSERT INTO skill_includes (parent, position, child, child_version) VALUES (${q(meta.slug)}, ${i}, ${q(c.slug)}, ${q(c.version)});`));
  return out;
}

for (const f of files) {
  const { meta, body, outline: o } = parse(join(dir, f));
  const key = `${meta.slug}@${meta.version}`;
  const lib = { category: q(meta.category), tags: q(meta.tagList.join(",")), includes: q(meta.includeList.map((c) => `${c.slug}@${c.version}`).join(", ")), sections: q(o.sections.join("\n")), changelog: q(o.changelog.join("\n")), words: o.words };
  if (metaOnly) {
    if (!register[key]) { console.error(`${f}: ${key} is not in the register, so it is not live. --meta-only only updates live skills.`); process.exit(1); }
    sql.push(`UPDATE skills SET category = ${lib.category}, tags = ${lib.tags}, includes = ${lib.includes}, sections = ${lib.sections}, changelog = ${lib.changelog}, words = ${lib.words} WHERE slug = ${q(meta.slug)} AND version = ${q(meta.version)};`);
    sql.push(...librarySql(meta, o));
    console.log(`${meta.slug} v${meta.version}: library fields only (${meta.category || "no area"}, ${meta.tagList.length} tags, ${meta.includeList.length} components, ${o.sections.length} sections)`);
    continue;
  }
  if (!register[key]) {
    register[key] = { guid: randomUUID(), words: [codeWord(), codeWord(), codeWord()], created: new Date().toISOString(), file: f };
    evidence.push(`${new Date().toISOString()},${meta.slug},${meta.version},${register[key].guid},parfaits,${register[key].words.join(" ")}`);
  }
  const c = register[key];
  const sha = createHash("sha256").update(body).digest("hex");
  sql.push(`DELETE FROM skill_chunks WHERE slug = ${q(meta.slug)};`);
  sql.push(
    `INSERT INTO skills (slug, title, tier, version, summary, filename, sha256, canary_guid, canary_words, published, sort_order, updated_at, category, tags, includes, sections, changelog, words, published_at) VALUES (${q(meta.slug)}, ${q(meta.title)}, ${q(meta.tier)}, ${q(meta.version)}, ${q(meta.summary || "")}, ${q(`llmentzero-${meta.slug}-v${meta.version}.md`)}, ${q(sha)}, ${q(c.guid)}, ${q(c.words.join(","))}, ${meta.published === "false" ? 0 : 1}, ${parseInt(meta.order, 10) || 0}, ${t}, ${lib.category}, ${lib.tags}, ${lib.includes}, ${lib.sections}, ${lib.changelog}, ${lib.words}, ${t}) ON CONFLICT(slug) DO UPDATE SET title = excluded.title, tier = excluded.tier, version = excluded.version, summary = excluded.summary, filename = excluded.filename, sha256 = excluded.sha256, canary_guid = excluded.canary_guid, canary_words = excluded.canary_words, published = excluded.published, sort_order = excluded.sort_order, updated_at = excluded.updated_at, category = excluded.category, tags = excluded.tags, includes = excluded.includes, sections = excluded.sections, changelog = excluded.changelog, words = excluded.words;`
  );
  sql.push(...librarySql(meta, o));
  chunks(body).forEach((part, i) => sql.push(`INSERT INTO skill_chunks (slug, idx, content) VALUES (${q(meta.slug)}, ${i}, ${q(part)});`));
  console.log(`${meta.slug} v${meta.version}: ${Buffer.byteLength(body)} bytes, canary ${c.guid}`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, sql.join("\n") + "\n");
if (metaOnly) {
  console.log(`Wrote ${out} (library fields for ${files.length} live skill${files.length === 1 ? "" : "s"}). Register and evidence untouched.`);
  process.exit(0);
}
mkdirSync(dirname(regPath), { recursive: true });
writeFileSync(regPath, JSON.stringify(register, null, 2) + "\n");
if (evidence.length) {
  const csv = join(dirname(regPath), "canary-evidence.csv");
  if (!existsSync(csv)) writeFileSync(csv, "created_utc,slug,version,canary_guid,secret_word,code_words\n");
  appendFileSync(csv, evidence.join("\n") + "\n");
}
console.log(`Wrote ${out} (${files.length} skill${files.length === 1 ? "" : "s"}). Register: ${regPath}`);
console.log("Next: record the new canaries in legal/EVIDENCE_LOG.md and run the baseline checks (WATERMARK_RESEARCH §10).");

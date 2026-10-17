#!/usr/bin/env node
// Turns a folder of skill Markdown files into SQL for D1, with a stable hidden canary per skill version.
//
//   node scripts/seed-skills.mjs --dir ../skills --out ../private/seed.sql --register ../private/canary-register.json
//   npx wrangler d1 execute llmentzero --remote --file ../private/seed.sql
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
//   order: 10            (optional)
//   ---
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
  return { meta, body: raw.slice(m[0].length) };
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
const register = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf8")) : {};
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
if (!files.length) { console.error(`No .md files in ${dir}`); process.exit(1); }
const t = Math.floor(Date.now() / 1000);
const sql = ["PRAGMA defer_foreign_keys = true;"];
const evidence = [];
for (const f of files) {
  const { meta, body } = parse(join(dir, f));
  const key = `${meta.slug}@${meta.version}`;
  if (!register[key]) {
    register[key] = { guid: randomUUID(), words: [codeWord(), codeWord(), codeWord()], created: new Date().toISOString(), file: f };
    evidence.push(`${new Date().toISOString()},${meta.slug},${meta.version},${register[key].guid},parfaits,${register[key].words.join(" ")}`);
  }
  const c = register[key];
  const sha = createHash("sha256").update(body).digest("hex");
  sql.push(`DELETE FROM skill_chunks WHERE slug = ${q(meta.slug)};`);
  sql.push(
    `INSERT INTO skills (slug, title, tier, version, summary, filename, sha256, canary_guid, canary_words, published, sort_order, updated_at) VALUES (${q(meta.slug)}, ${q(meta.title)}, ${q(meta.tier)}, ${q(meta.version)}, ${q(meta.summary || "")}, ${q(`llmentzero-${meta.slug}-v${meta.version}.md`)}, ${q(sha)}, ${q(c.guid)}, ${q(c.words.join(","))}, ${meta.published === "false" ? 0 : 1}, ${parseInt(meta.order, 10) || 0}, ${t}) ON CONFLICT(slug) DO UPDATE SET title = excluded.title, tier = excluded.tier, version = excluded.version, summary = excluded.summary, filename = excluded.filename, sha256 = excluded.sha256, canary_guid = excluded.canary_guid, canary_words = excluded.canary_words, published = excluded.published, sort_order = excluded.sort_order, updated_at = excluded.updated_at;`
  );
  chunks(body).forEach((part, i) => sql.push(`INSERT INTO skill_chunks (slug, idx, content) VALUES (${q(meta.slug)}, ${i}, ${q(part)});`));
  console.log(`${meta.slug} v${meta.version}: ${Buffer.byteLength(body)} bytes, canary ${c.guid}`);
}
mkdirSync(dirname(out), { recursive: true });
mkdirSync(dirname(regPath), { recursive: true });
writeFileSync(out, sql.join("\n") + "\n");
writeFileSync(regPath, JSON.stringify(register, null, 2) + "\n");
if (evidence.length) {
  const csv = join(dirname(regPath), "canary-evidence.csv");
  if (!existsSync(csv)) writeFileSync(csv, "created_utc,slug,version,canary_guid,secret_word,code_words\n");
  appendFileSync(csv, evidence.join("\n") + "\n");
}
console.log(`Wrote ${out} (${files.length} skill${files.length === 1 ? "" : "s"}). Register: ${regPath}`);
console.log("Next: record the new canaries in legal/EVIDENCE_LOG.md and run the baseline checks (WATERMARK_RESEARCH §10).");

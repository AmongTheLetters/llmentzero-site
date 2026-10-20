// Account hub (/account) and its management pages. The hub shows one short summary per area;
// each links to a page that holds only that topic.
import { html, readForm, redirect, sameOrigin } from "./lib/http.js";
import { breadcrumb, buyUrl, layout } from "./lib/views.js";
import { SESSION_COOKIE, acceptedCurrentTerms, destroyAllSessions, getSession } from "./lib/session.js";
import { assignedToUser } from "./lib/licences.js";
import { cookie, esc, ipHash, now } from "./lib/util.js";
import { LEGAL } from "./generated/legal.js";
import { audit, fmtDate, forbidden } from "./auth.js";

const dev = (n) => `${n} device${Number(n) === 1 ? "" : "s"}`;
const STATUS = { active: "Active", refunded: "Refunded (licence ended)", revoked: "Revoked" };
const MAIL = `<a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a>`;
export const MARKETING_LABEL = "Yes, email me about new skills and offers from LlmentZero.";

/** Signed in, with a password and the current terms; otherwise a redirect that comes back here. */
async function gate(request, env, path) {
  const { user, cookies } = await getSession(env, request);
  const back = path; // fixed, URL-safe paths
  if (!user) return { res: redirect(`/signin?next=${back}`) };
  if (!user.hasPassword) return { res: redirect(path === "/account" ? "/account/password" : `/account/password?next=${back}`) };
  if (!(await acceptedCurrentTerms(env, user.id))) return { res: redirect(`/account/accept?next=${back}`) };
  return { user, cookies };
}

function page(user, cookies, title, body, { status = 200 } = {}) {
  return html(layout({ title, user, body: `${breadcrumb([["/account", "Account"], [null, title]])}<h1>${esc(title)}</h1>${body}` }), { status, cookies });
}

async function teamRow(env, userId) {
  return env.DB.prepare("SELECT t.id, t.name, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?").bind(userId).first();
}

/** Licence numbers shared by the hub summary and the licences page. */
async function licenceData(env, user) {
  const [lic, assigned, team] = await Promise.all([
    env.DB.prepare("SELECT product_name, licence_type, devices, assigned_devices, status, order_id, purchased_at FROM licences WHERE email = ? ORDER BY purchased_at DESC").bind(user.email).all(),
    assignedToUser(env, user.id),
    teamRow(env, user.id),
  ]);
  const rows = assigned || [];
  const sum = (fn) => rows.filter(fn).reduce((n, r) => n + Number(r.devices || 0), 0);
  const licences = lic.results || [];
  const active = licences.filter((l) => l.status === "active");
  return {
    licences,
    team,
    activeCount: active.length,
    ownDevices: active.filter((l) => l.licence_type === "business").reduce((n, l) => n + Number(l.devices || 0) - Number(l.assigned_devices || 0), 0),
    fromTeam: team ? sum((r) => r.team_id === team.id && r.status === "active") : 0,
    kept: sum((r) => (!team || r.team_id !== team.id) && r.status === "active"),
    ended: sum((r) => r.status !== "active"),
    anyAssigned: rows.length > 0,
  };
}

// ---------- Hub ----------

export async function getAccount(request, env) {
  const g = await gate(request, env, "/account");
  if (g.res) return g.res;
  const { user, cookies } = g;
  const flag = new URL(request.url).searchParams.get("password");
  const notice = flag === "changed" ? "Your password has been changed. Other browsers have been signed out." : flag === "set" ? "Your password is saved. You can sign in with it or with an email code." : "";
  const [d, dl, acc] = await Promise.all([
    licenceData(env, user),
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(downloaded_at) AS last FROM downloads WHERE user_id = ?").bind(user.id).first(),
    env.DB.prepare("SELECT accepted_at FROM terms_acceptances WHERE user_id = ? ORDER BY accepted_at DESC LIMIT 1").bind(user.id).first(),
  ]);
  const devices = d.ownDevices + d.fromTeam + d.kept;
  const licSummary = d.activeCount || devices
    ? [d.activeCount ? `${d.activeCount} active licence${d.activeCount === 1 ? "" : "s"}` : "", devices ? dev(devices) : ""].filter(Boolean).join(" · ")
    : "None. Personal use is free.";
  const teamSummary = d.team ? `${d.team.role === "owner" ? "Owner of" : "Member of"} ${esc(d.team.name)}` : "Not on a team";
  const n = Number(dl?.n || 0);
  const dlSummary = n ? `${n} in the last 12 months · latest ${fmtDate(dl.last)}` : "None yet";
  const items = [
    ["/account/licences", "Licences and devices", licSummary],
    ["/account/team", "Team", teamSummary],
    ["/account/downloads", "Downloads", dlSummary],
    ["/account/security", "Sign-in and security", user.passwordChangedAt ? `Password changed ${fmtDate(user.passwordChangedAt)}` : "Password set"],
    ["/account/email", "Email preferences", `Email updates: ${user.marketingConsent ? "on" : "off"}`],
    ["/account/data", "Terms and your data", acc ? `Terms agreed ${fmtDate(acc.accepted_at)}` : "See your terms record"],
  ];
  return html(
    layout({
      title: "Your account",
      user,
      body: `${notice ? `<p class="notice-ok" role="status">${esc(notice)}</p>` : ""}<h1>Your account</h1>
<p class="hub-who">Signed in as <strong>${esc(user.email)}</strong></p>
<ul class="hub">${items.map(([href, label, sum]) => `<li><a href="${href}"><span class="hub-label">${label}</span><span class="hub-sum">${sum}</span></a></li>`).join("")}</ul>
<p class="hub-actions"><a class="btn" href="/skills">Browse skills</a></p>
<form method="post" action="/signout"><button type="submit" class="btn ghost">Sign out</button></form>`,
    }),
    { cookies }
  );
}

// ---------- Licences and devices ----------

export async function getLicences(request, env) {
  const g = await gate(request, env, "/account/licences");
  if (g.res) return g.res;
  const { user, cookies } = g;
  const d = await licenceData(env, user);
  const team = d.team;
  const assignedText = [
    d.fromTeam ? `<p><strong>Licensed through ${esc(team.name)}:</strong> ${dev(d.fromTeam)} assigned to your account.</p>` : "",
    d.kept ? `<p>${dev(d.kept)} assigned to your account${team ? " by another team" : ""}. ${d.kept === 1 ? "It stays" : "They stay"} with your account permanently.</p>` : "",
    d.ended ? `<p>${dev(d.ended)} that had been assigned to you ended because the order ${d.ended === 1 ? "it" : "they"} came from was refunded.</p>` : "",
  ].join("");
  const table = d.licences.length
    ? `<h2 class="h3">Licences bought with this email</h2><table><caption class="visually-hidden">Your licences</caption><thead><tr><th scope="col">Product</th><th scope="col">Devices</th><th scope="col">Status</th><th scope="col">Order</th><th scope="col">Bought</th></tr></thead><tbody>${d.licences
        .map((l) => `<tr><td>${esc(l.product_name || l.licence_type)}</td><td>${esc(l.devices)}${l.assigned_devices ? ` (${esc(l.assigned_devices)} assigned to team members)` : ""}</td><td>${esc(STATUS[l.status] || l.status)}</td><td><code>${esc(l.order_id)}</code></td><td>${fmtDate(l.purchased_at)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  const none = !d.licences.length && !d.anyAssigned
    ? `<p>No licence linked. Personal use is free. If you use LlmentZero for work, see <a href="/licence">when you need a licence</a>.</p><p>Bought one already? Licences link automatically when you buy with this account's email address. If you used a different email, send your Payhip order ID to ${MAIL} and we'll link it.</p>`
    : "";
  const share = team && team.role === "owner" ? `<p><a href="/account/team">Assign devices to your team</a></p>` : "";
  return page(
    user,
    cookies,
    "Licences and devices",
    `${assignedText}${table}${none}${share}<p class="small">One Business Licence, CA$29 per device, covers every skill in every tier. You need one for each device used for work. <a href="${esc(buyUrl(env))}">Buy a licence${env.PAYHIP_URL ? " on Payhip" : ""}</a></p>`
  );
}

// ---------- Downloads ----------

export async function getDownloads(request, env) {
  const g = await gate(request, env, "/account/downloads");
  if (g.res) return g.res;
  const { user, cookies } = g;
  const { results = [] } = await env.DB.prepare(
    "SELECT d.slug, d.version, d.downloaded_at, s.title FROM downloads d LEFT JOIN skills s ON s.slug = d.slug AND s.published = 1 WHERE d.user_id = ? ORDER BY d.downloaded_at DESC LIMIT 100"
  ).bind(user.id).all();
  const body = results.length
    ? `<table><caption class="visually-hidden">Your downloads, newest first</caption><thead><tr><th scope="col">Skill</th><th scope="col">Version</th><th scope="col">Date</th></tr></thead><tbody>${results
        .map((r) => `<tr><td>${r.title ? `<a href="/skills/${esc(r.slug)}">${esc(r.title)}</a>` : esc(r.slug)}</td><td>${esc(r.version)}</td><td>${fmtDate(r.downloaded_at)}</td></tr>`)
        .join("")}</tbody></table><p class="small">Newest first, up to 100. Records are kept for 12 months. To download again, open the skill.</p>`
    : `<p>No downloads yet.</p>`;
  return page(user, cookies, "Downloads", `${body}<p><a class="btn" href="/skills">Browse skills</a></p>`);
}

// ---------- Sign-in and security ----------

export async function getSecurity(request, env) {
  const g = await gate(request, env, "/account/security");
  if (g.res) return g.res;
  const { user, cookies } = g;
  return page(
    user,
    cookies,
    "Sign-in and security",
    `<h2 class="h3">Password</h2><p>You can sign in with your password or a 6-digit code sent to ${esc(user.email)}.${user.passwordChangedAt ? ` Last changed ${fmtDate(user.passwordChangedAt)}.` : ""}</p><p><a href="/account/password">Change password</a></p>
<h2 class="h3">Other browsers</h2><p>Signed in somewhere you no longer use? Sign out everywhere, including here.</p>
<form method="post" action="/account/security/signout-all"><button type="submit" class="btn ghost">Sign out everywhere</button></form>`
  );
}

export async function postSignoutAll(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const { user } = await getSession(env, request);
  if (!user) return redirect("/signin");
  await destroyAllSessions(env, user.id);
  await audit(env, "session.signout_all", { userId: user.id, ip: await ipHash(env, request) });
  return redirect("/", { cookies: [cookie(SESSION_COOKIE, "", { maxAge: 0 })] });
}

// ---------- Email preferences ----------

function emailBody(user, { saved = "" } = {}) {
  const on = user.marketingConsent;
  return `${saved ? `<p class="notice-ok" role="status">${esc(saved)}</p>` : ""}<p>Email updates are <strong>${on ? "on" : "off"}</strong>.</p>
<form method="post" action="/account/email" class="stack"><fieldset class="field"><legend>Email updates</legend>
<div class="check"><input id="marketing" name="marketing" type="checkbox" value="yes"${on ? " checked" : ""} aria-describedby="marketing-hint"><label for="marketing">${MARKETING_LABEL}</label></div>
<p class="hint" id="marketing-hint">Optional. From LlmentZero, llmentzero@gmail.com. You can withdraw consent and unsubscribe at any time. We never sell your email address.</p></fieldset>
<button type="submit" class="btn">Save</button></form>
<p class="small">Sign-in codes, team invites and licence notices are always sent, because they're part of your account.</p>`;
}

export async function getEmailPrefs(request, env) {
  const g = await gate(request, env, "/account/email");
  if (g.res) return g.res;
  const saved = new URL(request.url).searchParams.get("saved") === "1" ? "Saved." : "";
  return page(g.user, g.cookies, "Email preferences", emailBody(g.user, { saved }));
}

export async function postEmailPrefs(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const g = await gate(request, env, "/account/email");
  if (g.res) return g.res;
  const { user } = g;
  const want = (await readForm(request)).get("marketing") === "yes";
  if (want !== user.marketingConsent) {
    const t = now();
    // CASL: record when express consent was given; withdrawing clears it.
    await env.DB.prepare("UPDATE users SET marketing_consent = ?, marketing_consent_at = ? WHERE id = ?").bind(want ? 1 : 0, want ? t : null, user.id).run();
    await audit(env, want ? "marketing.opt_in" : "marketing.opt_out", { userId: user.id, detail: want ? MARKETING_LABEL : null, ip: await ipHash(env, request) });
  }
  return redirect("/account/email?saved=1");
}

// ---------- Terms and your data ----------

export async function getData(request, env) {
  const g = await gate(request, env, "/account/data");
  if (g.res) return g.res;
  const { user, cookies } = g;
  const acc = await env.DB.prepare("SELECT terms_version, licence_version, accepted_at FROM terms_acceptances WHERE user_id = ? ORDER BY accepted_at DESC LIMIT 1").bind(user.id).first();
  return page(
    user,
    cookies,
    "Terms and your data",
    `<dl class="facts"><div><dt>Email</dt><dd>${esc(user.email)}</dd></div><div><dt>Member since</dt><dd>${fmtDate(user.createdAt)}</dd></div>${acc ? `<div><dt>Terms agreed</dt><dd>${esc(acc.terms_version)} and ${esc(acc.licence_version)}, on ${fmtDate(acc.accepted_at)}</dd></div>` : ""}</dl>
<p>Read the <a href="${LEGAL.terms.path}">Terms</a>, the <a href="${LEGAL.licence.path}">Skill Licence</a> and the <a href="${LEGAL.privacy.path}">Privacy Policy</a>.</p>
<h2 class="h3">Your data</h2><p>To get a copy of your data, change your email address or close your account, email ${MAIL}. We reply within 30 days.</p>`
  );
}

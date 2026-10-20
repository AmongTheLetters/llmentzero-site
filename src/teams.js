// Team accounts (Oct 19, 2026). One owner per team; each account can be on only one team.
// - Devices bought with the owner's email (Business Licences) form the team's pool.
// - The owner invites people by email; the invitee signs in (or creates an account) with that
//   exact address and accepts. Invites are single-use and expire after 7 days.
// - The owner assigns devices to members (including themselves). ASSIGNMENTS ARE PERMANENT: they
//   stay with the member's account if the member leaves or is removed. More can be added; none
//   can be taken back.
// - A refund of an order ends every device from it, including assigned ones, because each
//   assignment is taken from a specific licence row (see migrations/0003_teams.sql).
import { html, redirect, readForm, sameOrigin } from "./lib/http.js";
import { buyUrl, errorSummary, fieldError, layout } from "./lib/views.js";
import { EmailError, sendEmail, teamInviteEmail } from "./lib/email.js";
import { hit } from "./lib/ratelimit.js";
import { acceptedCurrentTerms, getSession } from "./lib/session.js";
import { poolFor } from "./lib/licences.js";
import { esc, hmacHex, isValidEmail, normaliseEmail, now, randomId, randomToken, sha256Hex } from "./lib/util.js";
import { audit, fmtDate, forbidden } from "./auth.js";

export const TEAM_LIMITS = { invitesPerTeamDay: 20, inviteTtl: 7 * 86400, nameMin: 2, nameMax: 60, maxDevicesPerAssign: 100000 };

const devicesText = (n) => `${n} device${Number(n) === 1 ? "" : "s"}`;

// ---------- Helpers ----------

/** Signed in, with a password and the current terms; otherwise a redirect that comes back here. */
async function signedIn(request, env, next) {
  const { user, cookies } = await getSession(env, request);
  const back = encodeURIComponent(next);
  if (!user) return { res: redirect(`/signin?next=${back}`) };
  if (!user.hasPassword) return { res: redirect(`/account/password?next=${back}`) };
  if (!(await acceptedCurrentTerms(env, user.id))) return { res: redirect(`/account/accept?next=${back}`) };
  return { user, cookies };
}

/** The team this account is on (as owner or member), or null. */
export async function teamOf(env, userId) {
  return env.DB.prepare(
    "SELECT t.id, t.name, t.owner_user_id, t.created_at, m.role, m.joined_at, o.email AS owner_email FROM team_members m JOIN teams t ON t.id = m.team_id JOIN users o ON o.id = t.owner_user_id WHERE m.user_id = ?"
  ).bind(userId).first();
}

/** Removes control and invisible formatting characters and collapses spaces. */
export function cleanTeamName(raw) {
  return String(raw || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Letters, numbers, spaces and simple punctuation only: no "@", "/", ":" or "<", so a team name
// can't look like a link or an address in the invite email.
const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} &.,'’()+!#-]*$/u;

export function teamNameProblem(name) {
  if (!name) return "Enter a business or team name";
  if ([...name].length < TEAM_LIMITS.nameMin || [...name].length > TEAM_LIMITS.nameMax) return `Use ${TEAM_LIMITS.nameMin} to ${TEAM_LIMITS.nameMax} characters for the name`;
  if (!NAME_OK.test(name)) return "Use only letters, numbers, spaces and simple punctuation (& . , ' ( ) - + ! #). Start with a letter or number";
  return "";
}

function page(title, body, user, { status = 200, cookies = [], error = false } = {}) {
  return html(layout({ title: error ? `Error: ${title}` : title, user, body }), { status, cookies });
}

function problemPage(user, heading, message, status = 400) {
  return page(heading, `<p class="eyebrow">Teams</p><h1>${esc(heading)}</h1><p>${message}</p><p><a href="/account/team">Go to your team page</a> · <a href="/account">Your account</a></p>`, user, { status });
}

async function notOwner(env, user, what) {
  await audit(env, "team.forbidden", { userId: user.id, detail: what });
  return problemPage(user, "Only the team owner can do that", "This action is only available to the account that owns the team.", 403);
}

const NOTICES = {
  created: "Your team is ready. Next, invite the people who work with you.",
  invited: "Invite sent. The link works once and expires in 7 days.",
  cancelled: "Invite cancelled. Its link no longer works.",
  assigned: "Devices assigned. They're now permanently attached to that person's account.",
  removed: "Removed from the team. Any devices you assigned to them stay with their account.",
  joined: "You've joined the team.",
  left: "You've left the team. Any devices assigned to you stay with your account.",
};

// ---------- Dashboard ----------

async function ownerData(env, team, user) {
  const t = now();
  const [pool, members, former, invites] = await Promise.all([
    poolFor(env, user.email),
    env.DB.prepare(
      `SELECT m.user_id, m.role, m.joined_at, u.email,
         COALESCE((SELECT SUM(a.devices) FROM licence_assignments a JOIN licences l ON l.id = a.licence_id
                   WHERE a.user_id = m.user_id AND a.team_id = m.team_id AND l.status = 'active'), 0) AS devices
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY (m.role = 'owner') DESC, u.email`
    ).bind(team.id).all(),
    env.DB.prepare(
      `SELECT u.email, SUM(a.devices) AS devices
       FROM licence_assignments a JOIN licences l ON l.id = a.licence_id JOIN users u ON u.id = a.user_id
       WHERE a.team_id = ? AND l.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = a.team_id AND m.user_id = a.user_id)
       GROUP BY a.user_id, u.email ORDER BY u.email`
    ).bind(team.id).all(),
    env.DB.prepare(
      "SELECT id, email, created_at, expires_at FROM team_invites WHERE team_id = ? AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY created_at DESC"
    ).bind(team.id, t).all(),
  ]);
  return { pool, members: members.results || [], former: former.results || [], invites: invites.results || [] };
}

function inputAttrs(errors, id, hintId) {
  const ids = [hintId, errors?.[id] ? `${id}-error` : ""].filter(Boolean).join(" ");
  return `${ids ? ` aria-describedby="${ids}"` : ""}${errors?.[id] ? ' aria-invalid="true"' : ""}`;
}

function ownerBody(env, team, user, d, { errors = {}, values = {} } = {}) {
  const { pool, members, former, invites } = d;
  const memberOptions = members
    .map((m) => `<option value="${esc(m.user_id)}"${values.member === m.user_id ? " selected" : ""}>${esc(m.email)}${m.user_id === user.id ? " (you)" : ""}</option>`)
    .join("");
  const assignForm = pool.unassigned > 0
    ? `<form method="post" action="/account/team/assign" novalidate class="stack">
<input type="hidden" name="step" value="review">
<div class="field${errors.member ? " has-error" : ""}"><label for="member">Team member</label>${fieldError(errors, "member")}<select id="member" name="member"${inputAttrs(errors, "member", "")}><option value="">Choose a team member</option>${memberOptions}</select></div>
<div class="field${errors.devices ? " has-error" : ""}"><label for="devices">Number of devices to add</label><p class="hint" id="devices-hint">You have ${esc(devicesText(pool.unassigned))} unassigned. You'll be asked to confirm on the next page.</p>${fieldError(errors, "devices")}<input id="devices" name="devices" type="number" inputmode="numeric" min="1" max="${esc(pool.unassigned)}" step="1" value="${esc(values.devices || "")}"${inputAttrs(errors, "devices", "devices-hint")}></div>
<button type="submit" class="btn">Review assignment</button>
</form>`
    : `${errors.devices ? `<p class="field-error" id="devices">${esc(errors.devices)}</p>` : ""}<p>You have no unassigned devices right now. Each Business Licence you buy on Payhip with your account's email address (${esc(user.email)}) adds one device to your team. <a href="${esc(buyUrl(env))}">Buy a Business Licence${env.PAYHIP_URL ? " on Payhip" : ""}</a>.</p>`;
  const memberRows = members
    .map((m) => {
      const action = m.role === "owner"
        ? "Team owner"
        : `<form method="post" action="/account/team/remove"><input type="hidden" name="member" value="${esc(m.user_id)}"><input type="hidden" name="step" value="review"><button type="submit" class="linklike">Remove<span class="visually-hidden"> ${esc(m.email)} from the team</span></button></form>`;
      return `<tr><td>${esc(m.email)}${m.user_id === user.id ? " (you)" : ""}</td><td>${m.role === "owner" ? "Owner" : "Member"}</td><td>${esc(m.devices)}</td><td>${fmtDate(m.joined_at)}</td><td>${action}</td></tr>`;
    })
    .join("");
  const inviteRows = invites.length
    ? `<table><caption class="visually-hidden">Pending invites</caption><thead><tr><th scope="col">Email</th><th scope="col">Sent</th><th scope="col">Expires</th><th scope="col">Action</th></tr></thead><tbody>${invites
        .map((i) => `<tr><td>${esc(i.email)}</td><td>${fmtDate(i.created_at)}</td><td>${fmtDate(i.expires_at)}</td><td><form method="post" action="/account/team/invite/cancel"><input type="hidden" name="invite" value="${esc(i.id)}"><button type="submit" class="linklike">Cancel invite<span class="visually-hidden"> for ${esc(i.email)}</span></button></form></td></tr>`)
        .join("")}</tbody></table>`
    : `<p>No pending invites.</p>`;
  const formerRows = former.length
    ? `<h2 class="h3" id="former">People who have left</h2><p>These devices stay with their accounts permanently.</p><table><caption class="visually-hidden">Devices kept by people who have left the team</caption><thead><tr><th scope="col">Email</th><th scope="col">Devices they keep</th></tr></thead><tbody>${former
        .map((f) => `<tr><td>${esc(f.email)}</td><td>${esc(f.devices)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  return `<p class="lead">You own the team <strong>${esc(team.name)}</strong>${/[.!]$/.test(team.name) ? "" : "."}</p>
<h2 class="h3" id="pool">Licence devices</h2>
<dl class="facts"><div><dt>Bought by your account</dt><dd>${esc(pool.total)}</dd></div><div><dt>Assigned</dt><dd>${esc(pool.assigned)}</dd></div><div><dt>Unassigned</dt><dd>${esc(pool.unassigned)}</dd></div></dl>
<p>Your team's devices come from active Business Licences bought on Payhip with your account's email address. <a href="${esc(buyUrl(env))}">Buy more devices${env.PAYHIP_URL ? " on Payhip" : ""}</a>.</p>
<h2 class="h3" id="assign">Assign devices</h2>
<div class="notice-inline" id="assign-permanent"><p><strong>Assigning is permanent.</strong> Devices you assign stay with that person's account, even if they leave the team or you remove them. You can add more later, but you can't take any back. You're responsible for the devices you assign.</p></div>
${assignForm}
<h2 class="h3" id="members">Members</h2>
<table><caption class="visually-hidden">Team members</caption><thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Devices assigned</th><th scope="col">Joined</th><th scope="col">Action</th></tr></thead><tbody>${memberRows}</tbody></table>
<h2 class="h3" id="invite">Invite someone</h2>
<form method="post" action="/account/team/invite" novalidate class="stack">
<div class="field${errors.invite_email ? " has-error" : ""}"><label for="invite_email">Their email address</label><p class="hint" id="invite_email-hint">We'll email them a link. It works once and expires in 7 days. They'll need to sign in or create a free account with this exact email address, then accept.</p>${fieldError(errors, "invite_email")}<input id="invite_email" name="invite_email" type="email" autocomplete="off" spellcheck="false" value="${esc(values.invite_email || "")}"${inputAttrs(errors, "invite_email", "invite_email-hint")}></div>
<button type="submit" class="btn">Send invite</button>
</form>
<h2 class="h3" id="invites">Pending invites</h2>
${inviteRows}
${formerRows}`;
}

async function memberBody(env, team, user) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(a.devices), 0) AS n FROM licence_assignments a JOIN licences l ON l.id = a.licence_id
     WHERE a.user_id = ? AND a.team_id = ? AND l.status = 'active'`
  ).bind(user.id, team.id).first();
  const n = Number(row?.n || 0);
  return `<p class="lead">You're a member of <strong>${esc(team.name)}</strong>${/[.!]$/.test(team.name) ? "" : "."}</p>
<dl class="facts"><div><dt>Team owner</dt><dd>${esc(team.owner_email)}</dd></div><div><dt>Joined</dt><dd>${fmtDate(team.joined_at)}</dd></div><div><dt>Devices assigned to you</dt><dd>${esc(n)}</dd></div></dl>
<p>${n > 0 ? `Licensed through ${esc(team.name)}: ${esc(devicesText(n))} assigned to your account.` : "No devices have been assigned to you yet. The team owner can assign some from their team page."} Devices assigned to you stay with your account, even if you leave the team.</p>
<h2 class="h3" id="leave">Leave the team</h2>
<p>You can leave at any time. You'll keep any devices already assigned to you.</p>
<form method="post" action="/account/team/leave"><input type="hidden" name="step" value="review"><button type="submit" class="btn ghost">Leave team</button></form>`;
}

function noTeamBody({ errors = {}, values = {} } = {}) {
  return `<p class="lead">A team lets one account buy Business Licence devices and share them with the people who work with it.</p>
<h2 class="h3" id="how">How teams work</h2>
<ul>
<li>The person who creates a team is its owner. Each account can be on only one team.</li>
<li>Business Licences the owner buys on Payhip, with the owner's account email, go into the team's pool of devices.</li>
<li>The owner invites people by email. Each person uses their own free LlmentZero account and accepts the invite.</li>
<li>The owner assigns devices to each person. <strong>Assigning is permanent:</strong> assigned devices stay with that person's account, even if they leave the team.</li>
<li>If an order is refunded, every device from that order ends, including devices assigned to team members.</li>
</ul>
<p>Joining someone else's team? Open the invite link they emailed you.</p>
<h2 class="h3" id="create">Create a team</h2>
<form method="post" action="/account/team/create" novalidate class="stack">
<div class="field${errors.team_name ? " has-error" : ""}"><label for="team_name">Business or team name</label><p class="hint" id="team_name-hint">${TEAM_LIMITS.nameMin} to ${TEAM_LIMITS.nameMax} characters: letters, numbers, spaces and simple punctuation (&amp; . , ' ( ) - + ! #). Team members and people you invite will see this name.</p>${fieldError(errors, "team_name")}<input id="team_name" name="team_name" type="text" autocomplete="organization" maxlength="${TEAM_LIMITS.nameMax * 2}" value="${esc(values.team_name || "")}"${inputAttrs(errors, "team_name", "team_name-hint")}></div>
<button type="submit" class="btn">Create team</button>
</form>
<p class="small">By creating a team you agree to the team sections of the <a href="/terms#t-9b">Terms</a> and the <a href="/licence#lic-5-16">Skill Licence</a>.</p>`;
}

async function teamPage(env, user, { cookies = [], errors = {}, values = {}, notice = "", status = 200 } = {}) {
  const team = await teamOf(env, user.id);
  const hasErr = Object.keys(errors).length > 0;
  let body;
  if (!team) body = noTeamBody({ errors, values });
  else if (team.role === "owner") body = ownerBody(env, team, user, await ownerData(env, team, user), { errors, values });
  else body = await memberBody(env, team, user);
  const title = team ? "Your team" : "Teams";
  return page(
    title,
    `${errorSummary(errors)}${notice ? `<p class="notice-ok" role="status">${esc(notice)}</p>` : ""}<p class="eyebrow">Account</p><h1>${title}</h1>${body}<p><a href="/account">Back to your account</a></p>`,
    user,
    { status, cookies, error: hasErr }
  );
}

export async function getTeam(request, env) {
  const g = await signedIn(request, env, "/account/team");
  if (g.res) return g.res;
  const done = new URL(request.url).searchParams.get("done");
  return teamPage(env, g.user, { cookies: g.cookies, notice: NOTICES[done] || "" });
}

// ---------- Create ----------

export async function postCreateTeam(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const g = await signedIn(request, env, "/account/team");
  if (g.res) return g.res;
  const { user } = g;
  if (await teamOf(env, user.id)) return redirect("/account/team");
  const f = await readForm(request);
  const name = cleanTeamName(f.get("team_name"));
  const problem = teamNameProblem(name);
  if (problem) return teamPage(env, user, { errors: { team_name: problem }, values: { team_name: f.get("team_name") || "" }, status: 400 });
  const id = randomId("tm_");
  const t = now();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO teams (id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)").bind(id, name, user.id, t),
      env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(id, user.id, t),
    ]);
  } catch {
    // Another tab created or joined a team first; one team per account.
    return redirect("/account/team");
  }
  await audit(env, "team.created", { userId: user.id, detail: `team=${id}` });
  return redirect("/account/team?done=created");
}

// ---------- Invites ----------

async function ownerTeam(env, user) {
  const team = await teamOf(env, user.id);
  return team && team.role === "owner" ? team : null;
}

export async function postInvite(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const g = await signedIn(request, env, "/account/team");
  if (g.res) return g.res;
  const { user } = g;
  const team = await ownerTeam(env, user);
  if (!team) return notOwner(env, user, "invite");
  const f = await readForm(request);
  const raw = f.get("invite_email") || "";
  const email = normaliseEmail(raw);
  const values = { invite_email: raw };
  let err = "";
  if (!email) err = "Enter the email address of the person you want to invite";
  else if (!isValidEmail(email)) err = "Enter an email address in the right format, like name@example.com";
  else if (email === user.email) err = "That's your own email address. You're already on this team as its owner";
  else {
    const already = await env.DB.prepare("SELECT 1 AS ok FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND u.email = ?").bind(team.id, email).first();
    if (already) err = "That person is already on your team";
    else if (await optedOut(env, email)) err = "We can't send an invite to this address, because its owner has asked not to get team invites from LlmentZero";
  }
  if (err) return teamPage(env, user, { errors: { invite_email: err }, values, status: 400 });
  if (!(await hit(env, `invite:team:${team.id}`, TEAM_LIMITS.invitesPerTeamDay, 86400))) {
    await audit(env, "team.invite_rate_limited", { userId: user.id, detail: `team=${team.id}` });
    return teamPage(env, user, { errors: { invite_email: `You've reached today's limit of ${TEAM_LIMITS.invitesPerTeamDay} invites. It resets at 8 PM Toronto time` }, values, status: 429 });
  }
  const id = randomId("ti_");
  const token = randomToken(32);
  const t = now();
  const expires = t + TEAM_LIMITS.inviteTtl;
  await env.DB.batch([
    // A new invite to the same address replaces any earlier pending one.
    env.DB.prepare("UPDATE team_invites SET cancelled_at = ? WHERE team_id = ? AND email = ? AND accepted_at IS NULL AND cancelled_at IS NULL").bind(t, team.id, email),
    env.DB.prepare("INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, team.id, email, await sha256Hex(token), user.id, t, expires),
  ]);
  const origin = new URL(request.url).origin;
  const link = `${origin}/account/team/join?token=${encodeURIComponent(token)}`;
  const stopLink = `${origin}/account/team/stop-invites?k=${await optoutKey(env, email)}`;
  try {
    await sendEmail(env, { to: email, ...teamInviteEmail({ teamName: team.name, inviterEmail: user.email, inviteeEmail: email, link, stopLink, expiresOn: fmtDate(expires) }), idempotencyKey: `invite-${id}` });
  } catch (e) {
    await env.DB.prepare("UPDATE team_invites SET cancelled_at = ? WHERE id = ?").bind(now(), id).run();
    await audit(env, "email.failed", { userId: user.id, detail: `team invite: ${e instanceof EmailError ? `${e.status || ""} ${e.message}` : String(e)}` });
    const msg = e instanceof EmailError && e.status === 429 ? "We've reached today's limit for emails. Please try again tomorrow" : "We couldn't send the invite email just now. Please try again in a few minutes";
    return teamPage(env, user, { errors: { invite_email: msg }, values, status: 503 });
  }
  await audit(env, "team.invite_sent", { userId: user.id, detail: `team=${team.id} invite=${id}` });
  return redirect("/account/team?done=invited");
}

export async function postCancelInvite(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const g = await signedIn(request, env, "/account/team");
  if (g.res) return g.res;
  const { user } = g;
  const team = await ownerTeam(env, user);
  if (!team) return notOwner(env, user, "invite.cancel");
  const f = await readForm(request);
  const inviteId = String(f.get("invite") || "").slice(0, 64);
  const r = await env.DB.prepare("UPDATE team_invites SET cancelled_at = ? WHERE id = ? AND team_id = ? AND accepted_at IS NULL AND cancelled_at IS NULL").bind(now(), inviteId, team.id).run();
  if (r.meta?.changes) await audit(env, "team.invite_cancelled", { userId: user.id, detail: `team=${team.id} invite=${inviteId}` });
  return redirect("/account/team?done=cancelled");
}

// ---------- Stop team invites (CASL unsubscribe) ----------
// Every invite email carries a link that stops further team invites to that address. The link
// holds a keyed hash of the address (not the address), works without signing in and never
// expires, so it stays valid well beyond the 60 days CASL s. 11(2) requires.

const OPTOUT_RE = /^[a-f0-9]{40}$/;

export async function optoutKey(env, email) {
  if (!env.IP_HASH_KEY) throw new Error("IP_HASH_KEY secret is not set");
  return (await hmacHex(env.IP_HASH_KEY, `invite-optout:${email}`)).slice(0, 40);
}

async function optedOut(env, email) {
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM invite_optouts WHERE email_key = ?").bind(await optoutKey(env, email)).first());
}

export async function getStopInvites(request, env) {
  const { user } = await getSession(env, request);
  const k = new URL(request.url).searchParams.get("k") || "";
  if (!OPTOUT_RE.test(k)) return problemPage(user, "This link isn't complete", "Open the link from the invite email again, or email <a href=\"mailto:llmentzero@gmail.com\">llmentzero@gmail.com</a> and we'll stop team invites to your address.");
  return page(
    "Stop team invites to your email address?",
    `<p class="eyebrow">Teams</p><h1>Stop team invites?</h1><p>If you stop them, no one will be able to invite your email address to a team on LlmentZero. Invites you already have will stop working when they expire.</p><p>This doesn't affect sign-in codes or emails about an account or licence you already have.</p><form method="post" action="/account/team/stop-invites"><input type="hidden" name="k" value="${esc(k)}"><button type="submit" class="btn">Stop team invites</button></form><p>If you change your mind later, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a>.</p>`,
    user
  );
}

export async function postStopInvites(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const { user } = await getSession(env, request);
  const f = await readForm(request);
  const k = String(f.get("k") || "");
  if (!OPTOUT_RE.test(k)) return problemPage(user, "This link isn't complete", "Open the link from the invite email again, or email <a href=\"mailto:llmentzero@gmail.com\">llmentzero@gmail.com</a> and we'll stop team invites to your address.");
  await env.DB.prepare("INSERT INTO invite_optouts (email_key, created_at) VALUES (?, ?) ON CONFLICT (email_key) DO NOTHING").bind(k, now()).run();
  await audit(env, "team.invites_stopped", { userId: user?.id || null, detail: `key=${k.slice(0, 8)}` });
  return page("Team invites stopped", `<p class="eyebrow">Teams</p><h1>Team invites stopped</h1><p>We won't send any more team invites to your email address. If you change your mind, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a>.</p><p><a href="/">Go to the LlmentZero home page</a></p>`, user);
}

// ---------- Join (accept an invite) ----------

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

async function findInvite(env, token) {
  if (!TOKEN_RE.test(token)) return null;
  return env.DB.prepare(
    "SELECT i.*, t.name AS team_name, u.email AS inviter_email FROM team_invites i JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ?"
  ).bind(await sha256Hex(token)).first();
}

/** Returns a problem response for an invite this user can't accept, or null if it's fine. */
async function inviteProblem(env, user, invite, { log = false } = {}) {
  const t = now();
  if (!invite || invite.cancelled_at) return problemPage(user, "This invite can't be used", "This invite link isn't valid any more. It may have been cancelled or replaced by a newer invite. Ask the team owner to send you a new one.");
  if (invite.accepted_at) return problemPage(user, "This invite has already been used", "Each invite link works once. If you've already joined, you'll see the team on your team page. Otherwise, ask the team owner for a new invite.");
  if (invite.expires_at <= t) return problemPage(user, "This invite has expired", "Invite links work for 7 days. Ask the team owner to send you a new one.");
  if (invite.email !== user.email) {
    if (log) await audit(env, "team.invite_wrong_email", { userId: user.id, detail: `invite=${invite.id}` });
    return page(
      "This invite is for a different email address",
      `<p class="eyebrow">Teams</p><h1>This invite is for a different email address</h1><p>You're signed in as <strong>${esc(user.email)}</strong>, but this invite was sent to a different address. Only the account with the invited email address can accept it.</p><p>Sign out, then open the invite link again and sign in or create an account with the address the invite was sent to.</p><form method="post" action="/signout"><button type="submit" class="btn ghost">Sign out</button></form><p><a href="/account">Back to your account</a></p>`,
      user,
      { status: 403 }
    );
  }
  const current = await teamOf(env, user.id);
  if (current) {
    if (current.id === invite.team_id) return problemPage(user, "You're already on this team", "You don't need to do anything else.");
    return problemPage(
      user,
      "You're already on a team",
      `Each account can be on only one team, and you're on <strong>${esc(current.name)}</strong>. ${current.role === "owner" ? "Team owners can't join another team." : "To join this team instead, leave your current team first from your team page, then open the invite link again. You'll keep any devices already assigned to you."}`
    );
  }
  return null;
}

export async function getJoin(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const here = `/account/team/join?token=${encodeURIComponent(token)}`;
  const { user, cookies } = await getSession(env, request);
  if (!user) {
    const n = encodeURIComponent(here);
    return html(
      layout({
        title: "Join a team on LlmentZero",
        body: `<p class="eyebrow">Teams</p><h1>Join a team on LlmentZero</h1><p>To see this invite and accept it, sign in or create a free account with the email address the invite was sent to. You'll come back to this page afterwards.</p><p><a class="btn" href="/signin?next=${n}">Sign in</a> <a class="btn ghost" href="/signup?next=${n}">Create a free account</a></p>`,
      }),
      { cookies }
    );
  }
  const g = await signedIn(request, env, here);
  if (g.res) return g.res;
  const invite = await findInvite(env, token);
  const problem = await inviteProblem(env, user, invite, { log: true });
  if (problem) return problem;
  return page(
    `Join ${invite.team_name}`,
    `<p class="eyebrow">Teams</p><h1>Join <span class="team-name">${esc(invite.team_name)}</span>?</h1>
<p>${esc(invite.inviter_email)} has invited you (${esc(user.email)}) to join their team on LlmentZero.</p>
<ul><li>The team owner can assign Business Licence devices to your account.</li><li>Devices assigned to you stay with your account permanently, even if you leave the team later.</li><li>You can leave the team at any time.</li><li>Each account can be on only one team.</li></ul>
<form method="post" action="/account/team/join"><input type="hidden" name="token" value="${esc(token)}"><button type="submit" class="btn">Accept and join the team</button></form>
<p><a href="/account">Not now</a></p>`,
    user,
    { cookies: g.cookies }
  );
}

export async function postJoin(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const f = await readForm(request);
  const token = String(f.get("token") || "");
  const g = await signedIn(request, env, `/account/team/join?token=${encodeURIComponent(token)}`);
  if (g.res) return g.res;
  const { user } = g;
  const invite = await findInvite(env, token);
  const problem = await inviteProblem(env, user, invite, { log: true });
  if (problem) return problem;
  const t = now();
  try {
    // Atomic and single-use: the member row is only written if this request marked the invite used.
    // If it didn't (already used, cancelled, expired or wrong email) the team_id is NULL and the
    // whole batch rolls back. team_members.user_id is UNIQUE, so one team per account holds too.
    await env.DB.batch([
      env.DB.prepare("UPDATE team_invites SET accepted_at = ?1, accepted_by = ?2 WHERE id = ?3 AND email = ?4 AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at > ?1").bind(t, user.id, invite.id, user.email),
      env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ((SELECT team_id FROM team_invites WHERE id = ?1 AND accepted_by = ?2 AND accepted_at = ?3), ?2, 'member', ?3)").bind(invite.id, user.id, t),
    ]);
  } catch {
    const again = await inviteProblem(env, user, await findInvite(env, token));
    return again || problemPage(user, "This invite can't be used", "Something changed while you were accepting. Please open the invite link again.", 409);
  }
  await audit(env, "team.invite_accepted", { userId: user.id, detail: `team=${invite.team_id} invite=${invite.id}` });
  return redirect("/account/team?done=joined");
}

// ---------- Assign devices (permanent) ----------

function confirmPage(user, { title, heading, paragraphs, action, hidden, confirmLabel }) {
  const fields = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return page(
    title,
    `<p class="eyebrow">Check before you continue</p><h1>${esc(heading)}</h1>
<div class="notice-inline confirm-box" role="note">${paragraphs.map((p) => `<p>${p}</p>`).join("")}</div>
<form method="post" action="${esc(action)}" class="confirm-actions">${fields}<input type="hidden" name="step" value="confirm"><button type="submit" class="btn">${esc(confirmLabel)}</button> <a class="btn ghost" href="/account/team">Cancel</a></form>`,
    user
  );
}

function parseDevices(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{1,6}$/.test(s)) return 0;
  const n = parseInt(s, 10);
  return n >= 1 && n <= TEAM_LIMITS.maxDevicesPerAssign ? n : 0;
}

export async function postAssign(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const g = await signedIn(request, env, "/account/team");
  if (g.res) return g.res;
  const { user } = g;
  const team = await ownerTeam(env, user);
  if (!team) return notOwner(env, user, "assign");
  const f = await readForm(request);
  const memberId = String(f.get("member") || "").slice(0, 64);
  const rawDevices = f.get("devices") || "";
  const values = { member: memberId, devices: rawDevices };
  const errors = {};
  const member = memberId
    ? await env.DB.prepare("SELECT m.user_id, u.email FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND m.user_id = ?").bind(team.id, memberId).first()
    : null;
  if (!member) errors.member = memberId ? "That person isn't on your team any more. Choose a current team member" : "Choose the team member to assign devices to";
  const n = parseDevices(rawDevices);
  const pool = await poolFor(env, user.email);
  if (!String(rawDevices).trim()) errors.devices = "Enter how many devices to assign";
  else if (!n) errors.devices = "Enter a whole number of devices, like 1 or 2";
  else if (n > pool.unassigned) {
    errors.devices = pool.unassigned === 0 ? "You have no unassigned devices. Buy more Business Licences first" : `You have ${devicesText(pool.unassigned)} unassigned. Enter ${pool.unassigned} or fewer`;
    await audit(env, "team.assign_rejected", { userId: user.id, detail: `team=${team.id} asked=${n} unassigned=${pool.unassigned}` });
  }
  if (Object.keys(errors).length) return teamPage(env, user, { errors, values, status: 400 });

  const isSelf = member.user_id === user.id;
  const who = isSelf ? `your account (${esc(member.email)})` : esc(member.email);
  const nonce = String(f.get("nonce") || "");
  if (f.get("step") !== "confirm" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
    return confirmPage(user, {
      title: "Confirm permanent assignment",
      heading: "Check before you assign",
      paragraphs: [
        `You're about to assign <strong>${esc(devicesText(n))}</strong> to <strong>${esc(member.email)}</strong>.`,
        `<strong>This is permanent.</strong> ${n === 1 ? "This device" : "These devices"} will stay with ${who} even if ${isSelf ? "you" : "they"} leave the team. You won't be able to take ${n === 1 ? "it" : "them"} back or move ${n === 1 ? "it" : "them"} to someone else.`,
        `You'll have ${esc(devicesText(pool.unassigned - n))} unassigned after this.`,
        "If the order a device came from is refunded, that device ends, including for the person it was assigned to.",
      ],
      action: "/account/team/assign",
      hidden: { member: member.user_id, devices: String(n), nonce: randomToken(18) },
      confirmLabel: `Yes, assign ${devicesText(n)} permanently`,
    });
  }

  // Take devices from specific licence rows (oldest first) so a refund of that order ends them.
  const { results: rows = [] } = await env.DB.prepare(
    "SELECT id, devices - assigned_devices AS free FROM licences WHERE email = ? AND status = 'active' AND licence_type = 'business' AND devices > assigned_devices ORDER BY purchased_at, id"
  ).bind(user.email).all();
  let left = n;
  const plan = [];
  for (const r of rows) {
    if (!left) break;
    const take = Math.min(left, Number(r.free));
    plan.push({ licenceId: r.id, take });
    left -= take;
  }
  const t = now();
  const nonceKey = `assign:nonce:${nonce}`;
  const changed = () => teamPage(env, user, { errors: { devices: "The number of unassigned devices changed while you were working. Please check the numbers and try again" }, values, status: 409 });
  if (left > 0) return changed();
  const stmts = [env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)").bind(nonceKey, t)];
  for (const p of plan) {
    // The CHECK on licences.assigned_devices makes this fail (and roll back everything) if it would over-assign.
    stmts.push(env.DB.prepare("UPDATE licences SET assigned_devices = assigned_devices + ?1, updated_at = ?2 WHERE id = ?3").bind(p.take, t, p.licenceId));
    // devices is NOT NULL, so a NULL here aborts the batch unless the licence is still active and the
    // owner's, the member is still on the team, and this account still owns the team.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO licence_assignments (id, licence_id, team_id, user_id, devices, assigned_by, assigned_at)
         VALUES (?1, ?2, ?3, ?4,
           CASE WHEN EXISTS (SELECT 1 FROM licences WHERE id = ?2 AND status = 'active' AND licence_type = 'business' AND email = ?5)
                 AND EXISTS (SELECT 1 FROM team_members WHERE team_id = ?3 AND user_id = ?4)
                 AND EXISTS (SELECT 1 FROM teams WHERE id = ?3 AND owner_user_id = ?6)
                THEN ?7 ELSE NULL END,
           ?6, ?8)`
      ).bind(randomId("as_"), p.licenceId, team.id, member.user_id, user.email, user.id, p.take, t)
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch {
    // Same confirmation submitted twice (double click, back button): the first one already worked.
    if (await env.DB.prepare("SELECT 1 AS ok FROM rate_limits WHERE key = ?").bind(nonceKey).first()) return redirect("/account/team?done=assigned");
    await audit(env, "team.assign_rejected", { userId: user.id, detail: `team=${team.id} asked=${n} conflict` });
    return changed();
  }
  await audit(env, "team.assigned", { userId: user.id, detail: `team=${team.id} member=${member.user_id} devices=${n} from=${plan.map((p) => `${p.licenceId}:${p.take}`).join(",")}` });
  return redirect("/account/team?done=assigned");
}

// ---------- Remove a member / leave ----------

async function activeAssigned(env, teamId, userId) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(a.devices), 0) AS n FROM licence_assignments a JOIN licences l ON l.id = a.licence_id WHERE a.team_id = ? AND a.user_id = ? AND l.status = 'active'"
  ).bind(teamId, userId).first();
  return Number(row?.n || 0);
}

export async function postRemove(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const g = await signedIn(request, env, "/account/team");
  if (g.res) return g.res;
  const { user } = g;
  const team = await ownerTeam(env, user);
  if (!team) return notOwner(env, user, "remove");
  const f = await readForm(request);
  const memberId = String(f.get("member") || "").slice(0, 64);
  const member = await env.DB.prepare("SELECT m.user_id, m.role, u.email FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? AND m.user_id = ?").bind(team.id, memberId).first();
  if (!member) return redirect("/account/team");
  if (member.role === "owner") return problemPage(user, "You can't remove yourself", "You own this team, so you stay on it.");
  if (f.get("step") !== "confirm") {
    const n = await activeAssigned(env, team.id, member.user_id);
    return confirmPage(user, {
      title: "Remove team member",
      heading: "Remove this person from the team?",
      paragraphs: [
        `You're about to remove <strong>${esc(member.email)}</strong> from <strong>${esc(team.name)}</strong>${/[.!]$/.test(team.name) ? "" : "."}`,
        n > 0
          ? `<strong>Their ${esc(devicesText(n))} will stay with their account.</strong> Assignments are permanent, so removing someone doesn't return devices to your pool.`
          : "They don't have any devices assigned from your team.",
        "They'll no longer be able to get devices from your team. You can invite them again later.",
      ],
      action: "/account/team/remove",
      hidden: { member: member.user_id },
      confirmLabel: "Yes, remove them",
    });
  }
  const r = await env.DB.prepare(
    "DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'member' AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND owner_user_id = ?)"
  ).bind(team.id, member.user_id, team.id, user.id).run();
  if (r.meta?.changes) await audit(env, "team.member_removed", { userId: user.id, detail: `team=${team.id} member=${member.user_id}` });
  return redirect("/account/team?done=removed");
}

export async function postLeave(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const g = await signedIn(request, env, "/account/team");
  if (g.res) return g.res;
  const { user } = g;
  const team = await teamOf(env, user.id);
  if (!team) return redirect("/account/team");
  if (team.role === "owner") return problemPage(user, "Team owners can't leave", "You own this team, so you stay on it. To close your account, email <a href=\"mailto:llmentzero@gmail.com\">llmentzero@gmail.com</a>.");
  const f = await readForm(request);
  if (f.get("step") !== "confirm") {
    const n = await activeAssigned(env, team.id, user.id);
    return confirmPage(user, {
      title: "Leave team",
      heading: "Leave the team?",
      paragraphs: [
        `You're about to leave <strong>${esc(team.name)}</strong>${/[.!]$/.test(team.name) ? "" : "."}`,
        n > 0 ? `You'll keep the ${esc(devicesText(n))} assigned to your account.` : "You don't have any devices assigned from this team.",
        "You won't get any more devices from this team unless the owner invites you again.",
      ],
      action: "/account/team/leave",
      hidden: {},
      confirmLabel: "Yes, leave the team",
    });
  }
  const r = await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'member'").bind(team.id, user.id).run();
  if (r.meta?.changes) await audit(env, "team.member_left", { userId: user.id, detail: `team=${team.id}` });
  return redirect("/account/team?done=left");
}

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, form, mockOutbound, seedSkill, signUp } from "./helpers.js";
import worker from "../src/index.js";

afterEach(() => vi.restoreAllMocks());
// Many sign-ups from one test IP: reset the per-IP code limit between tests (it is tested in worker.spec.js).
beforeEach(() => env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE 'code:%'").run());

const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const uid = () => Math.random().toString(36).slice(2, 10);

async function payhip(body) {
  return call("/webhooks/payhip", { method: "POST", noOrigin: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, signature: await hex("test-payhip-key") }) });
}
const buy = (email, orderId, quantity, date = 1792200000) =>
  payhip({ id: orderId, email, price: 2900 * quantity, currency: "CAD", type: "paid", date, items: [{ product_id: "123", product_key: "wuUFT", product_name: "LlmentZero Business Licence (per device)", quantity: String(quantity) }] });
const refund = (email, orderId) => (vi.isMockFunction(globalThis.fetch) || mockOutbound(), payhip({ id: orderId, email, price: 2900, amount_refunded: 2900, type: "refunded", items: [] }));

const get = (path, cookie) => call(path, { headers: { Cookie: cookie } });
const post = (path, data, cookie, headers = {}) => form(path, data, { headers: { Cookie: cookie, ...headers } });
const userId = (email) => env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first("id");

async function makeTeam(name = "Acme & Co.") {
  const owner = await signUp(`owner-${uid()}@example.com`);
  const r = await post("/account/team/create", { team_name: name }, owner.cookie);
  expect(r.status).toBe(303);
  expect(r.headers.get("Location")).toBe("/account/team?done=created");
  const team = await env.DB.prepare("SELECT t.* FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = ?").bind(owner.email).first();
  return { owner, team };
}

/** Owner invites `email`; returns the token from the emailed link. */
async function invite(owner, email) {
  const { resendCalls } = mockOutbound();
  const r = await post("/account/team/invite", { invite_email: email }, owner.cookie);
  expect(r.status).toBe(303);
  expect(r.headers.get("Location")).toBe("/account/team?done=invited");
  vi.restoreAllMocks();
  const msg = resendCalls.at(-1).body;
  expect(msg.to).toEqual([email]);
  const token = /\/account\/team\/join\?token=([A-Za-z0-9_-]+)/.exec(msg.text)[1];
  return { token, msg };
}

async function join(member, token) {
  return post("/account/team/join", { token }, member.cookie);
}

async function teamWithMember() {
  const { owner, team } = await makeTeam();
  const memberEmail = `member-${uid()}@example.com`;
  const { token } = await invite(owner, memberEmail);
  const member = await signUp(memberEmail);
  const r = await join(member, token);
  expect(r.status).toBe(303);
  expect(r.headers.get("Location")).toBe("/account/team?done=joined");
  return { owner, team, member, token, memberId: await userId(memberEmail) };
}

/** Review then confirm, like a person clicking through. Returns the confirm response. */
async function assign(owner, memberId, devices) {
  const review = await post("/account/team/assign", { member: memberId, devices: String(devices), step: "review" }, owner.cookie);
  const body = await review.text();
  if (review.status !== 200) return { review, body };
  const nonce = /name="nonce" value="([^"]+)"/.exec(body)[1];
  const confirm = await post("/account/team/assign", { member: memberId, devices: String(devices), step: "confirm", nonce }, owner.cookie);
  return { review, body, confirm, nonce };
}

const assignedTo = (id) => env.DB.prepare("SELECT COALESCE(SUM(a.devices),0) AS n FROM licence_assignments a JOIN licences l ON l.id = a.licence_id WHERE a.user_id = ? AND l.status = 'active'").bind(id).first("n");
const reminderShown = async (cookie) => (await (await get("/skills/sample-skill", cookie)).text()).includes('id="lz-reminder"');

describe("team dashboard access", () => {
  it("/account/team redirects to sign-in when signed out", async () => {
    const r = await call("/account/team");
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/signin?next=%2Faccount%2Fteam");
  });
  it("account page links to the team page", async () => {
    const { cookie } = await signUp();
    const body = await (await get("/account", cookie)).text();
    expect(body).toContain('href="/account/team"');
    expect(body).toContain("Not on a team");
    expect(await (await get("/account/team", cookie)).text()).toContain("Create a team");
  });
});

describe("creating a team", () => {
  it("creates a team, makes the creator the owner, and escapes the name", async () => {
    const { owner, team } = await makeTeam("O'Brien & Sons");
    expect(team.name).toBe("O'Brien & Sons");
    const m = await env.DB.prepare("SELECT role FROM team_members WHERE team_id = ?").bind(team.id).first("role");
    expect(m).toBe("owner");
    const body = await (await get("/account/team", owner.cookie)).text();
    expect(body).toContain("O&#39;Brien &amp; Sons");
    expect(body).not.toContain("O'Brien & Sons");
    expect(await (await get("/account", owner.cookie)).text()).toContain("Owner of O&#39;Brien &amp; Sons");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'team.created' AND user_id = ?").bind(await userId(owner.email)).first("n")).toBe(1);
  });

  it("rejects names with markup or link characters, with a linked field error", async () => {
    const { cookie } = await signUp();
    for (const bad of ["<script>alert(1)</script>", "https://evil.example", "a", ""]) {
      const r = await post("/account/team/create", { team_name: bad }, cookie);
      expect(r.status).toBe(400);
      const body = await r.text();
      expect(body).toContain('href="#team_name"');
      expect(body).toContain('id="team_name-error"');
      expect(body).not.toContain("<script>alert(1)</script>");
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = ?").bind((await env.DB.prepare("SELECT email FROM users ORDER BY created_at DESC LIMIT 1").first("email"))).first("n")).toBe(0);
  });

  it("allows only one team per account", async () => {
    const { owner } = await makeTeam();
    const r = await post("/account/team/create", { team_name: "Second Team" }, owner.cookie);
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/account/team");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM teams WHERE owner_user_id = ?").bind(await userId(owner.email)).first("n")).toBe(1);
  });

  it("blocks cross-site posts", async () => {
    const { cookie } = await signUp();
    const r = await post("/account/team/create", { team_name: "Evil Team" }, cookie, { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
});

describe("invites", () => {
  it("emails a single-use link, stores only a hash, and the invitee must accept", async () => {
    const { owner, team } = await makeTeam();
    const email = `new-${uid()}@example.com`;
    const { token, msg } = await invite(owner, email);
    expect(msg.text).toContain('"Acme & Co."');
    expect(msg.html).toContain("Acme &amp; Co.");
    expect(msg.text).toContain(owner.email);
    const row = await env.DB.prepare("SELECT * FROM team_invites WHERE team_id = ?").bind(team.id).first();
    expect(row.token_hash).toBe(await hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expires_at - row.created_at).toBe(7 * 86400);

    // Signed out: asked to sign in or create an account, coming back to the invite.
    const out = await call(`/account/team/join?token=${token}`);
    expect(out.status).toBe(200);
    expect(await out.text()).toContain(`/signup?next=${encodeURIComponent(`/account/team/join?token=${token}`)}`);

    // New account with the invited email sees the invite, and nothing happens until they accept.
    const member = await signUp(email);
    const page = await get(`/account/team/join?token=${token}`, member.cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Accept and join the team");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?").bind(team.id).first("n")).toBe(1);
    expect((await join(member, token)).status).toBe(303);
    expect(await env.DB.prepare("SELECT role FROM team_members WHERE user_id = ?").bind(await userId(email)).first("role")).toBe("member");
    expect(await (await get("/account/team", owner.cookie)).text()).toContain(email);

    // Single use: after leaving, the same link can't be used again.
    await post("/account/team/leave", { step: "confirm" }, member.cookie);
    const again = await join(member, token);
    expect(await again.text()).toContain("already been used");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE user_id = ?").bind(await userId(email)).first("n")).toBe(0);
  });

  it("rejects acceptance by an account with a different email", async () => {
    const { owner, team } = await makeTeam();
    const { token } = await invite(owner, `invited-${uid()}@example.com`);
    const other = await signUp();
    const r = await join(other, token);
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("different email address");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?").bind(team.id).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT accepted_at FROM team_invites WHERE team_id = ?").bind(team.id).first("accepted_at")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'team.invite_wrong_email' AND user_id = ?").bind(await userId(other.email)).first("n")).toBeGreaterThan(0);
  });

  it("expired and cancelled invites can't be used", async () => {
    const { owner, team } = await makeTeam();
    const e1 = `exp-${uid()}@example.com`;
    const { token: t1 } = await invite(owner, e1);
    await env.DB.prepare("UPDATE team_invites SET expires_at = 1 WHERE email = ?").bind(e1).run();
    const m1 = await signUp(e1);
    expect(await (await join(m1, t1)).text()).toContain("expired");

    const e2 = `can-${uid()}@example.com`;
    const { token: t2 } = await invite(owner, e2);
    const id = await env.DB.prepare("SELECT id FROM team_invites WHERE email = ?").bind(e2).first("id");
    expect((await post("/account/team/invite/cancel", { invite: id }, owner.cookie)).status).toBe(303);
    const m2 = await signUp(e2);
    expect(await (await join(m2, t2)).text()).toContain("can&#39;t be used");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?").bind(team.id).first("n")).toBe(1);
  });

  it("validates the email and rate-limits invites to 20 a day per team", async () => {
    const { owner } = await makeTeam();
    const bad = await post("/account/team/invite", { invite_email: "not-an-email" }, owner.cookie);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('href="#invite_email"');
    const self = await post("/account/team/invite", { invite_email: owner.email }, owner.cookie);
    expect(await self.text()).toContain("your own email address");
    mockOutbound();
    for (let i = 0; i < 20; i++) expect((await post("/account/team/invite", { invite_email: `p${i}-${uid()}@example.com` }, owner.cookie)).status).toBe(303);
    const r = await post("/account/team/invite", { invite_email: `p21-${uid()}@example.com` }, owner.cookie);
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("limit of 20 invites");
  });

  it("an account already on a team can't join another", async () => {
    const { member } = await teamWithMember();
    const { owner: owner2 } = await makeTeam("Other Team");
    const { token } = await invite(owner2, member.email);
    const r = await join(member, token);
    expect(await r.text()).toContain("already on a team");
  });
});

describe("assigning devices", () => {
  it("assigns from the pool after a permanent-confirmation step, and the member is licensed", async () => {
    await seedSkill();
    const { owner, member, memberId, team } = await teamWithMember();
    await buy(owner.email, `A-${uid()}`, 2, 1792200000);
    await buy(owner.email, `B-${uid()}`, 1, 1792300000);
    expect(await reminderShown(member.cookie)).toBe(true);

    const onlyReview = await post("/account/team/assign", { member: memberId, devices: "2", step: "review" }, owner.cookie);
    expect(onlyReview.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM licence_assignments WHERE team_id = ?").bind(team.id).first("n")).toBe(0); // nothing until confirmed
    const { review, body, confirm } = await assign(owner, memberId, 2);
    expect(review.status).toBe(200);
    expect(body).toContain("This is permanent.");
    expect(body).toContain(`will stay with ${member.email} even if they leave the team`);
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get("Location")).toBe("/account/team?done=assigned");
    expect(await assignedTo(memberId)).toBe(2);
    const pool = await env.DB.prepare("SELECT SUM(devices) AS total, SUM(assigned_devices) AS assigned FROM licences WHERE email = ?").bind(owner.email).first();
    expect(pool).toEqual({ total: 3, assigned: 2 });
    expect(await reminderShown(member.cookie)).toBe(false);
    expect(await (await get("/account/licences", member.cookie)).text()).toContain("Licensed through Acme &amp; Co.:</strong> 2 devices");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'team.assigned'").first("n")).toBeGreaterThan(0);

    // The owner can assign to themselves too.
    const self = await assign(owner, await userId(owner.email), 1);
    expect(self.body).toContain("will stay with your account");
    expect(self.confirm.status).toBe(303);
    expect(await (await get("/account/team", owner.cookie)).text()).toContain("You have no unassigned devices");
  });

  it("rejects assigning more than the unassigned pool, and the database can't go negative", async () => {
    const { owner, memberId } = await teamWithMember();
    const order = `C-${uid()}`;
    await buy(owner.email, order, 2);
    const r = await post("/account/team/assign", { member: memberId, devices: "3", step: "review" }, owner.cookie);
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toContain("You have 2 devices unassigned. Enter 2 or fewer");
    expect(body).toContain('href="#devices"');
    const forced = await post("/account/team/assign", { member: memberId, devices: "3", step: "confirm", nonce: "abcdefghijklmnopqrstuvwx" }, owner.cookie);
    expect(forced.status).toBe(400);
    for (const bad of ["0", "-1", "1.5", "two"]) expect((await post("/account/team/assign", { member: memberId, devices: bad, step: "review" }, owner.cookie)).status).toBe(400);
    expect(await assignedTo(memberId)).toBe(0);
    // Database-level guard: an over-assignment fails outright.
    await expect(env.DB.prepare("UPDATE licences SET assigned_devices = devices + 1 WHERE order_id = ?").bind(order).run()).rejects.toThrow(/CHECK/);
  });

  it("a failed guard rolls back the whole batch (D1 batches are transactions)", async () => {
    const { owner, memberId } = await teamWithMember();
    const order = `T-${uid()}`;
    await buy(owner.email, order, 2);
    const lic = await env.DB.prepare("SELECT id FROM licences WHERE order_id = ?").bind(order).first("id");
    await expect(
      env.DB.batch([
        env.DB.prepare("UPDATE licences SET assigned_devices = assigned_devices + 1 WHERE id = ?").bind(lic),
        env.DB.prepare("INSERT INTO licence_assignments (id, licence_id, team_id, user_id, devices, assigned_by, assigned_at) VALUES ('as_x', ?, 'tm_none', ?, NULL, ?, 1)").bind(lic, memberId, memberId),
      ])
    ).rejects.toThrow();
    expect(await env.DB.prepare("SELECT assigned_devices FROM licences WHERE id = ?").bind(lic).first("assigned_devices")).toBe(0);
  });

  it("a repeated confirmation (double click) doesn't assign twice", async () => {
    const { owner, memberId } = await teamWithMember();
    await buy(owner.email, `D-${uid()}`, 3);
    const { confirm, nonce } = await assign(owner, memberId, 1);
    expect(confirm.status).toBe(303);
    const again = await post("/account/team/assign", { member: memberId, devices: "1", step: "confirm", nonce }, owner.cookie);
    expect(again.status).toBe(303);
    expect(await assignedTo(memberId)).toBe(1);
  });

  it("only the owner can invite, assign, remove or cancel", async () => {
    const { owner, member, memberId, team } = await teamWithMember();
    await buy(owner.email, `E-${uid()}`, 2);
    const outsider = await signUp();
    for (const who of [member, outsider]) {
      expect((await post("/account/team/invite", { invite_email: "x@example.com" }, who.cookie)).status).toBe(403);
      expect((await post("/account/team/assign", { member: memberId, devices: "1", step: "confirm", nonce: "abcdefghijklmnopqrstuvwx" }, who.cookie)).status).toBe(403);
      expect((await post("/account/team/remove", { member: memberId, step: "confirm" }, who.cookie)).status).toBe(403);
      expect((await post("/account/team/invite/cancel", { invite: "ti_x" }, who.cookie)).status).toBe(403);
    }
    expect(await assignedTo(memberId)).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?").bind(team.id).first("n")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'team.forbidden'").first("n")).toBeGreaterThanOrEqual(8);
    // A member can't be assigned devices from someone else's team.
    const { owner: owner2 } = await makeTeam("Other Team");
    await buy(owner2.email, `F-${uid()}`, 2);
    expect((await post("/account/team/assign", { member: memberId, devices: "1", step: "review" }, owner2.cookie)).status).toBe(400);
  });
});

describe("assignments are permanent", () => {
  it("removing a member keeps their devices with them and doesn't refill the pool", async () => {
    await seedSkill();
    const { owner, member, memberId, team } = await teamWithMember();
    await buy(owner.email, `G-${uid()}`, 2);
    await assign(owner, memberId, 2);
    const review = await post("/account/team/remove", { member: memberId, step: "review" }, owner.cookie);
    expect(await review.text()).toContain("Their 2 devices will stay with their account.");
    const r = await post("/account/team/remove", { member: memberId, step: "confirm" }, owner.cookie);
    expect(r.headers.get("Location")).toBe("/account/team?done=removed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_members WHERE user_id = ?").bind(memberId).first("n")).toBe(0);
    expect(await assignedTo(memberId)).toBe(2);
    expect(await env.DB.prepare("SELECT SUM(assigned_devices) AS n FROM licences WHERE email = ?").bind(owner.email).first("n")).toBe(2);
    expect(await reminderShown(member.cookie)).toBe(false);
    const acct = await (await get("/account/licences", member.cookie)).text();
    expect(acct).toContain("2 devices assigned to your account. They stay with your account permanently.");
    expect(acct).not.toContain("Licensed through");
    const dash = await (await get("/account/team", owner.cookie)).text();
    expect(dash).toContain("People who have left");
    expect(dash).toContain(member.email);
    // No route takes devices back, and the owner can't reassign them.
    expect((await post("/account/team/assign", { member: memberId, devices: "1", step: "review" }, owner.cookie)).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'team.member_removed' AND detail LIKE ?").bind(`%${team.id}%`).first("n")).toBe(1);
  });

  it("a member who leaves keeps their devices", async () => {
    const { owner, member, memberId } = await teamWithMember();
    await buy(owner.email, `H-${uid()}`, 1);
    await assign(owner, memberId, 1);
    const review = await post("/account/team/leave", { step: "review" }, member.cookie);
    expect(await review.text()).toContain("You'll keep the 1 device assigned to your account.");
    const r = await post("/account/team/leave", { step: "confirm" }, member.cookie);
    expect(r.headers.get("Location")).toBe("/account/team?done=left");
    expect(await assignedTo(memberId)).toBe(1);
    // The owner can't leave their own team.
    expect(await (await post("/account/team/leave", { step: "confirm" }, owner.cookie)).text()).toContain("Team owners can&#39;t leave");
  });
});

describe("refunds", () => {
  it("a refund ends every device from that order, including assigned ones, but not other orders", async () => {
    await seedSkill();
    const { owner, member, memberId } = await teamWithMember();
    const a = `R1-${uid()}`;
    const b = `R2-${uid()}`;
    await buy(owner.email, a, 2, 1792200000);
    await buy(owner.email, b, 2, 1792300000);
    await assign(owner, memberId, 3); // 2 from the oldest order, 1 from the next
    const rows = (await env.DB.prepare("SELECT l.order_id, a.devices FROM licence_assignments a JOIN licences l ON l.id = a.licence_id WHERE a.user_id = ? ORDER BY l.purchased_at").bind(memberId).all()).results;
    expect(rows).toEqual([{ order_id: a, devices: 2 }, { order_id: b, devices: 1 }]);

    expect((await refund(owner.email, a)).status).toBe(200);
    expect(await assignedTo(memberId)).toBe(1);
    expect(await reminderShown(member.cookie)).toBe(false);
    expect(await (await get("/account/licences", member.cookie)).text()).toContain("2 devices that had been assigned to you ended because the order they came from was refunded.");

    expect((await refund(owner.email, b)).status).toBe(200);
    expect(await assignedTo(memberId)).toBe(0);
    expect(await reminderShown(member.cookie)).toBe(true);
    // Removing the member afterwards doesn't bring anything back either.
    await post("/account/team/remove", { member: memberId, step: "confirm" }, owner.cookie);
    expect(await assignedTo(memberId)).toBe(0);
  });

  it("an owner who has assigned every device sees the reminder again", async () => {
    await seedSkill();
    const { owner, memberId } = await teamWithMember();
    await buy(owner.email, `S-${uid()}`, 1);
    expect(await reminderShown(owner.cookie)).toBe(false);
    await assign(owner, memberId, 1);
    expect(await reminderShown(owner.cookie)).toBe(true);
  });
});

describe("refund notices", () => {
  it("emails the buyer and every member who had devices from the order, once, even on retries", async () => {
    const { owner, member, memberId, team } = await teamWithMember();
    const leaver = `leaver-${uid()}@example.com`;
    const { token } = await invite(owner, leaver);
    const l = await signUp(leaver);
    await join(l, token);
    const order = `N-${uid()}`;
    await buy(owner.email, order, 4);
    await assign(owner, memberId, 2);
    await assign(owner, await userId(leaver), 1);
    await post("/account/team/leave", { step: "confirm" }, l.cookie); // left the team, still notified

    const { resendCalls } = mockOutbound();
    expect((await refund(owner.email, order)).status).toBe(200);
    const to = resendCalls.map((c) => c.body.to[0]).sort();
    expect(to).toEqual([owner.email, member.email, leaver].sort());
    const byTo = Object.fromEntries(resendCalls.map((c) => [c.body.to[0], c.body]));
    expect(byTo[owner.email].subject).toBe("Your LlmentZero licence has ended");
    expect(byTo[owner.email].text).toContain(`Payhip order ${order} was refunded`);
    expect(byTo[owner.email].text).toContain("4 devices");
    expect(byTo[owner.email].text).toContain("3 devices you had assigned to team members");
    expect(byTo[member.email].text).toContain('2 devices assigned to your account through the team "Acme & Co." have ended');
    expect(byTo[member.email].text).toContain("order placed by the team owner, and that order was refunded");
    expect(byTo[member.email].text).not.toContain(owner.email);
    expect(byTo[leaver].text).toContain("1 device assigned to your account");
    for (const b of Object.values(byTo)) {
      expect(b.text).toContain("must stop");
      expect(b.text).toContain("llmentzero@gmail.com");
      expect(b.from).toBe("LlmentZero <no-reply@mail.llmentzero.com>");
    }
    expect(byTo[member.email].html).toContain("Acme &amp; Co.");
    // Payhip retries the webhook: nobody gets a second email.
    expect((await refund(owner.email, order)).status).toBe(200);
    expect(resendCalls.length).toBe(3);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_notices WHERE order_id = ? AND sent_at IS NOT NULL").bind(order).first("n")).toBe(3);
    void team;
  });

  it("an email failure doesn't break the webhook, is audited, and is retried on the next delivery", async () => {
    const buyer = await signUp();
    const order = `F-${uid()}`;
    await buy(buyer.email, order, 1);
    const { resendCalls } = mockOutbound({ resendResponses: [422] });
    const r = await refund(buyer.email, order);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(await env.DB.prepare("SELECT status FROM licences WHERE order_id = ?").bind(order).first("status")).toBe("refunded");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'email.failed' AND detail LIKE ?").bind(`%${order}%`).first("n")).toBe(1);
    expect((await refund(buyer.email, order)).status).toBe(200);
    expect(resendCalls.length).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM refund_notices WHERE order_id = ? AND sent_at IS NOT NULL").bind(order).first("n")).toBe(1);
  });

  it("an owner who assigned devices to themselves gets one email", async () => {
    const { owner } = await teamWithMember();
    const order = `O-${uid()}`;
    await buy(owner.email, order, 2);
    await assign(owner, await userId(owner.email), 2);
    const { resendCalls } = mockOutbound();
    await refund(owner.email, order);
    expect(resendCalls.map((c) => c.body.to[0])).toEqual([owner.email]);
    expect(resendCalls[0].body.text).not.toContain("assigned to team members");
  });
});

describe("stopping team invites (CASL unsubscribe)", () => {
  it("every invite has a stop link that works signed out, and stops further invites to that address", async () => {
    const { owner, team } = await makeTeam();
    const email = `stop-${uid()}@example.com`;
    const { msg } = await invite(owner, email);
    const m = /\/account\/team\/stop-invites\?k=([a-f0-9]{40})/.exec(msg.text);
    expect(m).not.toBeNull();
    expect(msg.html).toContain(`/account/team/stop-invites?k=${m[1]}`);
    expect(msg.text).toContain("sent by LlmentZero at the request of the team owner");
    expect(msg.text).not.toContain(encodeURIComponent(email));

    // Opening the link changes nothing (mail scanners follow links); the button does.
    const page = await call(`/account/team/stop-invites?k=${m[1]}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Stop team invites</button>");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invite_optouts").first("n")).toBe(0);
    expect((await form("/account/team/stop-invites", { k: m[1] }, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const done = await form("/account/team/stop-invites", { k: m[1] });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Team invites stopped");
    expect((await form("/account/team/stop-invites", { k: m[1] })).status).toBe(200); // twice is fine
    const stored = await env.DB.prepare("SELECT * FROM invite_optouts").all();
    expect(stored.results).toHaveLength(1);
    expect(JSON.stringify(stored.results)).not.toContain(email);

    // The owner (or anyone) can't invite that address again; no email is sent.
    const { resendCalls } = mockOutbound();
    const r = await post("/account/team/invite", { invite_email: email.toUpperCase() }, owner.cookie);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("asked not to get team invites");
    expect(resendCalls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM team_invites WHERE team_id = ? AND email = ?").bind(team.id, email).first("n")).toBe(1);
    await env.DB.prepare("DELETE FROM invite_optouts").run();
  });

  it("rejects a broken stop link without storing anything", async () => {
    expect((await call("/account/team/stop-invites?k=nope")).status).toBe(400);
    expect((await form("/account/team/stop-invites", { k: "x".repeat(40) })).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invite_optouts").first("n")).toBe(0);
  });
});

describe("invite retention", () => {
  it("deletes unaccepted invites 30 days after they expire or are cancelled, and keeps the rest", async () => {
    const { owner, team } = await makeTeam();
    const ownerId = await userId(owner.email);
    const t = Math.floor(Date.now() / 1000);
    const d = 86400;
    const rows = [
      ["ti_old_expired", null, t - 40 * d, t - 33 * d, null],
      ["ti_recent_expired", null, t - 20 * d, t - 13 * d, null],
      ["ti_old_cancelled", null, t - 32 * d, t - 25 * d, t - 31 * d],
      ["ti_pending", null, t - d, t + 6 * d, null],
      ["ti_old_accepted", t - 39 * d, t - 40 * d, t - 33 * d, null],
    ];
    for (const [id, acc, created, exp, can] of rows)
      await env.DB.prepare("INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, created_at, expires_at, accepted_at, cancelled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, team.id, `${id}@example.com`, id, ownerId, created, exp, acc, can).run();
    await worker.scheduled({}, env, { waitUntil() {} });
    const left = (await env.DB.prepare("SELECT id FROM team_invites WHERE team_id = ? ORDER BY id").bind(team.id).all()).results.map((r) => r.id);
    expect(left).toEqual(["ti_old_accepted", "ti_pending", "ti_recent_expired"]);
  });
});

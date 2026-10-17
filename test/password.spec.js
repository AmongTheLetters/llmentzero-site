import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, codeFromEmail, cookieHeader, cookiesFrom, form, mockOutbound, seedSkill, signUp } from "./helpers.js";
import { ITERATIONS, checkNewPassword, hashPassword, verifyPassword } from "../src/lib/password.js";

afterEach(() => vi.restoreAllMocks());
const PW = "correct horse battery staple";
const rnd = () => `pw${Math.random().toString(36).slice(2, 9)}@example.com`;

async function signInWithPassword(email, password, extra = {}) {
  return form("/signin/password", { email, password, "cf-turnstile-response": "tok:signin", next: "/account", ...extra }, extra.init || {});
}
async function setPassword(cookie, pw = PW, confirm = pw, extra = {}) {
  return form("/account/password", { new_password: pw, confirm_password: confirm, ...extra }, { headers: { Cookie: cookie } });
}
const sessionOf = (res) => `__Host-lz_session=${cookiesFrom(res)["__Host-lz_session"]}`;

describe("password hashing", () => {
  it("uses a versioned PBKDF2 format with a per-password salt and the pepper", async () => {
    const a = await hashPassword(env, PW);
    const b = await hashPassword(env, PW);
    expect(a).toMatch(new RegExp(`^pbkdf2-sha256\\$${ITERATIONS}\\$p1\\$[\\w-]{22}\\$[\\w-]{43}$`));
    expect(a).not.toBe(b);
    expect((await verifyPassword(env, PW, a)).ok).toBe(true);
    expect((await verifyPassword(env, PW + "x", a)).ok).toBe(false);
    expect((await verifyPassword({ ...env, PASSWORD_PEPPER: "other" }, PW, a)).ok).toBe(false);
  });
  it("verifies hashes made with an older iteration count and asks for a re-hash", async () => {
    const old = await hashPassword(env, PW, { iterations: 1000 });
    const r = await verifyPassword(env, PW, old);
    expect(r).toEqual({ ok: true, needsRehash: true });
    expect(await verifyPassword(env, PW, "garbage")).toEqual({ ok: false, needsRehash: false });
  });
  it("applies NIST-style rules: length, common list, no composition rules", () => {
    expect(checkNewPassword("short")).toMatch(/at least 8/);
    expect(checkNewPassword("password1")).toMatch(/too common/);
    expect(checkNewPassword("aaaaaaaaaa")).toMatch(/too common/);
    expect(checkNewPassword("x".repeat(129))).toMatch(/128 characters or fewer/);
    expect(checkNewPassword("é".repeat(64) + "plain words ok")).toBe("");
    expect(checkNewPassword("alllowercase words")).toBe("");
    expect(checkNewPassword("person@example.com", "person@example.com")).toMatch(/email/);
  });
});

describe("required password", () => {
  it("requires Password + Confirm password at sign-up, saved only after the email code", async () => {
    const page = await (await call("/signup")).text();
    expect(page).toContain(">Create a password</label>");
    expect(page).toContain(">Confirm password</label>");
    expect(page).not.toMatch(/optional\)<\/legend>.*password/i);
    expect(page).toContain('class="pw-toggle" aria-controls="new_password" aria-pressed="false"');
    expect(page).not.toMatch(/onpaste|maxlength/);
    mockOutbound();
    const missing = await form("/signup", { email: rnd(), terms: "yes", "cf-turnstile-response": "tok:signup" });
    expect(missing.status).toBe(400);
    const body = await missing.text();
    expect(body).toContain('href="#new_password">Create a password');
    expect(body).toContain('href="#confirm_password">Enter the password again to confirm it');
    vi.restoreAllMocks();
    const email = rnd();
    const { res, cookie } = await signUp(email);
    expect(res.headers.get("Location")).toBe("/account");
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = ?").bind(email).first();
    expect(row.password_hash).toMatch(/^pbkdf2-sha256\$/);
    const leftovers = await env.DB.prepare("SELECT COUNT(*) n FROM login_codes WHERE email = ? AND pending_password_hash IS NOT NULL").bind(email).first();
    expect(leftovers.n).toBe(0);
    const acct = await (await call("/account", { headers: { Cookie: cookie } })).text();
    expect(acct).toContain('href="/account/password">Change password');
    expect(acct).not.toMatch(/Remove password|password\/remove/);
    expect((await call("/account/password/remove", { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it("makes an older account without a password set one before continuing", async () => {
    const { email } = await signUp();
    await env.DB.prepare("UPDATE users SET password_hash = NULL WHERE email = ?").bind(email).run();
    const { resendCalls } = mockOutbound();
    const r1 = await form("/signin", { email, next: "/skills", "cf-turnstile-response": "tok:signin" });
    const r2 = await form("/verify", { code: codeFromEmail(resendCalls.at(-1)) }, { headers: { Cookie: cookieHeader(cookiesFrom(r1)) } });
    expect(r2.headers.get("Location")).toBe("/account/password?next=%2Fskills");
    const s = sessionOf(r2);
    await seedSkill();
    for (const p of ["/account", "/account/accept", "/download/sample-skill"]) {
      const r = await call(p, { headers: { Cookie: s } });
      expect(`${p} ${r.status} ${r.headers.get("Location")}`).toMatch(new RegExp(`^${p} 30[23] /account/password`));
    }
    const page = await (await call("/account/password?next=%2Fskills", { headers: { Cookie: s } })).text();
    expect(page).toContain("<h1>Create your password</h1>");
    expect(page).toContain('name="next" value="/skills"');
    expect(page).toContain('action="/signout"');
    const bad = await setPassword(s, PW, PW + "?", { next: "/skills" });
    expect(bad.status).toBe(400);
    const ok = await setPassword(s, PW, PW, { next: "/skills" });
    expect(ok.headers.get("Location")).toBe("/skills");
    expect((await call("/account", { headers: { Cookie: sessionOf(ok) } })).status).toBe(200);
  });

  it("gives the same answer for a wrong password or no account, and signs in with the right one", async () => {
    const { email } = await signUp();
    mockOutbound();
    const wrong = await signInWithPassword(email, "wrong password entirely");
    const nobody = await signInWithPassword(rnd(), PW, { init: { ip: "198.51.100.40" } });
    expect(wrong.status).toBe(400);
    expect(nobody.status).toBe(400);
    const m1 = (await wrong.text()).match(/That email and password don&#39;t match[^<]*/)[0];
    const m2 = (await nobody.text()).match(/That email and password don&#39;t match[^<]*/)[0];
    expect(m1).toBe(m2);
    const good = await signInWithPassword(email, PW);
    expect(good.status).toBe(303);
    expect(good.headers.get("Location")).toBe("/account");
    const sess = await env.DB.prepare("SELECT s.auth_method FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ? ORDER BY s.rowid DESC LIMIT 1").bind(email).first();
    expect(sess.auth_method).toBe("password");
  });

  it("rejects a sign-up password whose confirmation doesn't match, with an inline error", async () => {
    mockOutbound();
    const r = await form("/signup", { email: rnd(), terms: "yes", new_password: PW, confirm_password: PW + "!", "cf-turnstile-response": "tok:signup" });
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toContain('href="#confirm_password"');
    expect(body).toContain('id="confirm_password-error"');
    expect(body).toContain('aria-describedby="confirm_password-error" aria-invalid="true"');
    expect(body).toContain("The passwords don&#39;t match");
    expect(body).toMatch(/<title>Error:/);
  });

  it("locks password sign-in after 5 failures for that account, but email codes still work", async () => {
    const { cookie, email } = await signUp();
    mockOutbound();
    for (let i = 0; i < 5; i++) expect((await signInWithPassword(email, "wrong guess " + i, { init: { ip: "198.51.100." + (i + 1) } })).status).toBe(400);
    const locked = await signInWithPassword(email, PW, { init: { ip: "198.51.100.99" } });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("You can still sign in straight away with an email code");
    const { resendCalls } = mockOutbound();
    const code = await form("/signin", { email, "cf-turnstile-response": "tok:signin" });
    expect(code.status).toBe(303);
    expect(resendCalls.length).toBe(1);
  });

  it("locks per network (IP) across many accounts", async () => {
    mockOutbound();
    const ip = "192.0.2.77";
    for (let i = 0; i < 30; i++) await signInWithPassword(rnd(), "guess guess " + i, { init: { ip } });
    const r = await signInWithPassword(rnd(), "guess guess", { init: { ip } });
    expect(r.status).toBe(429);
  });

  it("changing needs the current password or a fresh code, signs out other browsers and emails a notice", async () => {
    const { cookie, email } = await signUp();
    mockOutbound();
    const pwSession = sessionOf(await signInWithPassword(email, PW));
    const other = sessionOf(await signInWithPassword(email, PW));
    const page = await (await call("/account/password", { headers: { Cookie: pwSession } })).text();
    expect(page).toContain("<h1>Change your password</h1>");
    expect(page).toContain('autocomplete="current-password"');
    expect(page).toContain("Email me a code instead");
    const missing = await setPassword(pwSession, "a brand new passphrase");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("Enter your current password");
    const bad = await setPassword(pwSession, "a brand new passphrase", undefined, { current_password: "not it at all" });
    expect(bad.status).toBe(400);
    const { resendCalls } = mockOutbound();
    const ok = await setPassword(pwSession, "a brand new passphrase", undefined, { current_password: PW });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe("/account?password=changed");
    expect(resendCalls.at(-1).body.subject).toBe("Your LlmentZero password was changed");
    // all old sessions are gone, including the one used to change it
    for (const c of [pwSession, other, cookie]) expect((await call("/account", { headers: { Cookie: c } })).status).toBe(303);
    const fresh = sessionOf(ok);
    const acct = await (await call("/account?password=changed", { headers: { Cookie: fresh } })).text();
    expect(acct).toContain('role="status">Your password has been changed');
    expect((await signInWithPassword(email, PW)).status).toBe(400);
    expect((await signInWithPassword(email, "a brand new passphrase")).status).toBe(303);
  });

  it("a fresh email-code session can change the password without the current one (forgot password)", async () => {
    const { cookie, email } = await signUp();
    const forgot = await (await call("/forgot-password")).text();
    expect(forgot).toContain("<h1>Reset your password</h1>");
    expect(forgot).toContain('name="next" value="/account/password"');
    const { resendCalls } = mockOutbound();
    const r1 = await form("/signin", { email, next: "/account/password", "cf-turnstile-response": "tok:signin" });
    const r2 = await form("/verify", { code: codeFromEmail(resendCalls.at(-1)) }, { headers: { Cookie: cookieHeader(cookiesFrom(r1)) } });
    expect(r2.headers.get("Location")).toBe("/account/password");
    const s = sessionOf(r2);
    const page = await (await call("/account/password", { headers: { Cookie: s } })).text();
    expect(page).not.toContain('id="current_password"');
    expect((await setPassword(s, "reset via email code")).status).toBe(303);
    expect((await signInWithPassword(email, "reset via email code")).status).toBe(303);
  });

  it("forgot password for an unknown email looks exactly like a known one", async () => {
    const { resendCalls } = mockOutbound();
    const r = await form("/signin", { email: rnd(), next: "/account/password", "cf-turnstile-response": "tok:signin" });
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/verify");
    expect(resendCalls.length).toBe(1); // the "no account" notice goes to the address owner only
  });

  it("sign-in page offers both methods and the password option works without JavaScript", async () => {
    const code = await (await call("/signin")).text();
    expect(code).toContain('class="btn ghost" href="/signin?method=password">Use password instead');
    const pw = await (await call("/signin?method=password")).text();
    expect(pw).toContain('action="/signin/password"');
    expect(pw).toContain('autocomplete="username"');
    expect(pw).toContain('autocomplete="current-password"');
    expect(pw).toContain('href="/forgot-password">Forgot your password?');
    expect(pw).toContain('<script src="/assets/password-toggle.js" defer></script>');
    expect(pw).toContain("hidden>"); // toggle hidden until the script runs
  });

  it("rejects cross-site password posts", async () => {
    const r = await form("/signin/password", { email: rnd(), password: PW }, { headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
});

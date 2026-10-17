import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, codeFromEmail, cookieHeader, cookiesFrom, form, mockOutbound, signUp } from "./helpers.js";
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

describe("optional password", () => {
  it("is optional at sign-up and the account page offers Set a password", async () => {
    const page = await (await call("/signup")).text();
    expect(page).toContain("Use a password too? (optional)");
    expect(page).toContain('autocomplete="new-password"');
    expect(page).toContain('class="pw-toggle" aria-controls="new_password" aria-pressed="false"');
    expect(page).toContain("Show password");
    expect(page).not.toMatch(/onpaste|maxlength/);
    const { cookie } = await signUp();
    const acct = await (await call("/account", { headers: { Cookie: cookie } })).text();
    expect(acct).toContain("A password is optional");
    expect(acct).toContain('href="/account/password">Set a password');
    const pw = await (await call("/account/password", { headers: { Cookie: cookie } })).text();
    expect(pw).toContain("<h1>Set a password</h1>");
    expect(pw).toContain('id="confirm_password"');
    expect(pw).not.toContain('id="current_password"');
  });

  it("saves a password chosen on the sign-up form only after the email code", async () => {
    const email = rnd();
    const { res } = await signUp(email, { new_password: PW, confirm_password: PW });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = ?").bind(email).first();
    expect(row.password_hash).toMatch(/^pbkdf2-sha256\$/);
    const leftovers = await env.DB.prepare("SELECT COUNT(*) n FROM login_codes WHERE email = ? AND pending_password_hash IS NOT NULL").bind(email).first();
    expect(leftovers.n).toBe(0);
    mockOutbound();
    const r = await signInWithPassword(email, PW);
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/account");
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

  it("sets, signs in, and gives the same answer for a wrong password, no password, or no account", async () => {
    const { cookie, email } = await signUp();
    mockOutbound();
    // no password yet
    const before = await signInWithPassword(email, PW);
    const nobody = await signInWithPassword(rnd(), PW, { init: { ip: "198.51.100.40" } });
    expect(before.status).toBe(400);
    expect(nobody.status).toBe(400);
    const m1 = (await before.text()).match(/That email and password don&#39;t match[^<]*/)[0];
    const m2 = (await nobody.text()).match(/That email and password don&#39;t match[^<]*/)[0];
    expect(m1).toBe(m2);

    const mismatch = await setPassword(cookie, PW, "different words here");
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("The passwords don&#39;t match");

    const ok = await setPassword(cookie);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe("/account?password=set");
    const wrong = await signInWithPassword(email, "wrong password entirely");
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("That email and password don&#39;t match");
    const good = await signInWithPassword(email, PW);
    expect(good.status).toBe(303);
    const sess = await env.DB.prepare("SELECT s.auth_method FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ? ORDER BY s.rowid DESC LIMIT 1").bind(email).first();
    expect(sess.auth_method).toBe("password");
  });

  it("locks password sign-in after 5 failures for that account, but email codes still work", async () => {
    const { cookie, email } = await signUp();
    await setPassword(cookie);
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
    await setPassword(cookie);
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
    await setPassword(cookie);
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

  it("removes a password (with current password), signs out other browsers and emails a notice", async () => {
    const { cookie, email } = await signUp();
    await setPassword(cookie);
    mockOutbound();
    const s = sessionOf(await signInWithPassword(email, PW));
    const page = await (await call("/account/password/remove", { headers: { Cookie: s } })).text();
    expect(page).toContain("<h1>Remove your password</h1>");
    expect((await form("/account/password/remove", { current_password: "nope nope nope" }, { headers: { Cookie: s } })).status).toBe(400);
    const { resendCalls } = mockOutbound();
    const ok = await form("/account/password/remove", { current_password: PW }, { headers: { Cookie: s } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe("/account?password=removed");
    expect(resendCalls.at(-1).body.subject).toBe("Your LlmentZero password was removed");
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = ?").bind(email).first();
    expect(row.password_hash).toBeNull();
    expect((await call("/account", { headers: { Cookie: s } })).status).toBe(303);
    expect((await signInWithPassword(email, PW)).status).toBe(400);
  });

  it("sign-in page offers both methods and the password option works without JavaScript", async () => {
    const code = await (await call("/signin")).text();
    expect(code).toContain('href="/signin?method=password">Use password instead');
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

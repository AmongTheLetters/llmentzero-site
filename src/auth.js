// Passwordless sign-up / sign-in with emailed 6-digit codes, clickwrap acceptance and account pages.
import { html, redirect, readForm, sameOrigin } from "./lib/http.js";
import { CHECKBOX_LABEL, NEW_PASSWORD_HINT, emailField, errorSummary, fieldError, layout, passwordField, termsCheckbox, turnstileWidget } from "./lib/views.js";
import { EmailError, codeEmail, noAccountEmail, passwordChangedEmail, sendEmail } from "./lib/email.js";
import { verifyTurnstile } from "./lib/turnstile.js";
import { LIMITS, PASSWORD_LIMITS, hit, peek } from "./lib/ratelimit.js";
import { PENDING_COOKIE, acceptedCurrentTerms, createSession, destroyAllSessions, destroySession, getSession } from "./lib/session.js";
import { checkNewPassword, dummyVerify, hashPassword, normalise, verifyPassword } from "./lib/password.js";
import { cookie, esc, ipHash, isValidEmail, normaliseEmail, now, parseCookies, randomId, safeNext, sha256Hex, sixDigitCode, userAgent, emailKey } from "./lib/util.js";
import { LEGAL } from "./generated/legal.js";
import { assignedToUser } from "./lib/licences.js";

const CODE_TTL = 600;

export async function audit(env, event, { userId = null, detail = null, ip = null } = {}) {
  await env.DB.prepare("INSERT INTO audit_log (id, at, event, user_id, detail, ip_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(randomId("a_"), now(), event, userId, detail ? String(detail).slice(0, 500) : null, ip)
    .run();
}

export const forbidden = () => html(layout({ title: "Something went wrong", body: `<h1>Please try again</h1><p>We couldn't confirm that form came from this website. Please go back, reload the page and try again.</p>` }), { status: 403 });

function nextParam(url) {
  return safeNext(url.searchParams.get("next") || "/account");
}

// ---------- Sign up ----------
function signupPage(env, { errors = {}, email = "", terms = false, marketing = false, next = "/account" } = {}) {
  return layout({
    title: errors && Object.keys(errors).length ? "Error: Create your account" : "Create your account",
    turnstile: true,
    passwords: true,
    body: `${errorSummary(errors)}<p class="eyebrow">Free account</p><h1>Create your account</h1>
<p class="lead">An account lets you download LlmentZero skill files. Personal use is free.</p>

<form method="post" action="/signup" novalidate class="stack">
<input type="hidden" name="next" value="${esc(next)}">
${emailField(errors, email, { hint: "We'll email you a 6-digit code to confirm it's yours.", autocomplete: "username" })}
${passwordField(errors, { id: "new_password", label: "Create a password", autocomplete: "new-password", hint: NEW_PASSWORD_HINT })}
${passwordField(errors, { id: "confirm_password", label: "Confirm password", autocomplete: "new-password" })}
${termsCheckbox(errors, terms)}
<fieldset class="field"><legend>Email updates (optional)</legend><div class="check"><input id="marketing" name="marketing" type="checkbox" value="yes"${marketing ? " checked" : ""} aria-describedby="marketing-hint"><label for="marketing">Yes, email me about new skills and offers from LlmentZero.</label></div><p class="hint" id="marketing-hint">Optional. You can unsubscribe at any time. We never share your email.</p></fieldset>
${turnstileWidget(env, "signup", errors)}
<button type="submit" class="btn">Create your account</button>
</form>
<p>Already have an account? <a href="/signin${next !== "/account" ? `?next=${encodeURIComponent(next)}` : ""}">Sign in</a></p>`,
  });
}

export async function getSignup(request, env) {
  const { user } = await getSession(env, request);
  const url = new URL(request.url);
  if (user) return redirect(nextParam(url));
  return html(signupPage(env, { next: nextParam(url) }));
}

export async function postSignup(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const f = await readForm(request);
  const email = normaliseEmail(f.get("email"));
  const terms = f.get("terms") === "yes";
  const marketing = f.get("marketing") === "yes";
  const next = safeNext(f.get("next"));
  const errors = {};
  if (!email) errors.email = "Enter your email address";
  else if (!isValidEmail(email)) errors.email = "Enter an email address in the right format, like name@example.com";
  if (!terms) errors.terms = "Tick the box to agree to the Terms of Service and Skill Licence";
  const pw = f.get("new_password") || "";
  const confirm = f.get("confirm_password") || "";
  const problem = checkNewPassword(pw, email);
  if (problem) errors.new_password = problem === "Enter a password" ? "Create a password" : problem;
  if (!confirm) errors.confirm_password = "Enter the password again to confirm it";
  else if (!problem && normalise(confirm) !== normalise(pw)) errors.confirm_password = "The passwords don't match. Enter the same password in both fields";
  if (!errors.email) {
    const ts = await verifyTurnstile(env, request, f.get("cf-turnstile-response"), "signup");
    if (!ts.ok) errors.turnstile = "The automatic person check didn't finish. Please wait for it to complete, then send the form again";
  }
  if (Object.keys(errors).length) return html(signupPage(env, { errors, email, terms, marketing, next }), { status: 400 });
  const pendingPasswordHash = await hashPassword(env, pw);
  return startCode(request, env, { email, purpose: "signup", termsTickedAt: now(), marketing, next, pendingPasswordHash, rerender: (errs) => signupPage(env, { errors: errs, email, terms, marketing, next }) });
}

// ---------- Sign in ----------
// Email code is the default. "Use password instead" switches to password sign-in (a plain link, so it
// works without JavaScript). Neither path reveals whether an account exists.
function signinPage(env, { errors = {}, email = "", next = "/account", method = "code", forgot = false } = {}) {
  const q = (m) => {
    const params = new URLSearchParams();
    if (m === "password") params.set("method", "password");
    if (next !== "/account") params.set("next", next);
    const s = params.toString();
    return s ? `?${s}` : "";
  };
  const hasErr = errors && Object.keys(errors).length;
  if (method === "password") {
    return layout({
      title: hasErr ? "Error: Sign in with your password" : "Sign in with your password",
      turnstile: true,
      passwords: true,
      body: `${errorSummary(errors)}<p class="eyebrow">Welcome back</p><h1>Sign in</h1>
<p class="method-switch"><a class="btn ghost" href="/signin${q("code")}">Email me a code instead</a></p>
<form method="post" action="/signin/password" novalidate class="stack">
<input type="hidden" name="next" value="${esc(next)}">
<div class="field${errors?.email ? " has-error" : ""}"><label for="email">Email address</label>${fieldError(errors, "email")}<input id="email" name="email" type="email" autocomplete="username" spellcheck="false" value="${esc(email)}"${errors?.email ? ' aria-invalid="true" aria-describedby="email-error"' : ""}></div>
${passwordField(errors, { id: "password", label: "Password", autocomplete: "current-password" })}
${turnstileWidget(env, "signin", errors)}
<button type="submit" class="btn">Sign in</button>
</form>
<p><a href="/forgot-password${next !== "/account" ? `?next=${encodeURIComponent(next)}` : ""}">Forgot your password?</a></p>
<p>New here? <a href="/signup${next !== "/account" ? `?next=${encodeURIComponent(next)}` : ""}">Create a free account</a></p>`,
    });
  }
  return layout({
    title: hasErr ? `Error: ${forgot ? "Reset your password" : "Sign in"}` : forgot ? "Reset your password" : "Sign in",
    turnstile: true,
    body: `${errorSummary(errors)}<p class="eyebrow">${forgot ? "Forgot your password?" : "Welcome back"}</p><h1>${forgot ? "Reset your password" : "Sign in"}</h1>
${forgot ? `<p>We'll email you a 6-digit code. Once you've entered it, you can choose a new password.</p>` : `<p class="method-switch"><a class="btn ghost" href="/signin${q("password")}">Use password instead</a></p>`}
<form method="post" action="/signin" novalidate class="stack">
<input type="hidden" name="next" value="${esc(forgot ? "/account/password" : next)}">
${emailField(errors, email)}
${turnstileWidget(env, "signin", errors)}
<button type="submit" class="btn">Email me a code</button>
</form>
<p>New here? <a href="/signup${next !== "/account" ? `?next=${encodeURIComponent(next)}` : ""}">Create a free account</a></p>`,
  });
}

export async function getSignin(request, env) {
  const { user } = await getSession(env, request);
  const url = new URL(request.url);
  if (user) return redirect(nextParam(url));
  return html(signinPage(env, { next: nextParam(url), method: url.searchParams.get("method") === "password" ? "password" : "code" }));
}

export async function getForgot(request, env) {
  const url = new URL(request.url);
  return html(signinPage(env, { next: nextParam(url), forgot: true }));
}

export async function postSignin(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const f = await readForm(request);
  const email = normaliseEmail(f.get("email"));
  const next = safeNext(f.get("next"));
  const forgot = next === "/account/password";
  const errors = {};
  if (!email) errors.email = "Enter your email address";
  else if (!isValidEmail(email)) errors.email = "Enter an email address in the right format, like name@example.com";
  if (!errors.email) {
    const ts = await verifyTurnstile(env, request, f.get("cf-turnstile-response"), "signin");
    if (!ts.ok) errors.turnstile = "The automatic person check didn't finish. Please wait for it to complete, then send the form again";
  }
  if (Object.keys(errors).length) return html(signinPage(env, { errors, email, next, forgot }), { status: 400 });
  return startCode(request, env, { email, purpose: "signin", next, rerender: (errs) => signinPage(env, { errors: errs, email, next, forgot }) });
}

const WRONG_PASSWORD = "That email and password don't match. Check them and try again, or sign in with an email code instead";
const LOCKED = "For your security, password sign-in is paused for up to 15 minutes after several unsuccessful tries. You can still sign in straight away with an email code";

/** Counts a failed password attempt against the account (by email hash) and the network. */
async function passwordFailure(env, emailHash, ip) {
  await hit(env, `pwfail:acct:${emailHash}`, PASSWORD_LIMITS.failuresPerAccount, PASSWORD_LIMITS.accountWindow);
  await hit(env, `pwfail:ip:${ip}`, PASSWORD_LIMITS.failuresPerIp, PASSWORD_LIMITS.ipWindow);
}

async function passwordLocked(env, emailHash, ip) {
  const [a, n] = await Promise.all([
    peek(env, `pwfail:acct:${emailHash}`, PASSWORD_LIMITS.accountWindow),
    peek(env, `pwfail:ip:${ip}`, PASSWORD_LIMITS.ipWindow),
  ]);
  return a >= PASSWORD_LIMITS.failuresPerAccount || n >= PASSWORD_LIMITS.failuresPerIp;
}

export async function postSigninPassword(request, env, ctx) {
  if (!sameOrigin(request)) return forbidden();
  const f = await readForm(request);
  const email = normaliseEmail(f.get("email"));
  const password = f.get("password") || "";
  const next = safeNext(f.get("next"));
  const page = (errors, status = 400) => html(signinPage(env, { errors, email, next, method: "password" }), { status });
  const errors = {};
  if (!email) errors.email = "Enter your email address";
  else if (!isValidEmail(email)) errors.email = "Enter an email address in the right format, like name@example.com";
  if (!password) errors.password = "Enter your password";
  if (!errors.email && !errors.password) {
    const ts = await verifyTurnstile(env, request, f.get("cf-turnstile-response"), "signin");
    if (!ts.ok) errors.turnstile = "The automatic person check didn't finish. Please wait for it to complete, then send the form again";
  }
  if (Object.keys(errors).length) return page(errors);

  const ip = await ipHash(env, request);
  const emailHash = await emailKey(env, email);
  if (await passwordLocked(env, emailHash, ip)) {
    await audit(env, "password.locked", { ip });
    return page({ password: LOCKED }, 429);
  }
  const user = await env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ? AND closed_at IS NULL").bind(email).first();
  // Same work whether or not the account exists or has a password, so timing reveals nothing.
  const result = user && user.password_hash ? await verifyPassword(env, password, user.password_hash) : await dummyVerify(env, password);
  if (!result.ok) {
    await passwordFailure(env, emailHash, ip);
    await audit(env, "password.failed", { userId: user?.id || null, ip });
    return page({ password: WRONG_PASSWORD });
  }
  const t = now();
  if (result.needsRehash) {
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(env, password), user.id).run();
  }
  await env.DB.prepare("UPDATE users SET last_sign_in_at = ? WHERE id = ?").bind(t, user.id).run();
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`pwfail:acct:${emailHash}`).run();
  const sessionCookie = await createSession(env, request, user.id, { method: "password" });
  await audit(env, "signin.password", { userId: user.id, ip });
  const dest = (await acceptedCurrentTerms(env, user.id)) ? next : `/account/accept?next=${encodeURIComponent(next)}`;
  return redirect(dest, { cookies: [sessionCookie] });
}

// ---------- Set / change password ----------
const FRESH_CODE_WINDOW = 15 * 60;

function passwordPage(user, { errors = {}, fresh = false, codeSent = false, next = "/account" } = {}) {
  const changing = user.hasPassword;
  const needCurrent = changing && !fresh;
  const title = changing ? "Change your password" : "Create your password";
  return layout({
    title: errors && Object.keys(errors).length ? `Error: ${title}` : title,
    user,
    passwords: true,
    body: `${errorSummary(errors)}<p class="eyebrow">Account</p><h1>${title}</h1>
${changing ? "" : `<p>Every LlmentZero account now needs a password. Choose one to continue. You can still sign in with an email code whenever you like.</p>`}
${codeSent ? `<p class="notice-ok" role="status">We've emailed you a 6-digit code. Enter it on the next page, then come back here to choose your new password.</p>` : ""}
<form method="post" action="/account/password" novalidate class="stack">
<input type="hidden" name="next" value="${esc(next)}">
<input type="email" name="username" value="${esc(user.email)}" autocomplete="username" hidden readonly tabindex="-1" aria-hidden="true">
${needCurrent ? passwordField(errors, { id: "current_password", label: "Current password", autocomplete: "current-password" }) : ""}
${passwordField(errors, { id: "new_password", label: changing ? "New password" : "Password", autocomplete: "new-password", hint: NEW_PASSWORD_HINT })}
${passwordField(errors, { id: "confirm_password", label: changing ? "Confirm new password" : "Confirm password", autocomplete: "new-password" })}
<button type="submit" class="btn">${changing ? "Change password" : "Save password"}</button>
</form>
${needCurrent ? codeInsteadForm("/account/password") : ""}
${changing ? `<p><a href="/account">Back to your account</a></p>` : `<form method="post" action="/signout"><p>Not now? <button type="submit" class="linklike">Sign out</button></p></form>`}`,
  });
}

function isFresh(user) {
  return !!user.codeVerifiedAt && now() - user.codeVerifiedAt <= FRESH_CODE_WINDOW;
}

export async function getPassword(request, env) {
  const { user, cookies } = await getSession(env, request);
  if (!user) return redirect("/signin?next=/account/password");
  const url = new URL(request.url);
  const codeSent = url.searchParams.get("code") === "sent";
  return html(passwordPage(user, { fresh: isFresh(user), codeSent, next: nextParam(url) }), { cookies });
}

export async function postPassword(request, env, ctx) {
  if (!sameOrigin(request)) return forbidden();
  const { user } = await getSession(env, request);
  if (!user) return redirect("/signin?next=/account/password");
  const f = await readForm(request);
  const fresh = isFresh(user);
  const next = safeNext(f.get("next"));
  const needCurrent = user.hasPassword && !fresh;
  const current = f.get("current_password") || "";
  const pw = f.get("new_password") || "";
  const confirm = f.get("confirm_password") || "";
  const errors = {};
  const ip = await ipHash(env, request);
  const emailHash = await emailKey(env, user.email);
  if (needCurrent && !current) errors.current_password = "Enter your current password";
  const problem = checkNewPassword(pw, user.email);
  if (problem) errors.new_password = problem;
  if (!confirm) errors.confirm_password = "Enter the new password again to confirm it";
  else if (!problem && normalise(confirm) !== normalise(pw)) errors.confirm_password = "The passwords don't match. Enter the same password in both fields";
  if (Object.keys(errors).length) return html(passwordPage(user, { errors, fresh, next }), { status: 400 });

  if (needCurrent) {
    if (await passwordLocked(env, emailHash, ip)) return html(passwordPage(user, { errors: { current_password: LOCKED }, fresh, next }), { status: 429 });
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
    const ok = (await verifyPassword(env, current, row?.password_hash)).ok;
    if (!ok) {
      await passwordFailure(env, emailHash, ip);
      await audit(env, "password.change_failed", { userId: user.id, ip });
      return html(passwordPage(user, { errors: { current_password: "That isn't your current password. Try again, or use an email code instead" }, fresh, next }), { status: 400 });
    }
  }
  const t = now();
  await env.DB.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").bind(await hashPassword(env, pw), t, user.id).run();
  // Sign out every browser, then sign this one back in.
  await destroyAllSessions(env, user.id);
  const sessionCookie = await createSession(env, request, user.id, { method: "password" });
  await audit(env, user.hasPassword ? "password.changed" : "password.set", { userId: user.id, ip });
  if (user.hasPassword) {
    const notice = passwordChangedEmail({ origin: new URL(request.url).origin });
    const send = sendEmail(env, { to: user.email, ...notice, idempotencyKey: `pwchanged-${user.id}-${t}` }).catch((err) => audit(env, "email.failed", { userId: user.id, detail: `password notice: ${err.message}` }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
  }
  const after = user.hasPassword ? "/account?password=changed" : next === "/account" ? "/account?password=set" : next;
  return redirect(after, { cookies: [sessionCookie] });
}

function codeInsteadForm(next) {
  return `<form method="post" action="/account/password/code"><input type="hidden" name="next" value="${esc(next)}"><p>Forgot your current password? <button type="submit" class="linklike">Email me a code instead</button></p></form>`;
}

/** Signed-in user forgot their current password: email them a code so they can change it. */
export async function postPasswordCode(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const { user } = await getSession(env, request);
  if (!user) return redirect("/signin?next=/account/password");
  const f = await readForm(request);
  return startCode(request, env, {
    email: user.email,
    purpose: "signin",
    next: "/account/password",
    rerender: (errs) => passwordPage(user, { errors: { new_password: errs.email || Object.values(errs)[0] } }),
  });
}

function limitPage(message) {
  return html(layout({ title: "Please wait a little", body: `<h1>Please wait a little</h1><p>${message}</p><p>If you're stuck, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a> and we'll help.</p>` }), { status: 429, headers: { "Retry-After": "3600" } });
}

async function startCode(request, env, { email, purpose, termsTickedAt = null, marketing = false, next, pendingPasswordHash = null, rerender }) {
  const ip = await ipHash(env, request);
  if (!(await hit(env, `code:ip:${ip}`, LIMITS.codePerIpHour, 3600)) || !(await hit(env, `code:email:${await emailKey(env, email)}`, LIMITS.codePerEmailHour, 3600))) {
    await audit(env, "code.rate_limited", { detail: purpose, ip });
    return limitPage("We've sent a lot of codes to this address or network in the last hour. Please try again in an hour.");
  }
  const id = randomId("c_");
  const origin = new URL(request.url).origin;
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND closed_at IS NULL").bind(email).first();

  if (purpose === "signin" && !existing) {
    // Don't reveal whether an account exists: the browser sees the same "check your email" page.
    try {
      await sendEmail(env, { to: email, ...noAccountEmail({ origin }), idempotencyKey: `noacct-${id}` });
    } catch (err) {
      return emailFailure(env, err, rerender, ip);
    }
    await audit(env, "signin.no_account", { ip });
    return redirect("/verify", { cookies: [cookie(PENDING_COOKIE, id, { maxAge: CODE_TTL })] });
  }

  const code = sixDigitCode();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO login_codes (id, email, code_hash, purpose, created_at, expires_at, terms_ticked_at, marketing_opt_in, ip_hash, user_agent, next_path, pending_password_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, email, await sha256Hex(`${id}:${code}`), purpose, t, t + CODE_TTL, termsTickedAt, marketing ? 1 : 0, ip, userAgent(request), next, pendingPasswordHash).run();
  try {
    await sendEmail(env, { to: email, ...codeEmail({ code, purpose: existing ? "signin" : purpose }), idempotencyKey: `code-${id}` });
  } catch (err) {
    await env.DB.prepare("DELETE FROM login_codes WHERE id = ?").bind(id).run();
    return emailFailure(env, err, rerender, ip);
  }
  await audit(env, "code.sent", { detail: purpose, ip });
  return redirect("/verify", { cookies: [cookie(PENDING_COOKIE, id, { maxAge: CODE_TTL })] });
}

async function emailFailure(env, err, rerender, ip) {
  await audit(env, "email.failed", { detail: err instanceof EmailError ? `${err.status || ""} ${err.message}` : String(err), ip });
  const msg =
    err instanceof EmailError && err.status === 429
      ? "We've reached today's limit for sign-in emails. Please try again tomorrow, or email llmentzero@gmail.com and we'll help"
      : "We couldn't send the email just now. Please try again in a few minutes";
  return html(rerender({ email: msg }), { status: 503 });
}

// ---------- Verify code ----------
function verifyPage({ errors = {}, expired = false } = {}) {
  return layout({
    title: errors && Object.keys(errors).length ? "Error: Enter your code" : "Enter your code",
    body: `${errorSummary(errors)}<p class="eyebrow">Check your email</p><h1>Enter your code</h1>
<p>If there's an account for that address, we've emailed it a 6-digit code. If you were creating an account, the code is on its way. It can take a minute to arrive, so check your spam folder too.</p>
<p>The code works once, for 10 minutes.</p>
${expired ? `<p><a class="btn" href="/signin">Get a new code</a></p>` : `<form method="post" action="/verify" novalidate class="stack">
<div class="field${errors.code ? " has-error" : ""}"><label for="code">6-digit code</label>${fieldError(errors, "code")}<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12" class="code-input"${errors.code ? ' aria-invalid="true" aria-describedby="code-error"' : ""}></div>
<button type="submit" class="btn">Continue</button>
</form>`}
<p>No code? <a href="/signin">Send a new code</a> or <a href="/signup">create an account</a>.</p>`,
  });
}

export async function getVerify(request, env) {
  if (!parseCookies(request)[PENDING_COOKIE]) return redirect("/signin");
  return html(verifyPage());
}

export async function postVerify(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const pendingId = parseCookies(request)[PENDING_COOKIE];
  if (!pendingId) return redirect("/signin");
  const ip = await ipHash(env, request);
  if (!(await hit(env, `verify:ip:${ip}`, LIMITS.verifyPerIpHour, 3600))) return limitPage("Too many tries from this network. Please wait an hour and request a new code.");
  const f = await readForm(request);
  const code = String(f.get("code") || "").replace(/\D/g, "");
  if (code.length !== 6) return html(verifyPage({ errors: { code: "Enter the 6-digit code from the email" } }), { status: 400 });

  const t = now();
  const row = await env.DB.prepare("SELECT * FROM login_codes WHERE id = ? AND used_at IS NULL").bind(String(pendingId).slice(0, 64)).first();
  const expiredMsg = { code: "This code has expired or has been used too many times. Get a new code to continue" };
  if (!row || row.expires_at <= t || row.attempts >= LIMITS.codeAttempts) {
    if (!row) await audit(env, "verify.unknown", { ip });
    // Unknown id (for example a sign-in for an address with no account) looks like a wrong code.
    if (!row) return html(verifyPage({ errors: { code: "That code isn't right. Check the email and try again" } }), { status: 400 });
    return html(verifyPage({ errors: expiredMsg, expired: true }), { status: 400 });
  }
  const ok = (await sha256Hex(`${row.id}:${code}`)) === row.code_hash;
  if (!ok) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    const left = LIMITS.codeAttempts - row.attempts - 1;
    if (left <= 0) return html(verifyPage({ errors: expiredMsg, expired: true }), { status: 400 });
    return html(verifyPage({ errors: { code: `That code isn't right. Check the email and try again (${left} ${left === 1 ? "try" : "tries"} left)` } }), { status: 400 });
  }
  const used = await env.DB.prepare("UPDATE login_codes SET used_at = ?, pending_password_hash = NULL WHERE id = ? AND used_at IS NULL").bind(t, row.id).run();
  if (!used.meta?.changes) return html(verifyPage({ errors: expiredMsg, expired: true }), { status: 400 });

  let user = await env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ? AND closed_at IS NULL").bind(row.email).first();
  if (row.purpose === "signup") {
    if (!user) {
      const id = randomId("u_");
      // The sign-up password is only saved once the emailed code proves the address is theirs.
      await env.DB.prepare("INSERT INTO users (id, email, marketing_consent, marketing_consent_at, created_at, password_hash, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, row.email, row.marketing_opt_in, row.marketing_opt_in ? row.terms_ticked_at : null, t, row.pending_password_hash || null, row.pending_password_hash ? t : null).run();
      if (row.pending_password_hash) await audit(env, "password.set", { userId: id, ip });
      user = { id, password_hash: row.pending_password_hash };
      await audit(env, "user.created", { userId: id, ip });
    } else {
      // Existing account signing up again: only fill in a missing password (never replace one).
      if (!user.password_hash && row.pending_password_hash) {
        await env.DB.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ? AND password_hash IS NULL").bind(row.pending_password_hash, t, user.id).run();
        user.password_hash = row.pending_password_hash;
        await audit(env, "password.set", { userId: user.id, ip });
      }
      if (row.marketing_opt_in) {
        await env.DB.prepare("UPDATE users SET marketing_consent = 1, marketing_consent_at = ? WHERE id = ?").bind(row.terms_ticked_at, user.id).run();
      }
    }
    await recordAcceptance(env, { userId: user.id, email: row.email, method: "signup checkbox", acceptedAt: row.terms_ticked_at || t, ipHash: row.ip_hash, ua: row.user_agent });
  }
  if (!user) return html(verifyPage({ errors: { code: "We couldn't find that account. Please create an account" }, expired: true }), { status: 400 });

  await env.DB.prepare("UPDATE users SET last_sign_in_at = ? WHERE id = ?").bind(t, user.id).run();
  const sessionCookie = await createSession(env, request, user.id);
  await audit(env, "signin.success", { userId: user.id, ip });
  const next = safeNext(row.next_path);
  let dest = (await acceptedCurrentTerms(env, user.id)) ? next : `/account/accept?next=${encodeURIComponent(next)}`;
  // Passwords are required. Accounts without one (created before passwords) must set one first.
  if (!user.password_hash && next !== "/account/password") dest = `/account/password?next=${encodeURIComponent(dest)}`;
  return redirect(dest, { cookies: [sessionCookie, cookie(PENDING_COOKIE, "", { maxAge: 0 })] });
}

export async function recordAcceptance(env, { userId, email, method, acceptedAt, ipHash: ip, ua }) {
  await env.DB.prepare(
    `INSERT INTO terms_acceptances (id, user_id, email, terms_version, terms_sha256, licence_version, licence_sha256, privacy_version, privacy_sha256, method, checkbox_label, accepted_at, recorded_at, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(randomId("t_"), userId, email, LEGAL.terms.version, LEGAL.terms.sha256, LEGAL.licence.version, LEGAL.licence.sha256, LEGAL.privacy.version, LEGAL.privacy.sha256, method, CHECKBOX_LABEL, acceptedAt, now(), ip, ua).run();
}

// ---------- Re-accept changed terms ----------
function acceptPage({ errors = {}, next, user = null }) {
  return layout({
    title: errors && Object.keys(errors).length ? "Error: Updated terms" : "Updated terms",
    user,
    body: `${errorSummary(errors)}<h1>We've updated our terms</h1><p>Please read the current versions and agree to keep using your account. Downloads need the current terms.</p>
<form method="post" action="/account/accept" novalidate class="stack"><input type="hidden" name="next" value="${esc(next)}">${termsCheckbox(errors)}<button type="submit" class="btn">Agree and continue</button></form>
<form method="post" action="/signout"><button type="submit" class="btn ghost">Sign out instead</button></form>`,
  });
}

export async function getAccept(request, env) {
  const { user, cookies } = await getSession(env, request);
  const url = new URL(request.url);
  if (!user) return redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
  if (!user.hasPassword) return redirect(`/account/password?next=${encodeURIComponent(url.pathname + url.search)}`);
  if (await acceptedCurrentTerms(env, user.id)) return redirect(nextParam(url));
  return html(acceptPage({ next: nextParam(url), user }), { cookies });
}

export async function postAccept(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const { user } = await getSession(env, request);
  if (!user) return redirect("/signin");
  if (!user.hasPassword) return redirect("/account/password");
  const f = await readForm(request);
  const next = safeNext(f.get("next"));
  if (f.get("terms") !== "yes") return html(acceptPage({ errors: { terms: "Tick the box to agree to the Terms of Service and Skill Licence" }, next, user }), { status: 400 });
  await recordAcceptance(env, { userId: user.id, email: user.email, method: "re-accept checkbox", acceptedAt: now(), ipHash: await ipHash(env, request), ua: userAgent(request) });
  return redirect(next);
}

// ---------- Account ----------
export const fmtDate = (s) => new Date(s * 1000).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });

export async function getAccount(request, env) {
  const { user, cookies } = await getSession(env, request);
  if (!user) return redirect("/signin?next=/account");
  if (!user.hasPassword) return redirect("/account/password");
  if (!(await acceptedCurrentTerms(env, user.id))) return redirect("/account/accept?next=/account");
  const pwFlag = new URL(request.url).searchParams.get("password");
  const pwNotice = pwFlag === "changed" ? "Your password has been changed. Other browsers have been signed out." : pwFlag === "set" ? "Your password is saved. You can sign in with it or with an email code." : "";
  const [lic, acc, dls, team, assigned] = await Promise.all([
    env.DB.prepare("SELECT product_name, licence_type, devices, assigned_devices, status, order_id, purchased_at FROM licences WHERE email = ? ORDER BY purchased_at DESC").bind(user.email).all(),
    env.DB.prepare("SELECT terms_version, licence_version, accepted_at FROM terms_acceptances WHERE user_id = ? ORDER BY accepted_at DESC LIMIT 1").bind(user.id).first(),
    env.DB.prepare("SELECT d.slug, d.version, d.downloaded_at, s.title FROM downloads d LEFT JOIN skills s ON s.slug = d.slug WHERE d.user_id = ? ORDER BY d.downloaded_at DESC LIMIT 10").bind(user.id).all(),
    env.DB.prepare("SELECT t.id, t.name, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?").bind(user.id).first(),
    assignedToUser(env, user.id),
  ]);
  const statusText = { active: "Active", refunded: "Refunded (licence ended)", revoked: "Revoked" };
  const assignedRows = assigned || [];
  const sumWhere = (fn) => assignedRows.filter(fn).reduce((n, r) => n + Number(r.devices || 0), 0);
  const fromTeam = team ? sumWhere((r) => r.team_id === team.id && r.status === "active") : 0;
  const kept = sumWhere((r) => (!team || r.team_id !== team.id) && r.status === "active");
  const ended = sumWhere((r) => r.status !== "active");
  const dev = (n) => `${n} device${n === 1 ? "" : "s"}`;
  const assignedText = [
    fromTeam ? `<p><strong>Licensed through ${esc(team.name)}:</strong> ${dev(fromTeam)} assigned to your account.</p>` : "",
    kept ? `<p>${dev(kept)} assigned to your account${team ? " by another team" : ""}. ${kept === 1 ? "It stays" : "They stay"} with your account permanently.</p>` : "",
    ended ? `<p>${dev(ended)} that had been assigned to you ended because the order ${ended === 1 ? "it" : "they"} came from was refunded.</p>` : "",
  ].join("");
  const teamText = team
    ? team.role === "owner"
      ? `<p>You own the team <strong>${esc(team.name)}</strong>${/[.!]$/.test(team.name) ? "" : "."}</p><p><a href="/account/team">Manage your team</a></p>`
      : `<p>You're a member of <strong>${esc(team.name)}</strong>${/[.!]$/.test(team.name) ? "" : "."}${fromTeam ? "" : " No devices have been assigned to you yet."}</p><p><a href="/account/team">Go to your team page</a></p>`
    : `<p>You're not on a team. A team lets one account buy Business Licence devices and share them with the people who work with it.</p><p><a href="/account/team">Create a team</a></p>`;
  const licences = lic.results || [];
  const licRows = licences.length
    ? `<table><caption class="visually-hidden">Your licences</caption><thead><tr><th scope="col">Product</th><th scope="col">Devices</th><th scope="col">Status</th><th scope="col">Order</th><th scope="col">Bought</th></tr></thead><tbody>${licences
        .map((l) => `<tr><td>${esc(l.product_name || l.licence_type)}</td><td>${esc(l.devices)}${l.assigned_devices ? ` (${esc(l.assigned_devices)} assigned to team members)` : ""}</td><td>${esc(statusText[l.status] || l.status)}</td><td><code>${esc(l.order_id)}</code></td><td>${fmtDate(l.purchased_at)}</td></tr>`)
        .join("")}</tbody></table>`
    : assignedRows.length ? "" : `<p>No licence linked yet. Personal use is free. If you use LlmentZero for work, see <a href="/licence">when you need a licence</a>.</p><p>Bought one already? Licences link automatically when you buy with this account's email address. If you used a different email, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a> with your Payhip order ID and we'll link it.</p>`;
  const dlRows = (dls.results || []).length
    ? `<ul>${dls.results.map((d) => `<li>${esc(d.title || d.slug)} (version ${esc(d.version)}), ${fmtDate(d.downloaded_at)}</li>`).join("")}</ul>`
    : `<p>No downloads yet. <a href="/skills">Browse the skills</a>.</p>`;
  return html(
    layout({
      title: "Your account",
      user,
      body: `${pwNotice ? `<p class="notice-ok" role="status">${esc(pwNotice)}</p>` : ""}<p class="eyebrow">Account</p><h1>Your account</h1>
<dl class="facts"><div><dt>Email</dt><dd>${esc(user.email)}</dd></div><div><dt>Member since</dt><dd>${fmtDate(user.createdAt)}</dd></div><div><dt>Email updates</dt><dd>${user.marketingConsent ? "Yes" : "No"}</dd></div>${acc ? `<div><dt>Terms agreed</dt><dd>${esc(acc.terms_version)} and ${esc(acc.licence_version)}, on ${fmtDate(acc.accepted_at)}</dd></div>` : ""}</dl>
<h2 class="h3" id="password">Password</h2><p>You can sign in with your password or an email code.${user.passwordChangedAt ? ` Password last changed on ${fmtDate(user.passwordChangedAt)}.` : ""}</p><p><a href="/account/password">Change password</a></p>
<h2 class="h3" id="licences">Licences</h2>${assignedText}${licRows}
<h2 class="h3" id="team">Team</h2>${teamText}
<h2 class="h3" id="downloads">Recent downloads</h2>${dlRows}
<h2 class="h3">Your data</h2><p>To get a copy of your data, change your email, stop email updates or close your account, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a>. See the <a href="/privacy">Privacy Policy</a>.</p>
<form method="post" action="/signout"><button type="submit" class="btn ghost">Sign out</button></form>`,
    }),
    { cookies }
  );
}

export async function getMe(request, env) {
  const { user, cookies } = await getSession(env, request);
  const body = user ? { signedIn: true, initial: user.email.slice(0, 1).toUpperCase(), email: user.email } : { signedIn: false };
  const h = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noai, noimageai", "X-Content-Type-Options": "nosniff" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { headers: h });
}

export async function postSignout(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const c = await destroySession(env, request);
  return redirect("/", { cookies: [c] });
}

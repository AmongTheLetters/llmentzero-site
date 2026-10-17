// Passwordless sign-up / sign-in with emailed 6-digit codes, clickwrap acceptance and account pages.
import { html, redirect, readForm, sameOrigin } from "./lib/http.js";
import { CHECKBOX_LABEL, emailField, errorSummary, fieldError, layout, termsCheckbox, turnstileWidget } from "./lib/views.js";
import { EmailError, codeEmail, noAccountEmail, sendEmail } from "./lib/email.js";
import { verifyTurnstile } from "./lib/turnstile.js";
import { LIMITS, hit } from "./lib/ratelimit.js";
import { PENDING_COOKIE, acceptedCurrentTerms, createSession, destroySession, getSession } from "./lib/session.js";
import { cookie, esc, ipHash, isValidEmail, normaliseEmail, now, parseCookies, randomId, safeNext, sha256Hex, sixDigitCode, userAgent } from "./lib/util.js";
import { LEGAL } from "./generated/legal.js";

const CODE_TTL = 600;

export async function audit(env, event, { userId = null, detail = null, ip = null } = {}) {
  await env.DB.prepare("INSERT INTO audit_log (id, at, event, user_id, detail, ip_hash) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(randomId("a_"), now(), event, userId, detail ? String(detail).slice(0, 500) : null, ip)
    .run();
}

const forbidden = () => html(layout({ title: "Something went wrong", body: `<h1>Please try again</h1><p>We couldn't confirm that form came from this website. Please go back, reload the page and try again.</p>` }), { status: 403 });

function nextParam(url) {
  return safeNext(url.searchParams.get("next") || "/account");
}

// ---------- Sign up ----------
function signupPage(env, { errors = {}, email = "", terms = false, marketing = false, next = "/account" } = {}) {
  return layout({
    title: errors && Object.keys(errors).length ? "Error: Create your account" : "Create your account",
    turnstile: true,
    body: `${errorSummary(errors)}<p class="eyebrow">Free account</p><h1>Create your account</h1>
<p class="lead">An account lets you download LlmentZero skill files. Personal use is free.</p>
<form method="post" action="/signup" novalidate class="stack">
<input type="hidden" name="next" value="${esc(next)}">
${emailField(errors, email)}
${termsCheckbox(errors, terms)}
<fieldset class="field"><legend>Email updates (optional)</legend><div class="check"><input id="marketing" name="marketing" type="checkbox" value="yes"${marketing ? " checked" : ""} aria-describedby="marketing-hint"><label for="marketing">Yes, email me about new skills and offers from LlmentZero.</label></div><p class="hint" id="marketing-hint">Optional. You can unsubscribe at any time. We never share your email.</p></fieldset>
${turnstileWidget(env, "signup", errors)}
<button type="submit" class="btn">Email me a code</button>
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
  if (!errors.email) {
    const ts = await verifyTurnstile(env, request, f.get("cf-turnstile-response"), "signup");
    if (!ts.ok) errors.turnstile = "The automatic person check didn't finish. Please wait for it to complete, then send the form again";
  }
  if (Object.keys(errors).length) return html(signupPage(env, { errors, email, terms, marketing, next }), { status: 400 });
  return startCode(request, env, { email, purpose: "signup", termsTickedAt: now(), marketing, next, rerender: (errs) => signupPage(env, { errors: errs, email, terms, marketing, next }) });
}

// ---------- Sign in ----------
function signinPage(env, { errors = {}, email = "", next = "/account" } = {}) {
  return layout({
    title: errors && Object.keys(errors).length ? "Error: Sign in" : "Sign in",
    turnstile: true,
    body: `${errorSummary(errors)}<p class="eyebrow">Welcome back</p><h1>Sign in</h1>
<form method="post" action="/signin" novalidate class="stack">
<input type="hidden" name="next" value="${esc(next)}">
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
  return html(signinPage(env, { next: nextParam(url) }));
}

export async function postSignin(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const f = await readForm(request);
  const email = normaliseEmail(f.get("email"));
  const next = safeNext(f.get("next"));
  const errors = {};
  if (!email) errors.email = "Enter your email address";
  else if (!isValidEmail(email)) errors.email = "Enter an email address in the right format, like name@example.com";
  if (!errors.email) {
    const ts = await verifyTurnstile(env, request, f.get("cf-turnstile-response"), "signin");
    if (!ts.ok) errors.turnstile = "The automatic person check didn't finish. Please wait for it to complete, then send the form again";
  }
  if (Object.keys(errors).length) return html(signinPage(env, { errors, email, next }), { status: 400 });
  return startCode(request, env, { email, purpose: "signin", next, rerender: (errs) => signinPage(env, { errors: errs, email, next }) });
}

function limitPage(message) {
  return html(layout({ title: "Please wait a little", body: `<h1>Please wait a little</h1><p>${message}</p><p>If you're stuck, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a> and we'll help.</p>` }), { status: 429, headers: { "Retry-After": "3600" } });
}

async function startCode(request, env, { email, purpose, termsTickedAt = null, marketing = false, next, rerender }) {
  const ip = await ipHash(env, request);
  if (!(await hit(env, `code:ip:${ip}`, LIMITS.codePerIpHour, 3600)) || !(await hit(env, `code:email:${await sha256Hex(email)}`, LIMITS.codePerEmailHour, 3600))) {
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
    `INSERT INTO login_codes (id, email, code_hash, purpose, created_at, expires_at, terms_ticked_at, marketing_opt_in, ip_hash, user_agent, next_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, email, await sha256Hex(`${id}:${code}`), purpose, t, t + CODE_TTL, termsTickedAt, marketing ? 1 : 0, ip, userAgent(request), next).run();
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
  const used = await env.DB.prepare("UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(t, row.id).run();
  if (!used.meta?.changes) return html(verifyPage({ errors: expiredMsg, expired: true }), { status: 400 });

  let user = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND closed_at IS NULL").bind(row.email).first();
  if (row.purpose === "signup") {
    if (!user) {
      const id = randomId("u_");
      await env.DB.prepare("INSERT INTO users (id, email, marketing_consent, marketing_consent_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, row.email, row.marketing_opt_in, row.marketing_opt_in ? row.terms_ticked_at : null, t).run();
      user = { id };
      await audit(env, "user.created", { userId: id, ip });
    } else if (row.marketing_opt_in) {
      await env.DB.prepare("UPDATE users SET marketing_consent = 1, marketing_consent_at = ? WHERE id = ?").bind(row.terms_ticked_at, user.id).run();
    }
    await recordAcceptance(env, { userId: user.id, email: row.email, method: "signup checkbox", acceptedAt: row.terms_ticked_at || t, ipHash: row.ip_hash, ua: row.user_agent });
  }
  if (!user) return html(verifyPage({ errors: { code: "We couldn't find that account. Please create an account" }, expired: true }), { status: 400 });

  await env.DB.prepare("UPDATE users SET last_sign_in_at = ? WHERE id = ?").bind(t, user.id).run();
  const sessionCookie = await createSession(env, request, user.id);
  await audit(env, "signin.success", { userId: user.id, ip });
  const next = safeNext(row.next_path);
  const dest = (await acceptedCurrentTerms(env, user.id)) ? next : `/account/accept?next=${encodeURIComponent(next)}`;
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
  if (await acceptedCurrentTerms(env, user.id)) return redirect(nextParam(url));
  return html(acceptPage({ next: nextParam(url), user }), { cookies });
}

export async function postAccept(request, env) {
  if (!sameOrigin(request)) return forbidden();
  const { user } = await getSession(env, request);
  if (!user) return redirect("/signin");
  const f = await readForm(request);
  const next = safeNext(f.get("next"));
  if (f.get("terms") !== "yes") return html(acceptPage({ errors: { terms: "Tick the box to agree to the Terms of Service and Skill Licence" }, next, user }), { status: 400 });
  await recordAcceptance(env, { userId: user.id, email: user.email, method: "re-accept checkbox", acceptedAt: now(), ipHash: await ipHash(env, request), ua: userAgent(request) });
  return redirect(next);
}

// ---------- Account ----------
const fmtDate = (s) => new Date(s * 1000).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });

export async function getAccount(request, env) {
  const { user, cookies } = await getSession(env, request);
  if (!user) return redirect("/signin?next=/account");
  if (!(await acceptedCurrentTerms(env, user.id))) return redirect("/account/accept?next=/account");
  const [lic, acc, dls] = await Promise.all([
    env.DB.prepare("SELECT product_name, licence_type, devices, status, order_id, purchased_at FROM licences WHERE email = ? ORDER BY purchased_at DESC").bind(user.email).all(),
    env.DB.prepare("SELECT terms_version, licence_version, accepted_at FROM terms_acceptances WHERE user_id = ? ORDER BY accepted_at DESC LIMIT 1").bind(user.id).first(),
    env.DB.prepare("SELECT d.slug, d.version, d.downloaded_at, s.title FROM downloads d LEFT JOIN skills s ON s.slug = d.slug WHERE d.user_id = ? ORDER BY d.downloaded_at DESC LIMIT 10").bind(user.id).all(),
  ]);
  const statusText = { active: "Active", refunded: "Refunded (licence ended)", revoked: "Revoked" };
  const licences = lic.results || [];
  const licRows = licences.length
    ? `<table><caption class="visually-hidden">Your licences</caption><thead><tr><th scope="col">Product</th><th scope="col">Devices</th><th scope="col">Status</th><th scope="col">Order</th><th scope="col">Bought</th></tr></thead><tbody>${licences
        .map((l) => `<tr><td>${esc(l.product_name || l.licence_type)}</td><td>${esc(l.devices)}</td><td>${esc(statusText[l.status] || l.status)}</td><td><code>${esc(l.order_id)}</code></td><td>${fmtDate(l.purchased_at)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p>No licence linked yet. Personal use is free. If you use LlmentZero for work, see <a href="/licence">when you need a licence</a>.</p><p>Bought one already? Licences link automatically when you buy with this account's email address. If you used a different email, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a> with your Payhip order ID and we'll link it.</p>`;
  const dlRows = (dls.results || []).length
    ? `<ul>${dls.results.map((d) => `<li>${esc(d.title || d.slug)} (version ${esc(d.version)}), ${fmtDate(d.downloaded_at)}</li>`).join("")}</ul>`
    : `<p>No downloads yet. <a href="/skills">Browse the skills</a>.</p>`;
  return html(
    layout({
      title: "Your account",
      user,
      body: `<p class="eyebrow">Account</p><h1>Your account</h1>
<dl class="facts"><div><dt>Email</dt><dd>${esc(user.email)}</dd></div><div><dt>Member since</dt><dd>${fmtDate(user.createdAt)}</dd></div><div><dt>Email updates</dt><dd>${user.marketingConsent ? "Yes" : "No"}</dd></div>${acc ? `<div><dt>Terms agreed</dt><dd>${esc(acc.terms_version)} and ${esc(acc.licence_version)}, on ${fmtDate(acc.accepted_at)}</dd></div>` : ""}</dl>
<h2 class="h3" id="licences">Licences</h2>${licRows}
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

// HTML templates for Worker-rendered pages. They reuse the static site's header, footer and
// stylesheet so they look and behave like the rest of llmentzero.com.
import { esc } from "./util.js";
import { LEGAL } from "../generated/legal.js";

const FONTS =
  "https://fonts.googleapis.com/css2?family=Michroma&family=Monoton&family=Saira+Stencil+One&family=Share+Tech+Mono&family=Tektur:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap";

const ACCT_ICON = `<svg class="acct-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c.8-3.9 3.9-6 7.5-6s6.7 2.1 7.5 6"/></svg>`;

export function buyUrl(env) {
  return env.PAYHIP_URL && /^https:\/\//.test(env.PAYHIP_URL) ? env.PAYHIP_URL : "/tiers";
}

/** Main navigation, the same for every visitor (static pages use the same list, see tools/build_pages.py). */
export const NAV = [["/", "Home"], ["/skills", "Skills"], ["/how-it-works", "How it works"], ["/tiers", "Tiers"], ["/about", "About"], ["/requests", "Requests"], ["/contact", "Contact"]];

function navLinks(current) {
  return NAV.map(([href, label]) => `<li><a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a></li>`).join("");
}

/** Breadcrumb trail: [[href, label], ..., [null, current page label]]. */
export function breadcrumb(trail) {
  return `<nav aria-label="Breadcrumb" class="crumbs"><ol>${trail
    .map(([href, label]) => (href ? `<li><a href="${esc(href)}">${esc(label)}</a></li>` : `<li><span aria-current="page">${esc(label)}</span></li>`))
    .join("")}</ol></nav>`;
}

export function layout({ title, body, description = "", noindex = true, user = null, turnstile = false, reminder = false, passwords = false, canonical = "", headExtra = "", current = "", wide = false }) {
  // Same account button as the static pages; the server tells the script whether we're signed in.
  const signedIn = user && typeof user === "object" && user.email;
  const acct = `<div class="acct" data-state="${signedIn ? "in" : user ? "unknown" : "out"}"${signedIn ? ` data-initial="${esc(user.email.slice(0, 1).toUpperCase())}" data-email="${esc(user.email)}"` : ""}><a class="acct-btn" href="/account">${ACCT_ICON}<span class="visually-hidden">Account</span></a></div>`;
  return `<!doctype html><html lang="en-CA" class="no-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · LlmentZero</title>${description ? `<meta name="description" content="${esc(description)}">` : ""}${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta name="robots" content="${noindex ? "noindex, nofollow, noai, noimageai" : "noai, noimageai"}"><meta name="tdm-reservation" content="1"><meta name="tdm-policy" content="https://llmentzero.com/licence">
<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/assets/icons/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#0B0F1A">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${FONTS}" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css"><link rel="stylesheet" href="/assets/accounts.css"><script src="/assets/nav.js" defer></script><script src="/assets/account-menu.js" defer></script>${reminder ? `<script src="/assets/lz-reminder.js" defer></script>` : ""}${passwords ? `<script src="/assets/password-toggle.js" defer></script>` : ""}${turnstile ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}${headExtra}</head><body><a class="skip" href="#main">Skip to content</a>
<header><div class="wrap"><a class="brand" href="/"><img src="/assets/logo/llmentzero-horizontal-dark.svg" alt="LlmentZero home" width="173" height="48"></a>
<nav aria-label="Main" class="nav"><button type="button" class="nav-toggle" aria-expanded="false" aria-controls="nav-menu"><span class="bars" aria-hidden="true"></span><span class="nav-label">Menu</span></button><ul id="nav-menu">${navLinks(current)}</ul></nav>${acct}</div></header><main id="main"><section><div class="wrap${wide ? "" : " narrow"}">${body}</div></section></main>
<footer><div class="wrap"><p>© 2026 LlmentZero · <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a> · Ontario, Canada</p><p>Free for personal use. Business and commercial use needs a paid licence.</p><nav aria-label="Legal"><ul class="legal-links"><li><a href="/privacy">Privacy</a></li><li><a href="/terms">Terms</a></li><li><a href="/licence">Licence</a></li><li><a href="/accessibility">Accessibility</a></li></ul></nav></div></footer></body></html>`;
}

/** Error summary at the top of a form (GOV.UK pattern): links jump to each field. */
export function errorSummary(errors) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return "";
  return `<div class="error-summary" role="alert" aria-labelledby="error-summary-title" tabindex="-1" autofocus><h2 id="error-summary-title" class="h3">There is a problem</h2><ul>${entries
    .map(([field, msg]) => `<li><a href="#${esc(field)}">${esc(msg)}</a></li>`)
    .join("")}</ul></div>`;
}

export function fieldError(errors, field) {
  return errors && errors[field] ? `<p class="field-error" id="${esc(field)}-error"><span class="visually-hidden">Error: </span>${esc(errors[field])}</p>` : "";
}

function describedBy(errors, field, hintId) {
  const ids = [hintId, errors && errors[field] ? `${field}-error` : ""].filter(Boolean).join(" ");
  return ids ? ` aria-describedby="${ids}"` : "";
}

export function emailField(errors, value, { hint = "We'll email you a 6-digit code to sign in.", autocomplete = "email" } = {}) {
  return `<div class="field${errors?.email ? " has-error" : ""}"><label for="email">Email address</label><p class="hint" id="email-hint">${esc(hint)}</p>${fieldError(errors, "email")}<input id="email" name="email" type="email" autocomplete="${autocomplete}" spellcheck="false" value="${esc(value)}"${describedBy(errors, "email", "email-hint")}${errors?.email ? ' aria-invalid="true"' : ""}></div>`;
}

export function turnstileWidget(env, action, errors) {
  return `<div class="field${errors?.turnstile ? " has-error" : ""}" id="turnstile"><p class="hint">A quick automatic check that you're a person. It usually needs no action.</p>${fieldError(errors, "turnstile")}<div class="cf-turnstile" data-sitekey="${esc(env.TURNSTILE_SITE_KEY)}" data-action="${esc(action)}" data-theme="dark" data-size="flexible" data-language="en"></div><noscript><p class="notice-inline">This check needs JavaScript. If you can't turn it on, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a> and we'll set up your account by hand.</p></noscript></div>`;
}

export const CHECKBOX_LABEL = "I have read and agree to the Terms of Service and the Skill Licence, and I have read the Privacy Policy.";

export function termsCheckbox(errors, checked = false) {
  return `<fieldset class="field${errors?.terms ? " has-error" : ""}"><legend>Terms</legend>${fieldError(errors, "terms")}<div class="check"><input id="terms" name="terms" type="checkbox" value="yes"${checked ? " checked" : ""}${describedBy(errors, "terms", "terms-hint")}${errors?.terms ? ' aria-invalid="true"' : ""}><label for="terms">I have read and agree to the <a href="${LEGAL.terms.path}" target="_blank" rel="noopener">Terms of Service<span class="visually-hidden"> (opens in a new tab)</span></a> and the <a href="${LEGAL.licence.path}" target="_blank" rel="noopener">Skill Licence<span class="visually-hidden"> (opens in a new tab)</span></a>, and I have read the <a href="${LEGAL.privacy.path}" target="_blank" rel="noopener">Privacy Policy<span class="visually-hidden"> (opens in a new tab)</span></a>.</label></div><p class="hint" id="terms-hint">Required to create an account. Versions: ${esc(LEGAL.terms.version)}, ${esc(LEGAL.licence.version)}, ${esc(LEGAL.privacy.version)}.</p></fieldset>`;
}

/** §4.1 "When you need a licence" notice: visible to everyone, signed in or not. */
export function licenceNotice(env, headingId = "need-licence") {
  return `<aside class="licence-notice" aria-labelledby="${headingId}"><h2 id="${headingId}" class="h3">When you need a licence</h2><p>Personal use is free. You need a Business Licence, one per Device, if you use this skill:</p><ul><li>for any business or commercial purpose, including as an employee, freelancer, non-profit or government body;</li><li>for client or customer work, paid or not;</li><li>in an internal AI system, model, agent or index used by your organisation; or</li><li>in a customer-facing chatbot, agent, app or service (this also needs a Deployment Licence).</li></ul><p><a href="/licence">Read the Skill Licence</a> · <a href="${esc(buyUrl(env))}">Buy a licence${env.PAYHIP_URL ? " on Payhip" : ""}</a></p></aside>`;
}

/** §4.2 reminder mount point. Filled, rotated and scheduled by /assets/lz-reminder.js. */
export function reminderMount(env) {
  return `<div id="lz-reminder" class="lz-reminder" role="status" aria-live="polite" data-buy="${esc(buyUrl(env))}" data-payhip="${env.PAYHIP_URL ? "1" : "0"}"></div>`;
}

const EYE = `<svg class="pw-eye" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="22" height="22"><path class="pw-eye-open" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle class="pw-eye-open" cx="12" cy="12" r="3"/><path class="pw-eye-slash" d="M3 3l18 18"/></svg>`;

/**
 * Password input with an eye-icon show/hide toggle (/assets/password-toggle.js).
 * Paste and password managers are always allowed (WCAG 2.2 SC 3.3.8). No maxlength, so long pasted
 * passphrases are never cut silently; length is checked on the server with a clear message.
 */
export function passwordField(errors, { id, label, autocomplete, hint = "" }) {
  const err = errors?.[id];
  const hintId = hint ? `${id}-hint` : "";
  const ids = [hintId, err ? `${id}-error` : ""].filter(Boolean).join(" ");
  return `<div class="field${err ? " has-error" : ""}"><label for="${id}">${esc(label)}</label>${hint ? `<p class="hint" id="${hintId}">${hint}</p>` : ""}${fieldError(errors, id)}<div class="pw-wrap"><input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="none"${ids ? ` aria-describedby="${ids}"` : ""}${err ? ' aria-invalid="true"' : ""}><button type="button" class="pw-toggle" aria-controls="${id}" aria-pressed="false" hidden>${EYE}<span class="pw-toggle-label visually-hidden">Show password</span></button></div></div>`;
}

export const NEW_PASSWORD_HINT = "At least 8 characters. Long passphrases are welcome (up to 128 characters), and you can paste or use a password manager. No special symbols needed.";

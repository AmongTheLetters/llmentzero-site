// Sends email through the Resend REST API (free plan: 3,000/month, 100/day).
// One idempotency key per attempt to sign in, reused across retries so a retried request can't
// send twice. Retries only on 429 and 5xx, with exponential backoff and jitter.
import { esc, sleep } from "./util.js";

const RESEND_URL = "https://api.resend.com/emails";

export class EmailError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export async function sendEmail(env, { to, subject, text, html, idempotencyKey }, { attempts = 3, baseDelayMs = 400 } = {}) {
  if (env.EMAIL_MODE === "log") {
    // Local development only (set in .dev.vars). Refused on the real domain in src/index.js.
    console.log(`[EMAIL_MODE=log] to=${to} subject=${subject}\n${text}`);
    return { id: "logged" };
  }
  if (!env.RESEND_API_KEY) throw new EmailError("RESEND_API_KEY is not set", { retryable: false });
  let last;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "User-Agent": "llmentzero-site/1.0",
        },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, html, reply_to: env.EMAIL_REPLY_TO || undefined }),
      });
    } catch (err) {
      last = new EmailError(`Network error: ${err.message}`, { retryable: true });
      if (i < attempts - 1) await sleep(backoff(i, baseDelayMs));
      continue;
    }
    if (res.ok) return await res.json().catch(() => ({}));
    const retryable = res.status === 429 || res.status >= 500;
    const detail = await res.text().catch(() => "");
    last = new EmailError(`Resend ${res.status}: ${detail.slice(0, 300)}`, { status: res.status, retryable });
    if (!retryable || i === attempts - 1) break;
    const ra = Number(res.headers.get("Retry-After"));
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : backoff(i, baseDelayMs));
  }
  throw last;
}

function backoff(i, base) {
  return base * 2 ** i + Math.floor(Math.random() * base);
}

function wrapHtml(inner) {
  return `<!doctype html><html lang="en-CA"><body style="margin:0;padding:24px;background:#ffffff;color:#0B0F1A;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6"><div style="max-width:560px;margin:0 auto">${inner}<p style="color:#4a5468;font-size:14px;margin-top:32px">LlmentZero · Ontario, Canada · <a href="mailto:llmentzero@gmail.com" style="color:#0b6e66">llmentzero@gmail.com</a></p></div></body></html>`;
}

export function codeEmail({ code, purpose }) {
  const action = purpose === "signup" ? "finish creating your LlmentZero account" : "sign in to LlmentZero";
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  return {
    subject: "Your LlmentZero sign-in code",
    text: `Hi there,\n\nUse this code to ${action}:\n\n${code}\n\nIt works once, for 10 minutes. If you didn't ask for it, you can ignore this email; nobody can sign in without the code.\n\nLlmentZero · Ontario, Canada · llmentzero@gmail.com\n`,
    html: wrapHtml(`<p>Hi there,</p><p>Use this code to ${esc(action)}:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px;font-family:'Courier New',monospace;margin:16px 0">${esc(spaced)}</p><p>It works once, for 10 minutes. If you didn't ask for it, you can ignore this email; nobody can sign in without the code.</p>`),
  };
}

export function passwordChangedEmail({ origin }) {
  const what = "changed";
  return {
    subject: `Your LlmentZero password was ${what}`,
    text: `Hi there,\n\nThe password for your LlmentZero account was just ${what}, and every browser that was signed in has been signed out.\n\nIf this was you, there's nothing else to do.\n\nIf it wasn't you, reset your password now at ${origin}/forgot-password and email llmentzero@gmail.com so we can help.\n\nLlmentZero · Ontario, Canada · llmentzero@gmail.com\n`,
    html: wrapHtml(`<p>Hi there,</p><p>The password for your LlmentZero account was just ${what}, and every browser that was signed in has been signed out.</p><p>If this was you, there's nothing else to do.</p><p>If it wasn't you, <a href="${esc(origin)}/forgot-password" style="color:#0b6e66">reset your password now</a> and email <a href="mailto:llmentzero@gmail.com" style="color:#0b6e66">llmentzero@gmail.com</a> so we can help.</p>`),
  };
}

export function noAccountEmail({ origin }) {
  return {
    subject: "Signing in to LlmentZero",
    text: `Hi there,\n\nSomeone (hopefully you) tried to sign in to LlmentZero with this email address, but there's no account for it yet.\n\nCreate a free account here: ${origin}/signup\n\nIf this wasn't you, you can ignore this email.\n\nLlmentZero · Ontario, Canada · llmentzero@gmail.com\n`,
    html: wrapHtml(`<p>Hi there,</p><p>Someone (hopefully you) tried to sign in to LlmentZero with this email address, but there's no account for it yet.</p><p><a href="${esc(origin)}/signup" style="color:#0b6e66">Create a free account</a></p><p>If this wasn't you, you can ignore this email.</p>`),
  };
}

/**
 * Team invite. The team name is limited to letters, numbers, spaces and simple punctuation
 * (src/teams.js), so it can't carry a link. It is still escaped in the HTML version.
 */
export function teamInviteEmail({ teamName, inviterEmail, inviteeEmail, link, expiresOn }) {
  return {
    subject: "You're invited to join a team on LlmentZero",
    text: `Hi there,\n\n${inviterEmail} has invited you to join the team "${teamName}" on LlmentZero. The team owner can give your account Business Licence devices.\n\nTo see the invite and accept it, open this link, then sign in or create a free account with this email address (${inviteeEmail}):\n\n${link}\n\nThe link works once and expires on ${expiresOn}. Nothing happens unless you accept. If you weren't expecting this, you can ignore this email.\n\nLlmentZero · Ontario, Canada · llmentzero@gmail.com\n`,
    html: wrapHtml(`<p>Hi there,</p><p>${esc(inviterEmail)} has invited you to join the team <strong>${esc(teamName)}</strong> on LlmentZero. The team owner can give your account Business Licence devices.</p><p>To see the invite and accept it, open the link below, then sign in or create a free account with this email address (${esc(inviteeEmail)}).</p><p><a href="${esc(link)}" style="color:#0b6e66;font-weight:bold">See the team invite</a></p><p>The link works once and expires on ${esc(expiresOn)}. Nothing happens unless you accept. If you weren't expecting this, you can ignore this email.</p>`),
  };
}

/** A refund ended licences. role "buyer" (bought the order) or "member" (devices assigned from it). */
export function refundEndedEmail({ role, orderId, product, devices, assignedToOthers = 0, teamName = "", origin = "https://llmentzero.com" }) {
  const d = (n) => `${n} device${Number(n) === 1 ? "" : "s"}`;
  const lines = role === "buyer"
    ? [
        `Payhip order ${orderId} was refunded, so the licence bought in that order has ended. This covers ${d(devices)} of ${product || "the LlmentZero Business Licence"}.`,
        assignedToOthers > 0 ? `This includes ${d(assignedToOthers)} you had assigned to team members. We've let each of them know.` : "",
        "From now on, any business or commercial use of LlmentZero skills on those devices must stop, as set out in section 10.6 of the Skill Licence. Personal use is still free.",
      ]
    : [
        `${d(devices)} assigned to your account through the team "${teamName}" ${Number(devices) === 1 ? "has" : "have"} ended. ${Number(devices) === 1 ? "It" : "They"} came from an order placed by the team owner, and that order was refunded.`,
        "From now on, any business or commercial use of LlmentZero skills on those devices must stop, as set out in section 10.6 of the Skill Licence. Personal use is still free. Any other devices on your account are not affected.",
      ];
  const body = lines.filter(Boolean);
  return {
    subject: "Your LlmentZero licence has ended",
    text: `Hi there,\n\n${body.join("\n\n")}\n\nYou can see your licences at ${origin}/account. The Skill Licence is at ${origin}/licence.\n\nIf you have any questions, email llmentzero@gmail.com.\n\nLlmentZero · Ontario, Canada · llmentzero@gmail.com\n`,
    html: wrapHtml(`<p>Hi there,</p>${body.map((l) => `<p>${esc(l)}</p>`).join("")}<p>You can see your licences on <a href="${esc(origin)}/account" style="color:#0b6e66">your account page</a>. Read the <a href="${esc(origin)}/licence" style="color:#0b6e66">Skill Licence</a>.</p><p>If you have any questions, email <a href="mailto:llmentzero@gmail.com" style="color:#0b6e66">llmentzero@gmail.com</a>.</p>`),
  };
}

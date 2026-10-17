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

export function noAccountEmail({ origin }) {
  return {
    subject: "Signing in to LlmentZero",
    text: `Hi there,\n\nSomeone (hopefully you) tried to sign in to LlmentZero with this email address, but there's no account for it yet.\n\nCreate a free account here: ${origin}/signup\n\nIf this wasn't you, you can ignore this email.\n\nLlmentZero · Ontario, Canada · llmentzero@gmail.com\n`,
    html: wrapHtml(`<p>Hi there,</p><p>Someone (hopefully you) tried to sign in to LlmentZero with this email address, but there's no account for it yet.</p><p><a href="${esc(origin)}/signup" style="color:#0b6e66">Create a free account</a></p><p>If this wasn't you, you can ignore this email.</p>`),
  };
}

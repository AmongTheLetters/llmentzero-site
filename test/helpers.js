import { env, exports } from "cloudflare:workers";
import { vi } from "vitest";

export const ORIGIN = "https://llmentzero.com";

export function call(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.method === "POST" && !headers.has("Origin") && !init.noOrigin) headers.set("Origin", ORIGIN);
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", init.ip || "203.0.113.7");
  if (!headers.has("User-Agent")) headers.set("User-Agent", "vitest-browser/1.0");
  return exports.default.fetch(new Request(ORIGIN + path, { ...init, headers, redirect: "manual" }));
}

export function form(path, data, init = {}) {
  return call(path, { method: "POST", body: new URLSearchParams(data), headers: { "Content-Type": "application/x-www-form-urlencoded", ...(init.headers || {}) }, ...init });
}

export function cookiesFrom(res) {
  const out = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export const cookieHeader = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("; ");

/**
 * Mocks outbound fetch: Turnstile siteverify and Resend. Returns the list of Resend calls.
 * resendResponses: array of statuses to return in order (default always 200).
 */
export function mockOutbound({ turnstile = true, resendResponses = [] } = {}) {
  const resendCalls = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/siteverify")) {
      return Response.json(turnstile ? { success: true, hostname: "llmentzero.com", action: init?.body?.get?.("response")?.split(":")[1] } : { success: false, "error-codes": ["invalid-input-response"] });
    }
    if (url === "https://api.resend.com/emails") {
      const body = JSON.parse(init.body);
      resendCalls.push({ headers: new Headers(init.headers), body });
      const status = resendResponses.length ? resendResponses.shift() : 200;
      return status === 200 ? Response.json({ id: "email_" + resendCalls.length }) : new Response("{}", { status });
    }
    throw new Error("Unexpected outbound fetch: " + url);
  });
  return { resendCalls, spy };
}

export const codeFromEmail = (call) => /\b(\d{6})\b/.exec(call.body.text)[1];

/** Full sign-up: returns { session cookie header, email }. */
export async function signUp(email = `person${Math.random().toString(36).slice(2, 8)}@example.com`, extra = {}) {
  const { resendCalls, spy } = mockOutbound();
  const r1 = await form("/signup", { email, terms: "yes", "cf-turnstile-response": "tok:signup", next: "/account", ...extra });
  if (r1.status !== 303) throw new Error("signup failed " + r1.status + (await r1.text()));
  const pending = cookiesFrom(r1);
  const code = codeFromEmail(resendCalls.at(-1));
  const r2 = await form("/verify", { code }, { headers: { Cookie: cookieHeader(pending) } });
  spy.mockRestore();
  const c = cookiesFrom(r2);
  return { email, cookie: `__Host-lz_session=${c["__Host-lz_session"]}`, res: r2, setCookies: r2.headers.getSetCookie() };
}

export async function seedSkill(slug = "sample-skill", content = "# Sample skill\n\nBody text.\n") {
  const t = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO skills (slug, title, tier, version, summary, filename, sha256, canary_guid, canary_words, published, sort_order, updated_at) VALUES (?, 'Sample skill', 'Basic', '1.0.0', 'A sample.', ?, 'x', '11111111-2222-3333-4444-555555555555', 'tamberosk-AB12,vorquelin-7Q3F', 1, 0, ?)"
    ).bind(slug, `llmentzero-${slug}-v1.0.0.md`, t),
    env.DB.prepare("INSERT OR REPLACE INTO skill_chunks (slug, idx, content) VALUES (?, 0, ?)").bind(slug, content),
  ]);
}

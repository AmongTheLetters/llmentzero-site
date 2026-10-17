// Response helpers and security headers for Worker-rendered responses.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(h, { noindex = false } = {}) {
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  h.set("tdm-reservation", "1");
  h.set("tdm-policy", "https://llmentzero.com/licence");
  h.set("X-Robots-Tag", noindex ? "noindex, nofollow, noai, noimageai" : "noai, noimageai");
  return h;
}

export function html(body, { status = 200, noindex = true, headers = {}, cookies = [] } = {}) {
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", ...headers });
  h.set("Content-Security-Policy", CSP);
  securityHeaders(h, { noindex });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(body, { status, headers: h });
}

export function redirect(location, { status = 303, cookies = [] } = {}) {
  const h = new Headers({ Location: location, "Cache-Control": "no-store" });
  securityHeaders(h, { noindex: true });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status, headers: h });
}

export function text(body, status = 200, extra = {}) {
  const h = new Headers({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra });
  securityHeaders(h, { noindex: true });
  return new Response(body, { status, headers: h });
}

export async function readForm(request) {
  const ct = request.headers.get("Content-Type") || "";
  if (!ct.includes("application/x-www-form-urlencoded") && !ct.includes("multipart/form-data")) return new Map();
  const fd = await request.formData();
  const m = new Map();
  for (const [k, v] of fd.entries()) if (typeof v === "string") m.set(k, v.slice(0, 2000));
  return m;
}

/** CSRF defence for form POSTs, on top of SameSite=Lax: the request must come from our own origin. */
export function sameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  const ref = request.headers.get("Referer");
  if (ref) {
    try { return new URL(ref).origin === url.origin; } catch { return false; }
  }
  return false;
}

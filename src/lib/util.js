// Small shared helpers. No dependencies; everything uses Web Crypto.
const enc = new TextEncoder();

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", typeof text === "string" ? enc.encode(text) : text));
}

export async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
}

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(prefix = "") {
  return prefix + toHex(crypto.getRandomValues(new Uint8Array(12)));
}

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function sixDigitCode() {
  const max = 4294967296 - (4294967296 % 1000000);
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= max);
  return String(a[0] % 1000000).padStart(6, "0");
}

/** Constant-time comparison of two strings (hash both first so lengths match). */
export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && String(a).length === String(b).length;
}

export function parseCookies(request) {
  const out = {};
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, httpOnly = true } = {}) {
  // __Host- prefix: Secure, Path=/, no Domain attribute.
  let c = `${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=Lax`;
  if (httpOnly) c += "; HttpOnly";
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function normaliseEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(email);
}

/** Only allow same-site relative redirects. */
export function safeNext(next) {
  const n = String(next || "");
  if (!n.startsWith("/") || n.startsWith("//") || n.startsWith("/\\") || /[\r\n]/.test(n)) return "/account";
  return n;
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "0.0.0.0";
}

export async function ipHash(env, request) {
  if (!env.IP_HASH_KEY) throw new Error("IP_HASH_KEY secret is not set");
  return (await hmacHex(env.IP_HASH_KEY, clientIp(request))).slice(0, 32);
}

/** Keyed hash of an email address, for short-lived rate-limit counters (never the address itself). */
export async function emailKey(env, email) {
  if (!env.IP_HASH_KEY) throw new Error("IP_HASH_KEY secret is not set");
  return (await hmacHex(env.IP_HASH_KEY, `email:${email}`)).slice(0, 32);
}

export function userAgent(request) {
  return (request.headers.get("User-Agent") || "").slice(0, 400);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

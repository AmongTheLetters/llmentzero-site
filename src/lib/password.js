// Password hashing for Cloudflare Workers (Free plan).
//
// Algorithm: PBKDF2-HMAC-SHA-256 (Web Crypto), 16-byte random salt per password, 256-bit output.
// The password is first normalised (NFKC, NIST SP 800-63B 5.1.1.2) and HMAC'd with a secret
// "pepper" (Worker secret PASSWORD_PEPPER) that is never stored in the database, so a database-only
// leak can't be brute-forced offline without the pepper.
//
// Iterations: 30,000. Why: Workers Free allows 10 ms of CPU per request, and workerd refuses PBKDF2
// above 100,000 iterations. Measured on the box (BoringSSL/OpenSSL, same native code path):
// 30k ≈ 4 ms, 50k ≈ 7 ms, 100k ≈ 12.5 ms. 30k leaves room for two derivations in one request
// (verify current + hash new when changing a password) plus normal request work. OWASP's 600,000 is not
// possible on Workers; the pepper, per-account and per-IP lockouts, Turnstile and the common-password
// check make up for it. Upgrade path: raise ITERATIONS (e.g. to 100,000 on Workers Paid); stored
// hashes keep their own iteration count and are re-hashed automatically at the next successful sign-in.
//
// Stored format (versioned): pbkdf2-sha256$<iterations>$<pepper id>$<salt b64url>$<hash b64url>
import { COMMON_PASSWORDS } from "./common-passwords.js";

export const ITERATIONS = 30000;
export const PEPPER_ID = "p1";
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
const enc = new TextEncoder();

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function normalise(pw) {
  return String(pw ?? "").normalize("NFKC");
}

/** Returns an error message, or "" if acceptable. No composition rules (NIST SP 800-63B). */
export function checkNewPassword(pw, email = "") {
  const p = normalise(pw);
  const len = [...p].length;
  if (!len) return "Enter a password";
  if (len < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters. A few words together make a strong, memorable passphrase`;
  if (len > MAX_LENGTH) return `Use ${MAX_LENGTH} characters or fewer`;
  const lower = p.toLowerCase();
  const local = String(email).split("@")[0].toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(p) || /^(?:0123456789|1234567890|abcdefghij)/.test(lower)) {
    return "That password is too common and easy to guess. Try a longer phrase that's unique to you";
  }
  if (lower === String(email).toLowerCase() || (local.length >= 4 && lower === local) || lower.includes("llmentzero")) {
    return "Don't use your email address or the site's name as your password";
  }
  return "";
}

async function pepperKey(env) {
  if (!env.PASSWORD_PEPPER) throw new Error("PASSWORD_PEPPER secret is not set");
  return crypto.subtle.importKey("raw", enc.encode(env.PASSWORD_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function derive(env, pw, salt, iterations) {
  const peppered = await crypto.subtle.sign("HMAC", await pepperKey(env), enc.encode(normalise(pw)));
  const key = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

export async function hashPassword(env, pw, { iterations = ITERATIONS } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(env, pw, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${PEPPER_ID}$${b64u(salt)}$${b64u(bits)}`;
}

/** Returns { ok, needsRehash }. Unknown formats fail closed. */
export async function verifyPassword(env, pw, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2-sha256") return { ok: false, needsRehash: false };
  const iterations = parseInt(parts[1], 10);
  if (!(iterations >= 1000 && iterations <= 100000) || parts[2] !== PEPPER_ID) return { ok: false, needsRehash: false };
  const got = new Uint8Array(await derive(env, pw, unb64u(parts[3]), iterations));
  const want = unb64u(parts[4]);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  return { ok: diff === 0, needsRehash: diff === 0 && iterations < ITERATIONS };
}

/** Same cost as a real verification, used when there's no account, so timing doesn't reveal it. */
export async function dummyVerify(env, pw) {
  await derive(env, pw, new Uint8Array(16), ITERATIONS);
  return { ok: false, needsRehash: false };
}

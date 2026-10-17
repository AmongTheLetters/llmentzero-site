// Session cookie: __Host-lz_session, HttpOnly; Secure; SameSite=Lax; Path=/. 30 days, rolling.
// Only the SHA-256 of the random 256-bit value is stored in D1.
import { cookie, now, parseCookies, randomToken, sha256Hex, userAgent } from "./util.js";
import { LEGAL } from "../generated/legal.js";

export const SESSION_COOKIE = "__Host-lz_session";
export const PENDING_COOKIE = "__Host-lz_pending";
const TTL = 30 * 24 * 3600;
const RENEW_AFTER = 24 * 3600;

export async function createSession(env, request, userId) {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(await sha256Hex(token), userId, t, t, t + TTL, userAgent(request).slice(0, 200)).run();
  return cookie(SESSION_COOKIE, token, { maxAge: TTL });
}

/** Returns { user, cookies } where cookies may hold a renewed session cookie. */
export async function getSession(env, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || token.length > 100) return { user: null, cookies: [] };
  const idHash = await sha256Hex(token);
  const t = now();
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.last_seen_at, u.id, u.email, u.marketing_consent, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ? AND u.closed_at IS NULL`
  ).bind(idHash, t).first();
  if (!row) return { user: null, cookies: [cookie(SESSION_COOKIE, "", { maxAge: 0 })] };
  const cookies = [];
  if (t - row.last_seen_at > RENEW_AFTER) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?").bind(t, t + TTL, idHash).run();
    cookies.push(cookie(SESSION_COOKIE, token, { maxAge: TTL }));
  }
  return { user: { id: row.id, email: row.email, marketingConsent: !!row.marketing_consent, createdAt: row.created_at }, cookies, idHash };
}

export async function destroySession(env, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
  return cookie(SESSION_COOKIE, "", { maxAge: 0 });
}

export async function hasActiveBusinessLicence(env, email) {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM licences WHERE email = ? AND status IN ('active','partial_refund') AND licence_type IN ('business','deployment') LIMIT 1"
  ).bind(email).first();
  return !!row;
}

/** True when the user's latest acceptance matches the current Terms and Licence versions. */
export async function acceptedCurrentTerms(env, userId) {
  const row = await env.DB.prepare(
    "SELECT terms_version, licence_version FROM terms_acceptances WHERE user_id = ? ORDER BY accepted_at DESC, recorded_at DESC LIMIT 1"
  ).bind(userId).first();
  return !!row && row.terms_version === LEGAL.terms.version && row.licence_version === LEGAL.licence.version;
}

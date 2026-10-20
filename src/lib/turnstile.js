// Server-side Turnstile check. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
import { clientIp } from "./util.js";

export async function verifyTurnstile(env, request, token, expectedAction) {
  if (!token) return { ok: false, reason: "missing" };
  if (!env.TURNSTILE_SECRET) throw new Error("TURNSTILE_SECRET secret is not set");
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", String(token).slice(0, 2048));
  body.append("remoteip", clientIp(request));
  body.append("idempotency_key", crypto.randomUUID());
  let data;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    data = await res.json();
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!data.success) return { ok: false, reason: (data["error-codes"] || []).join(",") || "failed" };
  if (expectedAction && data.action && data.action !== expectedAction) return { ok: false, reason: "action-mismatch" };
  const hosts = String(env.TURNSTILE_EXPECTED_HOSTNAME || "").split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length && data.hostname && !hosts.includes(data.hostname)) {
    return { ok: false, reason: "hostname-mismatch" };
  }
  return { ok: true };
}

// Payhip webhook: https://help.payhip.com/article/115-webhooks
// Payhip signs every event with signature = SHA-256(hex) of the store's API key.
// "paid" creates licences (matched to accounts by email); "refunded" (full OR partial) ends them.
import { text } from "./lib/http.js";
import { refundEndedEmail, sendEmail } from "./lib/email.js";
import { normaliseEmail, now, randomId, safeEqual, sha256Hex } from "./lib/util.js";
import { audit } from "./auth.js";

function productMap(env) {
  try {
    const m = JSON.parse(env.PAYHIP_PRODUCTS || "{}");
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

async function readPayload(request) {
  const ct = request.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) return request.json();
  const fd = await request.formData();
  const o = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
  if (typeof o.items === "string") {
    try { o.items = JSON.parse(o.items); } catch { o.items = []; }
  }
  return o;
}

export async function postPayhip(request, env, ctx) {
  if (!env.PAYHIP_API_KEY) return text("Webhook not configured", 503);
  if (Number(request.headers.get("Content-Length") || 0) > 64 * 1024) return text("Too large", 413);
  let p;
  try {
    p = await readPayload(request);
  } catch {
    return text("Bad request", 400);
  }
  if (!p || typeof p.signature !== "string" || !(await safeEqual(p.signature.toLowerCase(), await sha256Hex(env.PAYHIP_API_KEY)))) {
    await audit(env, "payhip.bad_signature");
    return text("Invalid signature", 401);
  }
  const map = productMap(env);
  const mapped = Object.keys(map).length > 0;
  const email = normaliseEmail(p.email);
  const orderId = String(p.id || "").slice(0, 64);
  const items = Array.isArray(p.items) ? p.items : [];
  const t = now();

  if (p.type === "paid") {
    if (!email || !orderId) return text("Missing email or id", 400);
    let created = 0;
    for (const item of items) {
      const productId = String(item.product_id || item.product_key || "").slice(0, 64);
      if (!productId) continue;
      // The store is shared with Among the Letters, so match by Payhip product id, product key
      // (the code in payhip.com/b/<key>) or exact product name. Empty map = every product counts.
      const keys = [item.product_id, item.product_key, item.product_name].filter(Boolean).map(String);
      const type = mapped ? keys.map((k) => map[k]).find(Boolean) : "business";
      if (!type) continue; // not a licence product
      const devices = Math.max(1, Math.min(100000, parseInt(item.quantity, 10) || 1));
      const r = await env.DB.prepare(
        `INSERT INTO licences (id, email, order_id, product_id, product_name, licence_type, devices, licence_key, status, price_cents, currency, purchased_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
         ON CONFLICT(order_id, product_id) DO NOTHING`
      ).bind(randomId("l_"), email, orderId, productId, String(item.product_name || "").slice(0, 200), type, devices, item.license_key ? String(item.license_key).slice(0, 100) : null, Number.isFinite(+p.price) ? +p.price : null, p.currency ? String(p.currency).slice(0, 8) : null, Number(p.date) || t, t).run();
      created += r.meta?.changes || 0;
    }
    await audit(env, "payhip.paid", { detail: `order=${orderId} licences=${created}` });
    return text("ok");
  }

  if (p.type === "refunded") {
    // Any refund, full or partial, ends every licence on the order (Chris's decision, Oct 16 2026).
    if (!orderId) return text("Missing id", 400);
    const r = await env.DB.prepare("UPDATE licences SET status = 'refunded', updated_at = ? WHERE order_id = ?").bind(t, orderId).run();
    await audit(env, "payhip.refunded", { detail: `order=${orderId} amount_refunded=${Number(p.amount_refunded) || 0} of ${Number(p.price) || 0} rows=${r.meta?.changes || 0}` });
    // Everyone whose licence this order's refund ended. refund_notices makes retries safe: people
    // already emailed are skipped, and anyone whose email failed earlier gets another try.
    const ending = (await env.DB.prepare("SELECT id, email, product_name, devices, assigned_devices FROM licences WHERE order_id = ? AND status = 'refunded'").bind(orderId).all()).results || [];
    if (ending.length) {
      try {
        await notifyRefund(env, request, orderId, ending);
      } catch (err) {
        // Never let email trouble change the webhook response.
        await audit(env, "email.failed", { detail: `refund notices order=${orderId}: ${String(err && err.message ? err.message : err)}` }).catch(() => {});
      }
    }
    return text("ok");
  }

  // subscription.* and anything else: acknowledge so Payhip doesn't retry.
  await audit(env, "payhip.ignored", { detail: String(p.type).slice(0, 50) });
  return text("ok");
}

/**
 * Emails everyone whose licence a refund ended: the buyer, and every account that was assigned
 * devices from the order (even if it has since left the team). One email per person per order:
 * a row in refund_notices is claimed before sending, so webhook retries never send twice.
 */
async function notifyRefund(env, request, orderId, ending) {
  const ids = ending.map((l) => l.id);
  const marks = ids.map(() => "?").join(",");
  const { results: members = [] } = await env.DB.prepare(
    `SELECT u.email, t.name AS team_name, SUM(a.devices) AS devices
     FROM licence_assignments a JOIN users u ON u.id = a.user_id JOIN teams t ON t.id = a.team_id
     WHERE a.licence_id IN (${marks}) GROUP BY u.email, t.name`
  ).bind(...ids).all();
  const people = new Map();
  for (const l of ending) {
    const cur = people.get(l.email) || { role: "buyer", devices: 0, assignedToOthers: 0, product: l.product_name };
    cur.devices += Number(l.devices || 0);
    cur.assignedToOthers += Number(l.assigned_devices || 0);
    people.set(l.email, cur);
  }
  for (const m of members) {
    if (people.has(m.email)) {
      // The buyer assigned devices to themselves: one email, and those devices aren't "others".
      people.get(m.email).assignedToOthers -= Number(m.devices || 0);
      continue;
    }
    people.set(m.email, { role: "member", devices: Number(m.devices || 0), teamName: m.team_name });
  }
  const origin = new URL(request.url).origin;
  const t = now();
  for (const [email, info] of people) {
    const claim = await env.DB.prepare("INSERT INTO refund_notices (order_id, email, role, devices, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(order_id, email) DO NOTHING")
      .bind(orderId, email, info.role, info.devices, t).run();
    if (!claim.meta?.changes) continue; // already sent (or being sent) for this order
    const msg = refundEndedEmail({ role: info.role, orderId, product: info.product, devices: info.devices, assignedToOthers: Math.max(0, info.assignedToOthers || 0), teamName: info.teamName, origin });
    try {
      const key = `refund-${orderId}-${(await sha256Hex(email)).slice(0, 24)}`;
      await sendEmail(env, { to: email, ...msg, idempotencyKey: key });
      await env.DB.prepare("UPDATE refund_notices SET sent_at = ? WHERE order_id = ? AND email = ?").bind(now(), orderId, email).run();
      await audit(env, "refund.notice_sent", { detail: `order=${orderId} role=${info.role}` });
    } catch (err) {
      // Release the claim so a later webhook delivery can try again.
      await env.DB.prepare("DELETE FROM refund_notices WHERE order_id = ? AND email = ? AND sent_at IS NULL").bind(orderId, email).run();
      await audit(env, "email.failed", { detail: `refund notice order=${orderId} role=${info.role}: ${String(err && err.message ? err.message : err)}` });
    }
  }
}

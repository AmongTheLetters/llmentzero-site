// Payhip webhook: https://help.payhip.com/article/115-webhooks
// Payhip signs every event with signature = SHA-256(hex) of the store's API key.
// "paid" creates licences (matched to accounts by email); "refunded" (full OR partial) ends them.
import { text } from "./lib/http.js";
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

export async function postPayhip(request, env) {
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
    return text("ok");
  }

  // subscription.* and anything else: acknowledge so Payhip doesn't retry.
  await audit(env, "payhip.ignored", { detail: String(p.type).slice(0, 50) });
  return text("ok");
}

// Fixed-window counters in D1. Returns true when the request is within the limit.
import { now } from "./util.js";

export async function hit(env, key, limit, windowSec) {
  const t = now();
  const start = t - (t % windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < ?2 THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < ?2 THEN ?2 ELSE rate_limits.window_start END
     RETURNING count`
  ).bind(key, start).first();
  return (row?.count ?? 1) <= limit;
}

export const LIMITS = {
  codePerEmailHour: 5,
  codePerIpHour: 20,
  verifyPerIpHour: 60,
  downloadsPerUserDay: 60,
  codeAttempts: 5,
};

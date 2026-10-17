// LlmentZero Worker. Static pages are served straight from dist/ by Workers static assets
// (free, unlimited, never touch this code). Only the paths in wrangler.toml's
// assets.run_worker_first reach this fetch handler.
import { getAccept, getAccount, getForgot, getMe, getPassword, getRemovePassword, postPassword, postRemovePassword, postPasswordCode, postSigninPassword, getSignin, getSignup, getVerify, postAccept, postSignin, postSignout, postSignup, postVerify } from "./auth.js";
import { getCatalogue, getDownload, getSkill, notFound } from "./skills.js";
import { postPayhip } from "./payhip.js";
import { html, text } from "./lib/http.js";
import { layout } from "./lib/views.js";
import { now } from "./lib/util.js";

const routes = {
  "GET /signup": getSignup,
  "POST /signup": postSignup,
  "GET /signin": getSignin,
  "POST /signin": postSignin,
  "POST /signin/password": postSigninPassword,
  "GET /forgot-password": getForgot,
  "GET /account/password": getPassword,
  "POST /account/password": postPassword,
  "POST /account/password/code": postPasswordCode,
  "GET /account/password/remove": getRemovePassword,
  "POST /account/password/remove": postRemovePassword,
  "GET /verify": getVerify,
  "POST /verify": postVerify,
  "GET /account": getAccount,
  "GET /account/accept": getAccept,
  "POST /account/accept": postAccept,
  "POST /signout": postSignout,
  "GET /skills": getCatalogue,
  "GET /api/me": getMe,
  "POST /webhooks/payhip": postPayhip,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Safety: the log-only email mode must never run on the real site.
    if (env.EMAIL_MODE === "log" && /(^|\.)llmentzero\.com$/.test(url.hostname)) {
      return text("Misconfigured: EMAIL_MODE=log is for local development only", 500);
    }
    try {
      const method = request.method === "HEAD" ? "GET" : request.method;
      const handler = routes[`${method} ${path}`];
      if (handler) return await handler(request, env, ctx);
      let m;
      if (method === "GET" && (m = /^\/skills\/([^/]+)$/.exec(path))) return await getSkill(request, env, decodeURIComponent(m[1]));
      if (method === "GET" && (m = /^\/download\/([^/]+)$/.exec(path))) return await getDownload(request, env, decodeURIComponent(m[1]));
      if (Object.keys(routes).some((k) => k.endsWith(` ${path}`))) return text("Method not allowed", 405);
      // Anything else that reached the Worker falls back to static assets.
      const res = await env.ASSETS.fetch(request);
      return res.status === 404 ? notFound(env, request) : res;
    } catch (err) {
      console.error("Unhandled error", err && err.stack ? err.stack : err);
      return html(
        layout({ title: "Something went wrong", body: `<h1>Something went wrong</h1><p>Sorry, something broke on our side. Please try again in a few minutes. If it keeps happening, email <a href="mailto:llmentzero@gmail.com">llmentzero@gmail.com</a>.</p>` }),
        { status: 500 }
      );
    }
  },

  // Daily clean-up (Free plan allows 5 cron triggers). Retention matches the Privacy Policy.
  async scheduled(event, env, ctx) {
    const t = now();
    const day = 86400;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(t),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t),
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(t - 2 * day),
      env.DB.prepare("DELETE FROM downloads WHERE downloaded_at < ?").bind(t - 365 * day),
      env.DB.prepare("DELETE FROM audit_log WHERE at < ?").bind(t - 365 * day),
    ]);
  },
};

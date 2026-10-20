// Who is looking at a library or skill page, and the shared 404 page.
import { getSession } from "./session.js";
import { hasActiveBusinessLicence } from "./licences.js";
import { text } from "./http.js";

export async function viewer(env, request) {
  const { user, cookies } = await getSession(env, request);
  const licensed = user ? await hasActiveBusinessLicence(env, user) : false;
  return { user, cookies, licensed, showReminder: !!user && !licensed };
}

export async function notFound(env, request, plain = false) {
  if (plain) return text("Not found", 404);
  const res = await env.ASSETS.fetch(new Request(new URL("/404", request.url)));
  return new Response(res.body, { status: 404, headers: res.headers });
}

const nf = new Intl.NumberFormat("en-CA");
/** 2000 -> "2,000" */
export const num = (n) => nf.format(n);
export const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

/** JSON-LD block. "<" is escaped so the data can never close the script element. */
export const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;

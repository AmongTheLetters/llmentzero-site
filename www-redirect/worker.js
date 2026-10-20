// www.llmentzero.com -> https://llmentzero.com (301, keeps path and query). No assets, no bindings.
export default {
  fetch(request) {
    const url = new URL(request.url);
    const target = `https://llmentzero.com${url.pathname}${url.search}`;
    return new Response(null, {
      status: 301,
      headers: {
        Location: target,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};

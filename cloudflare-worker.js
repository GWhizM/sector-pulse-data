export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }
    const snapshot = await env.SECTOR_PULSE_DATA.get("snapshot-latest", "json");
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        hasSnapshot: Boolean(snapshot),
        schemaVersion: snapshot?.schemaVersion ?? null,
        generatedAt: snapshot?.generatedAt ?? null,
      });
    }
    if (!snapshot) {
      return json({ error: "No successful market snapshot has been published yet" }, 503);
    }
    if (url.pathname === "/api/market") return json(snapshot.momentum);
    if (url.pathname === "/api/contributions") return json(snapshot.contributions);
    return json({ error: "Not found" }, 404);
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=30",
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

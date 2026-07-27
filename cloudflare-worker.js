const RANGE_DAYS = { "1m": 31, "3m": 93, "6m": 186, "1y": 366, "3y": 1096, "5y": 1827 };
const GITHUB_API = "https://api.github.com/repos/GWhizM/sector-pulse-data/actions/workflows";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    try {
      if (url.pathname === "/api/health") {
        const [snapshot, history, scheduler] = await Promise.all([
          env.SECTOR_PULSE_DATA.get("snapshot-latest", "json"),
          env.SECTOR_PULSE_DATA.get("history:meta", "json"),
          env.SECTOR_PULSE_DATA.get("scheduler:last-dispatch", "json"),
        ]);
        return json({
          ok: true,
          hasSnapshot: Boolean(snapshot),
          hasHistory: Boolean(history),
          schemaVersion: snapshot?.schemaVersion ?? null,
          generatedAt: snapshot?.generatedAt ?? null,
          historyGeneratedAt: history?.generatedAt ?? null,
          scheduler: scheduler ?? null,
        });
      }

      if (url.pathname === "/api/sector-history") {
        const internalTicker = normalizeTicker(url.searchParams.get("ticker"));
        const series = await env.SECTOR_PULSE_DATA.get(`history:${internalTicker}`, "json");
        if (!series) return json({ error: "History is not available for that ticker" }, 404);
        return json(buildHistoryResponse(
          series,
          internalTicker,
          url.searchParams.get("range") || "1m",
          url.searchParams.get("start"),
        ));
      }

      if (url.pathname === "/api/period-impact") {
        const range = url.searchParams.get("range") || "1m";
        if (range === "custom") {
          const start = url.searchParams.get("start");
          if (!dateFrom(start)) throw new Error("Choose a valid custom starting date");
          const snapshots = await env.SECTOR_PULSE_DATA.get(`history:custom-periods:${start.slice(0, 4)}`, "json");
          if (!snapshots) throw new Error("The custom starting date is outside the available five-year history");
          const effectiveStart = Object.keys(snapshots).sort().find(value => value >= start);
          if (!effectiveStart) throw new Error("Custom starting date cannot be after the latest market date");
          return json(snapshots[effectiveStart]);
        }
        const periods = await env.SECTOR_PULSE_DATA.get("history:periods", "json");
        if (!periods) return json({ error: "No successful daily history has been published yet" }, 503);
        if (!periods[range]) throw new Error("Performance range must be 1m, 3m, 6m, 1y, 3y, 5y, ytd, or custom");
        return json(periods[range]);
      }

      const snapshot = await env.SECTOR_PULSE_DATA.get("snapshot-latest", "json");
      if (!snapshot) {
        return json({ error: "No successful market snapshot has been published yet" }, 503);
      }
      if (url.pathname === "/api/market") return json(snapshot.momentum);
      if (url.pathname === "/api/contributions") return json(snapshot.contributions);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledDispatch(controller.scheduledTime, env));
  },
};

async function runScheduledDispatch(scheduledTime, env) {
  const target = scheduledTarget(new Date(scheduledTime));
  if (!target) return;
  if (!env.GITHUB_ACTIONS_TOKEN) throw new Error("GITHUB_ACTIONS_TOKEN is not configured");

  const response = await fetch(`${GITHUB_API}/${target.workflow}/dispatches`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "sector-pulse-cloudflare-scheduler",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({ ref: "main" }),
  });

  const result = {
    ok: response.ok,
    workflow: target.workflow,
    scheduledFor: new Date(scheduledTime).toISOString(),
    dispatchedAt: new Date().toISOString(),
    githubStatus: response.status,
  };
  await env.SECTOR_PULSE_DATA.put("scheduler:last-dispatch", JSON.stringify(result));
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub workflow dispatch failed (${response.status}): ${detail.slice(0, 500)}`);
  }
}

function scheduledTarget(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  if (["Sat", "Sun"].includes(parts.weekday)) return null;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute >= 570 && minute <= 960) return { workflow: "update-market.yml" };
  if (minute === 975) return { workflow: "update-history.yml" };
  return null;
}

function normalizeTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  if (["BRK/B", "BRK.B", "BRK-B"].includes(ticker)) return "BRK-B";
  return ticker;
}

function dateFrom(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(date) {
  return date.toISOString().slice(0, 10);
}

function rangeCutoff(latestDate, range, customStart) {
  const latest = dateFrom(latestDate);
  if (!latest || ![...Object.keys(RANGE_DAYS), "ytd", "custom"].includes(range)) {
    throw new Error("History range must be 1m, 3m, 6m, 1y, 3y, 5y, ytd, or custom");
  }
  let cutoff;
  if (range === "custom") {
    cutoff = dateFrom(customStart);
    if (!cutoff) throw new Error("Choose a valid custom starting date");
  } else if (range === "ytd") {
    cutoff = new Date(Date.UTC(latest.getUTCFullYear(), 0, 1));
  } else {
    cutoff = new Date(latest.getTime() - RANGE_DAYS[range] * 86400000);
  }
  if (cutoff > latest) throw new Error("Custom starting date cannot be after the latest market date");
  return dateText(cutoff);
}

function buildHistoryResponse(series, internalTicker, range, customStart) {
  const rows = series.points || [];
  if (rows.length < 2) throw new Error("Not enough daily history is available");
  const cutoff = rangeCutoff(rows.at(-1).date, range, customStart);
  const selected = rows.filter(row => row.date >= cutoff);
  if (selected.length < 2) throw new Error("Not enough daily observations are available for this range");
  const baseline = Number(selected[0].adjustedClose);
  const points = selected.map(row => ({
    date: row.date,
    close: round(row.close, 2),
    changePct: row.changePct == null ? null : round(row.changePct, 2),
    cumulativePct: round((Number(row.adjustedClose) / baseline - 1) * 100, 2),
  }));
  return {
    ticker: series.displayTicker || internalTicker,
    name: series.name || series.displayTicker || internalTicker,
    range,
    requestedStartDate: range === "custom" ? customStart : null,
    points,
    latestDate: points.at(-1).date,
    latestClose: points.at(-1).close,
    latestChangePct: points.at(-1).changePct,
    periodReturnPct: points.at(-1).cumulativePct,
    generatedAt: series.generatedAt,
    source: series.source,
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

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

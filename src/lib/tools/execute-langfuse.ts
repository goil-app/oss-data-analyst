import { tool } from "ai";
import { z } from "zod";
import { MAX_ROWS } from "@/lib/mongodb";
import { redactPii } from "@/lib/query-guard";
import { PREVIEW_ROWS, queryResultToModelOutput, type QueryOutput, type Rows } from "./execute-mongodb";

// The Langfuse project we READ from (server-backend traces). Separate from LANGFUSE_* used to trace this bot.
const HOST = process.env.LANGFUSE_SOURCE_BASE_URL || "https://cloud.langfuse.com";
const PUBLIC_KEY = process.env.LANGFUSE_SOURCE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SOURCE_SECRET_KEY;

export const isLangfuseConfigured = () => Boolean(PUBLIC_KEY && SECRET_KEY);

// GET only: Langfuse keys can also ingest, so writes are prevented by never calling anything else
const ENDPOINTS = {
  metrics: "/api/public/v2/metrics",
  traces: "/api/public/traces",
  scores: "/api/public/v2/scores",
} as const;

/** Builds the GET query string. Trace input/output (user content) is never requested. */
export function buildUrl(endpoint: keyof typeof ENDPOINTS, params: Record<string, unknown>): string {
  const url = new URL(ENDPOINTS[endpoint], HOST);
  if (endpoint === "metrics") {
    url.searchParams.set("query", JSON.stringify(params));
    return url.toString();
  }
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  url.searchParams.set("limit", String(Math.min(Number(params.limit) || 50, 100)));
  if (endpoint === "traces") url.searchParams.set("fields", "core,scores,metrics");
  return url.toString();
}

/** Drops trace input/output even if the API returns them. */
const stripIo = (rows: Rows) => rows.map(({ input: _i, output: _o, ...r }) => r);

export function createExecuteLangfuseTool(onRows: (rows: Rows) => Promise<void>) {
  return tool({
    description: `Read LLM traces, costs, tokens, latencies and scores from Langfuse (the backend's AI observability).
Read semantic/langfuse.yml first: trace names, how ids map to MongoDB, and query examples.
- endpoint "metrics": params = Metrics API v2 query object {view, metrics, dimensions, filters, timeDimension, fromTimestamp, toTimestamp, orderBy, config}. For aggregates.
- endpoint "traces": params = {name, userId, sessionId, tags, fromTimestamp, toTimestamp, orderBy, page, limit}. Lists traces (no input/output) with totalCost and latency, max 100 per page: count or sum with "metrics", not by paging.
- endpoint "scores": params = {name, fromTimestamp, toTimestamp, traceId, dataType, page, limit}. User feedback scores.

Returns counts and the first ${PREVIEW_ROWS} rows. The full result is saved to /tmp/mongodb_result.json and /tmp/mongodb_result.csv (overwritten by the latest query).`,
    inputSchema: z.object({
      endpoint: z.enum(["metrics", "traces", "scores"]),
      params: z.object({}).catchall(z.unknown()).describe("Query object (metrics) or query parameters (traces, scores)"),
    }),
    execute: async ({ endpoint, params }): Promise<QueryOutput> => {
      const start = Date.now();
      try {
        const res = await fetch(buildUrl(endpoint, params), {
          headers: { Authorization: `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || JSON.stringify(body.error ?? body) || `Langfuse HTTP ${res.status}`);

        const data: Rows = body.data ?? [];
        const rows = redactPii(stripIo(data.slice(0, MAX_ROWS))) as Rows;
        console.log(`[ExecuteLangfuse] ${endpoint} ${rows.length} rows in ${Date.now() - start}ms`);
        await onRows(rows);
        return { rows, rowCount: rows.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ExecuteLangfuse] failed: ${message}`);
        await onRows([]);
        return { error: message, rows: [], rowCount: 0 };
      }
    },
    toModelOutput: ({ output }) => queryResultToModelOutput({ output }),
  });
}

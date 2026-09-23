import { tool } from "ai";
import { z } from "zod";
import { MAX_ROWS } from "@/lib/mongodb";
import { redactPii } from "@/lib/query-guard";
import { PREVIEW_ROWS, queryResultToModelOutput, type QueryOutput, type Rows } from "./execute-mongodb";

const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://eu.posthog.com";

export const isPostHogConfigured = () => Boolean(process.env.POSTHOG_API_KEY && process.env.POSTHOG_PROJECT_ID);

/**
 * HogQL (PostHog SQL, read-only by design) via the PostHog query API.
 * Use a personal API key scoped to `query:read` only.
 */
export function createExecutePostHogTool(onRows: (rows: Rows) => Promise<void>) {
  return tool({
    description: `Execute a HogQL (PostHog SQL) SELECT query against PostHog product analytics.
Use it for usage of the backoffice web app and its embedded help center (pageviews, clicks, help:* events).
Read semantic/posthog.yml first for events, properties and query tips.

Example: { "query": "SELECT event, count() FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY count() DESC LIMIT 20" }

Returns counts and the first ${PREVIEW_ROWS} rows. The full result (max ${MAX_ROWS} rows) is saved to /tmp/mongodb_result.json and /tmp/mongodb_result.csv (same files as ExecuteMongoDB, overwritten by the latest query).`,
    inputSchema: z.object({
      query: z.string().min(1).describe(`HogQL SELECT query. Always include a timestamp filter and LIMIT (max ${MAX_ROWS}).`),
    }),
    execute: async ({ query }): Promise<QueryOutput> => {
      const start = Date.now();
      try {
        const res = await fetch(`${POSTHOG_HOST}/api/projects/${process.env.POSTHOG_PROJECT_ID}/query/`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.POSTHOG_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail || `PostHog HTTP ${res.status}`);

        const names: string[] = body.columns ?? [];
        const results: unknown[][] = body.results ?? [];
        const rows = redactPii(
          results.slice(0, MAX_ROWS).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])))
        ) as Rows;
        console.log(`[ExecutePostHog] ${rows.length} rows in ${Date.now() - start}ms`);
        await onRows(rows);
        return { rows, rowCount: rows.length, truncated: results.length > MAX_ROWS || Boolean(body.hasMore) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ExecutePostHog] failed: ${message}`);
        await onRows([]);
        return { error: message, rows: [], rowCount: 0 };
      }
    },
    toModelOutput: ({ output }) => queryResultToModelOutput({ output }),
  });
}

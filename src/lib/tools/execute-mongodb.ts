import { tool } from "ai";
import { z } from "zod";
import { Decimal128, ObjectId } from "mongodb";
import { MAX_ROWS, runQuery } from "@/lib/mongodb";
import { redactPii } from "@/lib/query-guard";

/** Recursively converts BSON types to JSON-safe values. */
function serializeBson(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128) return parseFloat(value.toString());
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(serializeBson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeBson(v)]));
  }
  return value;
}

export type Rows = Record<string, unknown>[];
export type QueryOutput = { rows: Rows; rowCount: number; truncated?: boolean; error?: string };

export const PREVIEW_ROWS = 50;

/**
 * What the model sees: counts + the first PREVIEW_ROWS rows. The full rows stay in the
 * tool output and in the sandbox files, so large results don't flood the context.
 */
export function queryResultToModelOutput({ output }: { output: QueryOutput }) {
  if (output.error) return { type: "json" as const, value: { error: output.error } };
  const extra = output.rows.length - PREVIEW_ROWS;
  return {
    type: "json" as const,
    value: JSON.parse(JSON.stringify({
      rowCount: output.rowCount,
      previewRows: output.rows.slice(0, PREVIEW_ROWS),
      ...(extra > 0 && { note: `${extra} more rows not shown. Full result in /tmp/mongodb_result.json and .csv` }),
      ...(output.truncated && { warning: `Result capped at ${MAX_ROWS} rows: aggregate further or filter` }),
    })),
  };
}

/** `onRows` receives every result (already redacted, empty on errors) so the sandbox files never go stale. */
export function createExecuteMongoDBTool(onRows: (rows: Rows) => Promise<void>) {
  return tool({
    description: `Execute a READ-ONLY MongoDB query. Two modes:
1. find: { database, collection, filter, projection, sort, limit, skip }
2. aggregate: { database, collection, mode: "aggregate", pipeline }

Only databases and collections listed in semantic/databases.yml are available.
Personal data fields (phone, username, GPS coordinates, auth codes...) cannot be referenced and are redacted in results.
Server-side JavaScript, write stages and $objectToArray/$getField are rejected.

24-character hex strings (e.g. "62421db1183a7500142fcbce") are automatically converted to ObjectId.
For dates use Extended JSON: { "creationDate": { "$gte": { "$date": "2026-01-01T00:00:00Z" } } }.

Returns counts and the first ${PREVIEW_ROWS} rows. The full result (max ${MAX_ROWS} rows) is saved to /tmp/mongodb_result.json and /tmp/mongodb_result.csv for analysis with the bash tool.`,
    inputSchema: z.object({
      database: z.string().min(1),
      collection: z.string().min(1),
      mode: z.enum(["find", "aggregate"]).default("find"),
      filter: z.record(z.string(), z.any()).optional(),
      projection: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
      sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
      limit: z.number().int().positive().max(1000).optional(),
      skip: z.number().int().nonnegative().optional(),
      pipeline: z.array(z.record(z.string(), z.any())).optional(),
    }),
    execute: async (input): Promise<QueryOutput> => {
      const start = Date.now();
      try {
        const docs = await runQuery(input);
        const rows = redactPii(serializeBson(docs.slice(0, MAX_ROWS))) as Rows;
        console.log(`[ExecuteMongoDB] ${input.database}.${input.collection} ${input.mode}: ${rows.length} rows in ${Date.now() - start}ms`);
        await onRows(rows);
        return { rows, rowCount: rows.length, truncated: docs.length > MAX_ROWS };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ExecuteMongoDB] ${input.database}.${input.collection} failed: ${message}`);
        await onRows([]);
        return { error: message, rows: [], rowCount: 0 };
      }
    },
    toModelOutput: ({ output }) => queryResultToModelOutput({ output }),
  });
}

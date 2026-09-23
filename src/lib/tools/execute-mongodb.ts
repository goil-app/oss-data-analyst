import { tool } from "ai";
import { z } from "zod";
import { Decimal128, ObjectId } from "mongodb";
import { runQuery } from "@/lib/mongodb";
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

/** `onRows` receives every successful (already redacted) result, e.g. to write it into the sandbox. */
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

Results are saved to /tmp/mongodb_result.json and /tmp/mongodb_result.csv for analysis with the bash tool.`,
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
    execute: async (input) => {
      const start = Date.now();
      try {
        const rows = redactPii(serializeBson(await runQuery(input))) as Rows;
        console.log(`[ExecuteMongoDB] ${input.database}.${input.collection} ${input.mode}: ${rows.length} rows in ${Date.now() - start}ms`);
        if (rows.length > 0) await onRows(rows);
        return { rows, rowCount: rows.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ExecuteMongoDB] ${input.database}.${input.collection} failed: ${message}`);
        return { error: message, rows: [], rowCount: 0 };
      }
    },
  });
}

import { tool } from "ai";
import { z } from "zod";
import { validateDatabase, getDatabaseNames } from "@/lib/database-registry";
import { executeFindQuery, executeAggregation } from "@/lib/mongodb";
import { ObjectId, Decimal128 } from "mongodb";

// Security: Block dangerous aggregation stages that write data
const FORBIDDEN_PIPELINE_STAGES = [
  "$out",
  "$merge",
  "$currentOp",
  "$listLocalSessions",
  "$listSessions",
];

// Security: Block system collections
const SYSTEM_COLLECTION_PREFIXES = ["system.", "local.", "oplog."];

function validateReadonly(collection: string, pipeline?: Record<string, unknown>[]) {
  // Block system collections
  if (SYSTEM_COLLECTION_PREFIXES.some((prefix) => collection.startsWith(prefix))) {
    throw new Error(`Access to system collections is forbidden: ${collection}`);
  }

  // Block write operations in aggregation pipeline
  if (pipeline) {
    for (const stage of pipeline) {
      for (const stageName of Object.keys(stage)) {
        if (FORBIDDEN_PIPELINE_STAGES.includes(stageName)) {
          throw new Error(`Write operation "${stageName}" is not allowed. Only read operations permitted.`);
        }
      }
    }
  }
}

/**
 * Recursively convert BSON types to JSON-safe values.
 * Mirrors the Python MongoEncoder: ObjectId→string, Date→ISO, Decimal128→float, Buffer→hex.
 */
function serializeBsonValues(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128) return parseFloat(value.toString());
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(serializeBsonValues);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, serializeBsonValues(v)])
    );
  }
  return value;
}

/**
 * Creates MongoDB tools that execute queries on the host via the Node.js driver.
 * No container or credentials needed — queries run in the control plane.
 */
export function createMongoDBTools() {
  const ExecuteMongoDB = tool({
    description: `Execute MongoDB READ-ONLY queries. Supports two modes:
1. Find query: { database, collection, filter, projection, sort, limit, skip }
2. Aggregation: { database, collection, pipeline }

The "database" parameter is REQUIRED. Check semantic/databases.yml for available databases and their collections.

Examples:
- Find: { "database": "AnalyticsDB", "collection": "UserActivity", "filter": { "os": "iOS" }, "limit": 10 }
- Aggregation: { "database": "AnalyticsDB", "collection": "UserActivity", "pipeline": [{ "$group": { "_id": "$os", "count": { "$sum": 1 } } }] }

Note: 24-character hex strings (e.g. "62421db1183a7500142fcbce") in filters and pipelines are automatically converted to ObjectId — pass them as plain strings.

Results are automatically saved to the sandbox at /tmp/mongodb_result.json and /tmp/mongodb_result.csv for analysis with the bash tool.`,
    inputSchema: z.object({
      database: z.string().min(1).describe("Database name (REQUIRED). Check semantic/databases.yml for available databases."),
      collection: z.string().min(1),
      mode: z.enum(["find", "aggregate"] as const).default("find"),
      filter: z.record(z.string(), z.any()).optional(),
      projection: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
      sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
      limit: z.number().int().positive().max(1001).optional(),
      skip: z.number().int().nonnegative().optional(),
      pipeline: z.array(z.record(z.string(), z.any())).optional(),
    }),
    execute: async (input) => {
      console.log(`[ExecuteMongoDB] Database: ${input.database}, Mode: ${input.mode}, Collection: ${input.collection}`);

      try {
        // Validate database
        const configuredDbs = getDatabaseNames();
        if (configuredDbs.length > 0) {
          validateDatabase(input.database);
        }

        // Security: Validate read-only operations
        validateReadonly(input.collection, input.pipeline);

        let result;
        if (input.mode === "aggregate" && input.pipeline) {
          result = await executeAggregation({
            database: input.database,
            collection: input.collection,
            pipeline: input.pipeline,
          });
        } else {
          result = await executeFindQuery({
            database: input.database,
            collection: input.collection,
            filter: input.filter,
            projection: input.projection,
            sort: input.sort,
            limit: input.limit || 100,
            skip: input.skip,
          });
        }

        // Serialize BSON types to JSON-safe values
        const rows = serializeBsonValues(result.rows) as any[];

        const columns = result.columns.map((col) => ({
          name: col,
          type: "mixed",
        }));

        return {
          rows,
          columns,
          rowCount: result.rowCount,
          executionTime: result.executionTime,
        };
      } catch (error: any) {
        console.error(`[ExecuteMongoDB] Error:`, error.message);
        return {
          ok: false,
          error: error.message,
          rows: [],
          columns: [],
        };
      }
    },
  });

  return { tools: { ExecuteMongoDB } };
}

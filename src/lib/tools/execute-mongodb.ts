import { tool } from "ai";
import { z } from "zod";
import { validateDatabase, getDatabaseNames } from "@/lib/database-registry";
import type { SandboxInstance } from "./sandbox";
import { execInContainer } from "./sandbox";

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
 * Creates MongoDB tools bound to a specific Docker sandbox instance.
 * Queries are executed via Python/pymongo inside the container.
 */
export function createMongoDBTools({ container }: SandboxInstance) {
  const ExecuteMongoDB = tool({
    description: `Execute MongoDB READ-ONLY queries. Supports two modes:
1. Find query: { database, collection, filter, projection, sort, limit, skip }
2. Aggregation: { database, collection, pipeline }

The "database" parameter is REQUIRED. Check semantic/databases.yml for available databases and their collections.

Examples:
- Find: { "database": "AnalyticsDB", "collection": "UserActivity", "filter": { "os": "iOS" }, "limit": 10 }
- Aggregation: { "database": "AnalyticsDB", "collection": "UserActivity", "pipeline": [{ "$group": { "_id": "$os", "count": { "$sum": 1 } } }] }

Note: 24-character hex strings (e.g. "62421db1183a7500142fcbce") in filters and pipelines are automatically converted to ObjectId — pass them as plain strings.`,
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

        // Serialize params and pass via base64 to avoid shell quoting issues
        const params = {
          database: input.database,
          collection: input.collection,
          mode: input.mode,
          filter: input.filter,
          projection: input.projection,
          sort: input.sort,
          limit: input.limit || 100,
          skip: input.skip,
          pipeline: input.pipeline,
        };
        const encoded = Buffer.from(JSON.stringify(params)).toString("base64");
        const cmd = `echo '${encoded}' | base64 -d | python3 /app/scripts/execute_query.py`;

        const { stdout, stderr, exitCode } = await execInContainer(container, cmd);

        if (exitCode !== 0) {
          console.error(`[ExecuteMongoDB] Python script failed:`, stderr);
          return { ok: false, error: stderr || "Query execution failed", rows: [], columns: [] };
        }

        let result: { rows: any[]; columns: string[]; rowCount: number; executionTime: number };
        try {
          result = JSON.parse(stdout);
        } catch {
          console.error(`[ExecuteMongoDB] Failed to parse output:`, stdout);
          return { ok: false, error: `Failed to parse query output: ${stdout}`, rows: [], columns: [] };
        }

        const columns = result.columns.map((col) => ({
          name: col,
          type: "mixed",
        }));

        return {
          rows: result.rows,
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

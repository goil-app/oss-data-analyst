import { tool } from "ai";
import { z } from "zod";
import { executeSQL as executeSQLQuery } from "@/lib/sqlite";

/**
 * Execute SQL query against SQLite database
 */
export const ExecuteSQL = tool({
  description:
    "Execute read-only SQL query against SQLite database. Returns rows and columns.",
  inputSchema: z.object({
    sql: z.string().min(1),
  }),
  execute: async ({ sql }) => {
    console.log(`[ExecuteSQL] Executing: ${sql.substring(0, 100)}...`);

    try {
      const result = await executeSQLQuery(sql);

      // Convert columns array to format expected by tools
      const columns = result.columns.map((col) => ({
        name: col,
        type: "TEXT", // SQLite is dynamically typed
      }));

      return {
        rows: result.rows,
        columns,
        rowCount: result.rowCount,
        executionTime: result.executionTime,
      };
    } catch (error: any) {
      console.error(`[ExecuteSQL] Error:`, error.message);
      return {
        ok: false,
        error: error.message,
        rows: [],
        columns: [],
      };
    }
  },
});

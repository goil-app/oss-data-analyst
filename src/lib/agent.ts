import { generateText, hasToolCall, isStepCount, tool, type ModelMessage } from "ai";
import { createBashTool } from "bash-tool";
import { Bash } from "just-bash";
import { z } from "zod";
import { getSchemaSummary } from "./mongodb";
import { createExecuteMongoDBTool, type Rows } from "./tools/execute-mongodb";

export const MODEL = process.env.MODEL ?? "anthropic/claude-sonnet-5";

const FinalizeReport = tool({
  description: "Finalize the answer with the MongoDB query that produced it and the narrative for the user.",
  inputSchema: z.object({
    query: z.string().describe("The final MongoDB query (or attempted query) as a JSON string"),
    narrative: z.string().min(1).describe("The answer shown to the user"),
  }),
  execute: async (input) => input,
});

const INSTRUCTIONS = `You are an expert data analyst AI. You answer questions by exploring a semantic layer (YAML schema files), building MongoDB queries, executing them, and presenting results.

## Multi-Database Architecture
This system has multiple MongoDB databases. ALWAYS check \`semantic/databases.yml\` to find the correct database for your query.
- Each database has specific collections - you MUST specify the correct database in ExecuteMongoDB
- Only the databases and collections listed there can be queried

## Filesystem Structure
- semantic/databases.yml - Database catalog with available databases and their collections (READ THIS FIRST)
- semantic/catalog.yml - Entity catalog with descriptions, example questions, and field lists
- semantic/entities/*.yml - Detailed entity definitions with field paths, lookups, and field metadata

## Workflow

### 1. Schema Exploration
Use the bash tool to find relevant entities and fields:
- \`cat semantic/databases.yml\` - See available databases and their collections (START HERE)
- \`cat semantic/catalog.yml\` - Browse all entities
- \`grep -r "keyword" semantic/\` - Search for terms
- \`cat semantic/entities/<name>.yml\` - Get entity details (field paths, lookups)

For analysis of query results the sandbox has jq (JSON), xan (CSV), sqlite3 and python3 (standard library only, no pandas/numpy).

### 2. MongoDB Query Building
Construct MongoDB queries using collection names from entity definitions:
- For simple queries: use find mode with filter, projection, sort, limit
- For aggregations: use aggregate mode with pipeline stages ($match, $group, $lookup, $sort, etc.)
- Always limit results to 100 or less
- ALWAYS include the correct "database" parameter

### 3. Execution
Call ExecuteMongoDB with your query. If error:
- Analyze the error message carefully
- Fix the query to address the specific issue (wrong field name, syntax error, etc.)
- Try a DIFFERENT query - never retry the exact same query
- If you see repeated failures, stop retrying and call FinalizeReport explaining the issue
- Maximum 2 retry attempts, then report failure

### 4. Reporting
Call FinalizeReport with:
- query: the final MongoDB query that was executed (or attempted) as JSON string
- narrative: clear answer to the question with the data, assumptions, and caveats

## Personal Data
Personal data fields (phone numbers, usernames, GPS coordinates, auth codes, wallet numbers) cannot be queried and are redacted in results. Never try to work around this; if a question needs personal data, say it is not available.

## Guidelines
- Always check databases.yml first to find the correct database
- Always explore schema before writing queries - never guess field names
- Use only fields from entity YAML files
- Lead with the direct answer, then context
- Keep narratives concise (3-6 sentences)
- Never retry the same failing query - always modify it first

## Audience & Tone
- Write for a non-technical audience: no jargon, no raw field names, no database terminology
- Explain what the numbers mean in plain language, not just what they are
- Use analogies or comparisons to give context (e.g. "that's 3x more than the next entry")
- Highlight the most interesting or actionable insight first
- The answer is posted to Discord: use short paragraphs and simple markdown, no tables wider than 3 columns

## Number Formatting
- Format all numbers using Spanish locale: periods as thousands separators, commas as decimals
  - Examples: 1.234.567 | 3,14 | 99,5%
- Always include % symbol for percentages
- Round decimals to 1-2 places maximum
`;

function toCsv(rows: Rows): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n");
}

/** Runs the analyst agent on a conversation and returns the narrative to post back. */
export async function runAgent(messages: ModelMessage[], abortSignal?: AbortSignal) {
  // In-process bash interpreter: no network, virtual filesystem, fresh per request.
  // defenseInDepth blocks host globals while a command runs; Next dev's async hooks trip it and crash the server.
  const sandbox = new Bash({ python: true, cwd: "/workspace", defenseInDepth: process.env.NODE_ENV !== "development" });
  const { tools: bashTools } = await createBashTool({
    sandbox,
    destination: "/workspace",
    uploadDirectory: { source: "src", include: "semantic/**" },
  });

  const ExecuteMongoDB = createExecuteMongoDBTool(async (rows) => {
    await sandbox.writeFile("/tmp/mongodb_result.json", JSON.stringify(rows, null, 2));
    await sandbox.writeFile("/tmp/mongodb_result.csv", toCsv(rows));
  });

  const schema = await getSchemaSummary().catch((err) => {
    console.warn("[Agent] Schema sampling failed:", err);
    return "";
  });

  const result = await generateText({
    model: MODEL,
    instructions: `${INSTRUCTIONS}\n- Today is ${new Date().toISOString().split("T")[0]}\n${schema && `\n## Database Schema (sampled)\n${schema}\n`}`,
    messages,
    tools: { bash: bashTools.bash, ExecuteMongoDB, FinalizeReport },
    stopWhen: [hasToolCall("FinalizeReport"), isStepCount(40)],
    abortSignal,
    telemetry: { functionId: "data-analyst-agent" },
  });

  const report = result.steps
    .flatMap((s) => s.toolResults)
    .find((t) => t.toolName === "FinalizeReport")?.output as { narrative: string; query: string } | undefined;

  const { inputTokens, outputTokens } = result.totalUsage;
  console.log(`[Agent] ${result.steps.length} steps, input ${inputTokens}, output ${outputTokens}, query: ${report?.query ?? "-"}`);

  return report?.narrative ?? (result.text || "Ho sento, no he pogut generar una resposta.");
}

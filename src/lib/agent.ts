import { generateText, hasToolCall, isStepCount, tool, type ModelMessage } from "ai";
import { createBashTool } from "bash-tool";
import { Bash } from "just-bash";
import { z } from "zod";
import { readFileSync } from "fs";
import path from "path";
import { getSchemaSummary, SEMANTIC_DIR } from "./mongodb";
import { createExecuteMongoDBTool, PREVIEW_ROWS, type Rows } from "./tools/execute-mongodb";
import { createExecutePostHogTool, isPostHogConfigured } from "./tools/execute-posthog";
import { createExecuteLangfuseTool, isLangfuseConfigured } from "./tools/execute-langfuse";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { isTracing, type TraceContext } from "./telemetry";

// Picked by benchmark (2026-09): same accuracy as claude-sonnet-5 on our questions at ~10x lower cost
export const MODEL = process.env.MODEL ?? "openai/gpt-5.6-luna";

const FinalizeReport = tool({
  description: "Finalize the answer with the query that produced it (MongoDB, HogQL or Langfuse) and the narrative for the user.",
  inputSchema: z.object({
    query: z.string().describe("The final MongoDB query (JSON string), HogQL query or Langfuse params that was executed or attempted"),
    narrative: z.string().min(1).describe("The answer shown to the user"),
  }),
  execute: async (input) => input,
});

const INSTRUCTIONS = `You are an expert data analyst AI. You answer questions by exploring a semantic layer (YAML schema files), building MongoDB queries, executing them, and presenting results.

## Multi-Database Architecture
This system has multiple MongoDB databases. ALWAYS check \`semantic/databases.yml\` to find the correct database for your query.
- Each database has specific collections - you MUST specify the correct database in ExecuteMongoDB
- Only the databases and collections listed there can be queried

${isPostHogConfigured() ? `## PostHog (product usage analytics)
Questions about how the backoffice web app or its help center are USED (page visits, active users per business, most used modules, help center opens, chat questions, docs viewed, errors users hit) are answered with ExecutePostHog (HogQL), NOT MongoDB.
- Read \`semantic/posthog.yml\` first: events, properties, and how to join with MongoDB ids
- MongoDB = business data (accounts, alerts, notifications...). PostHog = behaviour inside the backoffice/help center
- You can combine both: e.g. get business ids from PostHog, then names from ClientDB.Business

` : ""}${isLangfuseConfigured() ? `## Langfuse (backend AI observability)
Questions about the backend's AI features (AI project/store builder, help center assistant, smart notifications, smart translations): number of AI calls, cost, tokens, latency, errors, models, user feedback scores. Use ExecuteLangfuse.
- Read \`semantic/langfuse.yml\` first: trace names, ids, Metrics API query format and examples
- AI cost per business/project: MongoDB IntegrationDB.AIUsageEvents is the ledger (has businessId/projectId). Langfuse covers everything, including notifications and translations, but can't group by business
- Cross sources by id: Langfuse userId/sessionId = businessId/projectId on builder traces; traceId in AIUsageEvents and SmartNotificationFeedback

` : ""}## Filesystem Structure
- semantic/databases.yml - Database catalog with available databases and their collections (included below)
- semantic/catalog.yml - Entity catalog with descriptions, example questions, and field lists (included below)
- semantic/entities/*.yml - Detailed entity definitions with field paths, lookups, and field metadata
- semantic/posthog.yml - PostHog events and properties (backoffice + help center usage)
- semantic/langfuse.yml - Langfuse traces, scores and Metrics API (backend AI features)
- /tmp/mongo_schema.txt - Sampled field types per collection (grep it, e.g. \`grep -A30 "Collection: Account$" /tmp/mongo_schema.txt\`)

## Query Results
ExecuteMongoDB, ExecutePostHog and ExecuteLangfuse return rowCount and only the first ${PREVIEW_ROWS} rows (plus a warning if the result was capped).
The full result of the LATEST query is always in /tmp/mongodb_result.json and /tmp/mongodb_result.csv: use python3, jq or xan on those files for totals, rankings or any analysis over all rows instead of reasoning over the preview.

## Workflow

### 1. Schema Exploration
databases.yml and catalog.yml are already included at the end of these instructions: do NOT cat them again.
Use the bash tool only for details:
- \`cat semantic/entities/<name>.yml\` - Get entity details (field paths, lookups)
- \`grep -r "keyword" semantic/\` - Search for terms
- Read several files in ONE command (e.g. \`cat semantic/entities/Account.yml semantic/entities/AccountType.yml\`)

For analysis of query results the sandbox has jq (JSON), xan (CSV), sqlite3 and python3 (standard library only, no pandas/numpy).

### 2. MongoDB Query Building
Construct MongoDB queries using collection names from entity definitions:
- For simple queries: use find mode with filter, projection, sort, limit
- For aggregations: use aggregate mode with pipeline stages ($match, $group, $lookup, $sort, etc.)
- Always limit results to 100 or less
- ALWAYS include the correct "database" parameter

### 3. Execution
When you need several independent queries, call them in parallel in the same step.
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
- Always pick the database from databases.yml (below)
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

## semantic/databases.yml
${readFileSync(path.join(SEMANTIC_DIR, "databases.yml"), "utf8")}
## semantic/catalog.yml
${readFileSync(path.join(SEMANTIC_DIR, "catalog.yml"), "utf8")}`;

const MAX_STEPS = 40;

function toCsv(rows: Rows): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n");
}

export type AgentAnswer = { narrative: string; query?: string; traceId?: string };

/** Runs the analyst agent on a conversation inside one Langfuse "ask" trace. traceId is set when tracing is on. */
export function runAgent(messages: ModelMessage[], { abortSignal, trace }: { abortSignal?: AbortSignal; trace?: TraceContext } = {}): Promise<AgentAnswer> {
  return startActiveObservation("ask", (span) =>
    propagateAttributes({ traceName: "ask", ...trace }, async () => {
      span.update({ input: messages.at(-1)?.content });
      const answer = await analyze(messages, abortSignal);
      span.update({ output: answer.narrative });
      return { ...answer, traceId: isTracing() ? span.traceId : undefined };
    })
  );
}

async function analyze(messages: ModelMessage[], abortSignal?: AbortSignal): Promise<AgentAnswer> {
  // In-process bash interpreter: no network, virtual filesystem, fresh per request.
  // defenseInDepth blocks host globals while a command runs; Next dev's async hooks trip it and crash the server.
  const sandbox = new Bash({ python: true, cwd: "/workspace", defenseInDepth: process.env.NODE_ENV !== "development" });
  const { tools: bashTools } = await createBashTool({
    sandbox,
    destination: "/workspace",
    uploadDirectory: { source: "src", include: "semantic/**" },
  });

  // Written on every query (empty on errors) so the files never hold a previous query's data
  const writeRows = async (rows: Rows) => {
    await sandbox.writeFile("/tmp/mongodb_result.json", JSON.stringify(rows, null, 2));
    await sandbox.writeFile("/tmp/mongodb_result.csv", toCsv(rows));
  };

  // In a file, not the prompt: the agent greps what it needs and the prompt prefix stays cacheable
  const schema = await getSchemaSummary().catch((err) => {
    console.warn("[Agent] Schema sampling failed:", err);
    return "";
  });
  await sandbox.writeFile("/tmp/mongo_schema.txt", schema);

  const tools = {
    bash: bashTools.bash,
    ExecuteMongoDB: createExecuteMongoDBTool(writeRows),
    ExecutePostHog: createExecutePostHogTool(writeRows),
    ExecuteLangfuse: createExecuteLangfuseTool(writeRows),
    FinalizeReport,
  };

  const result = await generateText({
    model: MODEL,
    // Static instructions first (cache-friendly prefix), the date after them
    instructions: [
      { role: "system", content: INSTRUCTIONS },
      { role: "system", content: `Today is ${new Date().toISOString().split("T")[0]}` },
    ],
    messages,
    tools,
    activeTools: [
      "bash",
      "ExecuteMongoDB",
      ...(isPostHogConfigured() ? (["ExecutePostHog"] as const) : []),
      ...(isLangfuseConfigured() ? (["ExecuteLangfuse"] as const) : []),
      "FinalizeReport",
    ],
    // Near the step budget, force a report instead of a silent cutoff
    prepareStep: ({ stepNumber }) =>
      stepNumber >= MAX_STEPS - 3 ? { activeTools: ["FinalizeReport"], toolChoice: { type: "tool", toolName: "FinalizeReport" } } : {},
    stopWhen: [hasToolCall("FinalizeReport"), isStepCount(MAX_STEPS)],
    providerOptions: { gateway: { caching: "auto" } },
    abortSignal,
    telemetry: { functionId: "data-analyst-agent" },
  });

  const report = result.steps
    .flatMap((s) => s.toolResults)
    .find((t) => t.toolName === "FinalizeReport")?.output as { narrative: string; query: string } | undefined;

  const { inputTokens, outputTokens, inputTokenDetails } = result.totalUsage;
  console.log(`[Agent] ${result.steps.length} steps, input ${inputTokens} (cached ${inputTokenDetails?.cacheReadTokens ?? 0}), output ${outputTokens}, query: ${report?.query ?? "-"}`);

  return { narrative: report?.narrative ?? (result.text || "Ho sento, no he pogut generar una resposta."), query: report?.query };
}

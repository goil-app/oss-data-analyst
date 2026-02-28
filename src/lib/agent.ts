import type { UIMessage } from "ai";
import { stepCountIs, convertToModelMessages, streamText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import z from "zod";
import { createMongoDBTools } from "./tools/execute-mongodb";
import { getSchema, getConfiguredDatabaseNames } from "./mongodb";
import { getSandboxManager, writeResultToContainer } from "./sandbox";
import { createSemanticBashTools } from "./tools/shell";


const FinalizeReportSchema = z.object({
  query: z.string(),
  csvResults: z.string(),
  narrative: z.string().min(1),
});

const FinalizeReport = tool({
  description: "Finalize the report with MongoDB query, CSV results, and narrative.",
  inputSchema: FinalizeReportSchema,
  outputSchema: FinalizeReportSchema,
  execute: async (input) => input,
});

const SYSTEM_PROMPT = `You are an expert data analyst AI. You answer questions by exploring a semantic layer (YAML schema files), building MongoDB queries, executing them, and presenting results.

## Multi-Database Architecture
This system has multiple MongoDB databases. ALWAYS check \`semantic/databases.yml\` to find the correct database for your query.
- Each database has specific collections - you MUST specify the correct database in ExecuteMongoDB
- The "database" parameter in ExecuteMongoDB is REQUIRED

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

Python 3 is available in the sandbox with pandas, numpy, scipy for advanced analysis.

### 2. MongoDB Query Building
Construct MongoDB queries using collection names from entity definitions:
- For simple queries: use find mode with filter, projection, sort, limit
- For aggregations: use aggregate mode with pipeline stages ($match, $group, $lookup, $sort, etc.)
- Always limit results to 100 or less
- ALWAYS include the correct "database" parameter

### 3. Execution
Call ExecuteMongoDB with your query (database is REQUIRED). If error:
- Analyze the error message carefully
- Fix the query to address the specific issue (wrong field name, syntax error, etc.)
- Try a DIFFERENT query - never retry the exact same query
- If you see repeated failures, stop retrying and call FinalizeReport explaining the issue
- Maximum 2 retry attempts, then report failure

### 4. Reporting
Call FinalizeReport with:
- query: the final MongoDB query that was executed (or attempted) as JSON string
- csvResults: the results as CSV text (header row + data rows), or empty string if no results
- narrative: clear answer to the question with the data, assumptions, and caveats

## Guidelines
- Always check databases.yml first to find the correct database
- Always explore schema before writing queries - never guess field names
- Use only fields from entity YAML files
- Lead with the direct answer, then context
- Keep narratives concise (3-6 sentences)
- Never retry the same failing query - always modify it first

## Audience & Tone
- Write for a non-technical audience — no jargon, no raw field names, no database terminology
- Explain what the numbers mean in plain language, not just what they are
- Use analogies or comparisons to give context (e.g. "that's 3x more than the next entry")
- Highlight the most interesting or actionable insight first

## Number Formatting
- Format all numbers using Spanish locale: periods as thousands separators, commas as decimals
  - Examples: 1.234.567 — 3,14 — 99,5%
- Always include % symbol for percentages
- Round decimals to 1–2 places maximum

- Today is ${new Date().toISOString().split("T")[0]}
`;

async function buildSystemPrompt(): Promise<string> {
  try {
    const dbNames = getConfiguredDatabaseNames();
    const allSchemas = await Promise.all(dbNames.map((name) => getSchema(name)));

    const schemaBlock = dbNames
      .map((dbName, i) => {
        return allSchemas[i]
          .map((s) => {
            const fields = s.fields
              .map((f: { name: string; bsonType: string }) => {
                const note = f.bsonType === "ObjectId" ? "  ← use plain 24-hex string in filters" : "";
                return `  ${f.name}: ${f.bsonType}${note}`;
              })
              .join("\n");
            return `[${dbName}] Collection: ${s.collection}\n${fields}`;
          })
          .join("\n\n");
      })
      .join("\n\n");

    return `${SYSTEM_PROMPT}\n## Database Schema\n${schemaBlock}\n`;
  } catch {
    return SYSTEM_PROMPT;
  }
}

export type Phase = "planning" | "building" | "execution" | "reporting";

export async function runAgent({
  messages,
  model = "claude-sonnet-4-6",
}: {
  messages: UIMessage[];
  model?: string;
}) {
  const manager = getSandboxManager();
  const [sandbox, systemPrompt] = await Promise.all([
    manager.acquire(),
    buildSystemPrompt(),
  ]);
  const sandboxInstance = { container: sandbox.container, stop: () => sandbox.release() };
  const { tools: bashTools } = await createSemanticBashTools(sandboxInstance);
  const { tools: mongoTools } = createMongoDBTools();

  const originalExecute = mongoTools.ExecuteMongoDB.execute!;
  const wrappedExecuteMongoDB = {
    ...mongoTools.ExecuteMongoDB,
    execute: async (input: Parameters<typeof originalExecute>[0], options: Parameters<typeof originalExecute>[1]) => {
      const result = await originalExecute(input, options);
      if ("rows" in result && result.rows.length > 0) {
        try {
          await writeResultToContainer(sandbox.container, result as any);
        } catch (err) {
          console.warn("[Agent] Failed to write results to container:", err);
        }
      }
      return result;
    },
  };

  const streamResult = streamText({
    model: anthropic(model),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    stopWhen: [
      (ctx) =>
        ctx.steps.some((step) =>
          step.toolResults?.some((t) => t.toolName === "FinalizeReport")
        ),
      stepCountIs(100),
    ],
    tools: {
      bash: bashTools.bash,
      ExecuteMongoDB: wrappedExecuteMongoDB,
      FinalizeReport,
    },
    onFinish: async () => {
      await sandbox.release();
    },
  });

  return streamResult;
}

/**
 * Runs the agent and returns both the result and the container for further use.
 * Container is persistent - no cleanup needed.
 */
export async function runAgentWithSandbox({
  messages,
  model = "claude-sonnet-4-6",
}: {
  messages: UIMessage[];
  model?: string;
}) {
  const manager = getSandboxManager();
  const [sandbox, systemPrompt] = await Promise.all([
    manager.acquire(),
    buildSystemPrompt(),
  ]);
  const sandboxInstance = { container: sandbox.container, stop: () => sandbox.release() };
  const { tools: bashTools } = await createSemanticBashTools(sandboxInstance);
  const { tools: mongoTools } = createMongoDBTools();

  const originalExecute = mongoTools.ExecuteMongoDB.execute!;
  const wrappedExecuteMongoDB = {
    ...mongoTools.ExecuteMongoDB,
    execute: async (input: Parameters<typeof originalExecute>[0], options: Parameters<typeof originalExecute>[1]) => {
      const result = await originalExecute(input, options);
      if ("rows" in result && result.rows.length > 0) {
        try {
          await writeResultToContainer(sandbox.container, result as any);
        } catch (err) {
          console.warn("[Agent] Failed to write results to container:", err);
        }
      }
      return result;
    },
  };

  const streamResult = streamText({
    model: anthropic(model),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    stopWhen: [
      (ctx) =>
        ctx.steps.some((step) =>
          step.toolResults?.some((t) => t.toolName === "FinalizeReport")
        ),
      stepCountIs(100),
    ],
    tools: {
      bash: bashTools.bash,
      ExecuteMongoDB: wrappedExecuteMongoDB,
      FinalizeReport,
    },
  });

  return { result: streamResult, container: sandbox.container, stop: () => sandbox.release() };
}

type FinalizeReportOutput = z.infer<typeof FinalizeReportSchema>;

export const extractFinalizeReport = (result: {
  toolResults: Array<{ toolName: string; output?: unknown }>;
}) => {
  const finalResult = result.toolResults.find(
    (t) => t.toolName === "FinalizeReport"
  );

  const output = (finalResult?.output || {}) as Partial<FinalizeReportOutput>;

  return {
    hasFinalResult: finalResult != null,
    query: output.query,
    csvResults: output.csvResults,
    narrative: output.narrative,
  };
};

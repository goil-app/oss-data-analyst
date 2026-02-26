import { tool } from "ai";
import { z } from "zod";
import type { SandboxInstance } from "./sandbox";
import { execInContainer } from "./sandbox";

/**
 * Creates bash tools bound to a specific Docker container instance.
 * Semantic files are mounted at /app/semantic via volume mount.
 */
export async function createSemanticBashTools({ container }: SandboxInstance) {
  const bash = tool({
    description: `Execute bash commands in a sandboxed container.

The container has the semantic layer mounted at ./semantic/ (also /app/semantic/).
Use this to explore YAML schema files:
- \`cat semantic/catalog.yml\` - Browse all entities
- \`grep -r "keyword" semantic/\` - Search for terms
- \`cat semantic/entities/<name>.yml\` - Get entity details

Python 3 is available with pandas, numpy, pymongo, scipy for data analysis.`,
    inputSchema: z.object({
      command: z.string().describe("The bash command to execute"),
    }),
    execute: async ({ command }) => {
      const { stdout, stderr, exitCode } = await execInContainer(
        container,
        command
      );

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += (output ? "\n" : "") + stderr;

      return {
        output: output || "(no output)",
        exitCode,
        success: exitCode === 0,
      };
    },
  });

  return { tools: { bash } };
}

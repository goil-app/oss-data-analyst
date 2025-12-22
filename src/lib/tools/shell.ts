import type { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod";

/**
 * Creates an executeCommand tool bound to a specific sandbox instance.
 *
 * Usage:
 * ```ts
 * const { sandbox, stop } = await createSemanticSandbox();
 * const executeCommand = createExecuteCommandTool(sandbox);
 * // use executeCommand in agent tools...
 * ```
 */
export function createExecuteCommandTool(sandbox: Sandbox) {
  return tool({
    description: `Execute shell commands to explore the semantic layer files.

Commands:

- cat semantic/catalog.yml - View entity catalog
- cat semantic/entities/<name>.yml - View entity details
- grep -r "keyword" semantic/ - Search for terms
- ls semantic/entities/ - List all entities
- grep -l "field_name" semantic/entities/*.yml - Find which entity has a field`,
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      args: z.array(z.string()).describe("Arguments to pass to the command"),
    }),
    execute: async ({ command, args }) => {
      const result = await sandbox.runCommand(command, args);
      const textResults = await result.stdout();
      const stderr = await result.stderr();
      return {
        stdout: textResults,
        stderr: stderr,
        exitCode: result.exitCode,
      };
    },
  });
}

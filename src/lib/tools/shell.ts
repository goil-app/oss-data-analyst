import { createBashTool } from "bash-tool";
import type { Sandbox } from "@vercel/sandbox";

/**
 * Creates bash tools bound to a specific sandbox instance using bash-tool package.
 * Uploads semantic layer YAML files to the sandbox at ./semantic/
 *
 * Usage:
 * ```ts
 * const sandbox = await Sandbox.create();
 * const { tools } = await createSemanticBashTools(sandbox);
 * // use tools.bash in agent tools...
 * ```
 */
export async function createSemanticBashTools(sandbox: Sandbox) {
  const { tools } = await createBashTool({
    sandbox,
    destination: "./semantic",
    uploadDirectory: {
      source: "./src/semantic",
      include: "**/*.yml",
    },
  });

  return { tools };
}

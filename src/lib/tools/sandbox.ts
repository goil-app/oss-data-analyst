import { Sandbox } from "@vercel/sandbox";
import ms from "ms";

export interface SandboxInstance {
  sandbox: Sandbox;
  stop: () => Promise<void>;
}

/**
 * Creates a sandbox for executing commands.
 * Returns the sandbox instance and a stop function for cleanup.
 *
 * Note: File uploads are handled by bash-tool's createBashTool function.
 *
 * Usage:
 * ```ts
 * const { sandbox, stop } = await createSandbox();
 * try {
 *   // use sandbox with createSemanticBashTools...
 * } finally {
 *   await stop();
 * }
 * ```
 */
export async function createSandbox(): Promise<SandboxInstance> {
  const sandbox = await Sandbox.create({
    resources: { vcpus: 4 },
    timeout: ms("45m"), // Max allowed by Vercel Sandbox API is 2700000ms (45 minutes)
  });

  return {
    sandbox,
    stop: async () => sandbox.stop(),
  };
}

import { Sandbox } from "@vercel/sandbox";
import ms from "ms";
import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";

export interface SandboxInstance {
  sandbox: Sandbox;
  stop: () => Promise<void>;
}

/**
 * Creates a sandbox initialized with semantic layer YAML files.
 * Returns the sandbox instance and a stop function for cleanup.
 *
 * Usage:
 * ```ts
 * const { sandbox, stop } = await createSemanticSandbox();
 * try {
 *   // use sandbox...
 * } finally {
 *   await stop();
 * }
 * ```
 */
export async function createSemanticSandbox(): Promise<SandboxInstance> {
  const sandbox = await Sandbox.create({
    resources: { vcpus: 4 },
    timeout: ms("1h"),
  });

  const semanticDir = path.join(process.cwd(), "src/semantic");
  const ymlFiles = await glob("**/*.yml", { cwd: semanticDir });
  const files = await Promise.all(
    ymlFiles.map(async (relativePath) => ({
      path: `semantic/${relativePath}`,
      content: await fs.readFile(path.join(semanticDir, relativePath)),
    }))
  );
  await sandbox.writeFiles(files);

  return {
    sandbox,
    stop: async () => sandbox.stop(),
  };
}

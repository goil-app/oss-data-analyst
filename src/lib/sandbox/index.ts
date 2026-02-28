import { SandboxManager } from "./sandbox-manager";
import { execInContainer, writeToContainer } from "./container";
import type { SandboxConfig, SandboxInstance, Sandbox, PoolStats, ExecResult } from "./types";

export { SandboxManager } from "./sandbox-manager";
export { SandboxState, PoolExhaustedError, SandboxUnavailableError, SandboxTimeoutError, InvalidTransitionError } from "./types";
export type { SandboxConfig, SandboxInstance, Sandbox, PoolStats, ExecResult, SandboxEvent, SandboxEventListener, TrackedSandbox } from "./types";
export { transition, canTransition } from "./state-machine";
export { loadConfig } from "./config";

// --- Singleton ---

let _manager: SandboxManager | null = null;

export function getSandboxManager(config?: Partial<SandboxConfig>): SandboxManager {
  if (!_manager) {
    _manager = new SandboxManager(config);
  }
  return _manager;
}

/**
 * Reset singleton (for tests).
 */
export function resetSandboxManager(): void {
  _manager = null;
}

// --- Backward-compat shims ---

/**
 * Drop-in replacement for old createSandbox().
 * Returns { container, stop } matching old SandboxInstance.
 */
export async function createSandbox(): Promise<SandboxInstance> {
  return getSandboxManager().createSandbox();
}

/**
 * Re-export execInContainer with same signature as old sandbox.ts.
 */
export { execInContainer } from "./container";

/**
 * Write MongoDB query results to /tmp/mongodb_result.{json,csv} in the container.
 * Same signature as old sandbox.ts.
 */
export async function writeResultToContainer(
  container: import("dockerode").Container,
  { rows, columns }: { rows: Record<string, unknown>[]; columns: { name: string }[] },
): Promise<void> {
  if (rows.length === 0) return;

  try {
    const jsonPayload = Buffer.from(JSON.stringify(rows, null, 2)).toString("base64");
    await execInContainer(container, `echo '${jsonPayload}' | base64 -d > /tmp/mongodb_result.json`);

    const header = columns.map((c) => c.name).join(",");
    const csvRows = rows.map((row) =>
      columns
        .map((c) => {
          const val = row[c.name];
          if (val === null || val === undefined) return "";
          if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
          const s = String(val);
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(","),
    );
    const csv = [header, ...csvRows].join("\n");
    const csvPayload = Buffer.from(csv).toString("base64");
    await execInContainer(container, `echo '${csvPayload}' | base64 -d > /tmp/mongodb_result.csv`);
  } catch (err) {
    console.warn("[Sandbox] Failed to write MongoDB results to container:", err);
  }
}

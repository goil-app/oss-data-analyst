import type Docker from "dockerode";

// --- State ---

export enum SandboxState {
  Creating = "creating",
  Initializing = "initializing",
  Ready = "ready",
  Executing = "executing",
  Idle = "idle",
  Suspended = "suspended",
  Destroyed = "destroyed",
  Error = "error",
}

// --- Config ---

export interface PoolConfig {
  minWarm: number;
  maxTotal: number;
  maxIdleMs: number;
}

export interface ResourceLimits {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
}

export interface HealthCheckConfig {
  intervalMs: number;
  maxFailures: number;
}

export interface TimeoutConfig {
  execMs: number;
  initMs: number;
  shutdownGraceMs: number;
}

export interface SandboxConfig {
  image: string;
  pool: PoolConfig;
  resourceLimits: ResourceLimits;
  healthCheck: HealthCheckConfig;
  timeouts: TimeoutConfig;
}

// --- Exec result ---

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// --- Sandbox handle (returned by acquire) ---

export interface Sandbox {
  id: string;
  container: Docker.Container;
  state: SandboxState;
  exec(cmd: string): Promise<ExecResult>;
  writeFile(path: string, content: Buffer): Promise<void>;
  release(): Promise<void>;
  destroy(): Promise<void>;
}

// --- Backward-compat SandboxInstance ---

export interface SandboxInstance {
  container: Docker.Container;
  stop: () => Promise<void>;
}

// --- Pool stats ---

export interface PoolStats {
  total: number;
  ready: number;
  executing: number;
  idle: number;
  suspended: number;
}

// --- Events ---

export type SandboxEvent =
  | { type: "created"; sandboxId: string }
  | { type: "state-change"; sandboxId: string; from: SandboxState; to: SandboxState }
  | { type: "destroyed"; sandboxId: string; reason: string }
  | { type: "health-check-failed"; sandboxId: string; failures: number }
  | { type: "error"; sandboxId: string; error: Error };

export type SandboxEventListener = (event: SandboxEvent) => void;

// --- Internal tracked sandbox ---

export interface TrackedSandbox {
  id: string;
  container: Docker.Container;
  state: SandboxState;
  createdAt: number;
  lastUsedAt: number;
  healthFailures: number;
  sessionId?: string;
}

// --- Errors ---

export class PoolExhaustedError extends Error {
  constructor(maxTotal: number) {
    super(`Sandbox pool exhausted (max ${maxTotal}). Try again later.`);
    this.name = "PoolExhaustedError";
  }
}

export class SandboxUnavailableError extends Error {
  constructor(cause?: Error) {
    super(`Docker sandbox unavailable: ${cause?.message ?? "unknown"}`);
    this.name = "SandboxUnavailableError";
    if (cause) this.cause = cause;
  }
}

export class SandboxTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Sandbox ${operation} timed out after ${timeoutMs}ms`);
    this.name = "SandboxTimeoutError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: SandboxState, to: SandboxState) {
    super(`Invalid sandbox state transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

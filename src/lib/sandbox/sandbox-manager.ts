import Docker from "dockerode";
import crypto from "crypto";
import { loadConfig } from "./config";
import { transition } from "./state-machine";
import {
  ensureImage,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  execInContainer,
  writeToContainer,
  initContainerPython,
} from "./container";
import {
  SandboxState,
  PoolExhaustedError,
  SandboxUnavailableError,
  type SandboxConfig,
  type Sandbox,
  type SandboxInstance,
  type PoolStats,
  type SandboxEventListener,
  type SandboxEvent,
  type TrackedSandbox,
} from "./types";

const ACQUIRE_RETRY_INTERVAL_MS = 2_000;
const ACQUIRE_MAX_RETRIES = 3;

export class SandboxManager {
  private docker: Docker;
  private config: SandboxConfig;
  private sandboxes = new Map<string, TrackedSandbox>();
  private readyQueue: string[] = [];
  private listeners: SandboxEventListener[] = [];
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private shutdownRequested = false;

  constructor(config?: Partial<SandboxConfig>) {
    this.docker = new Docker();
    this.config = loadConfig(config);
  }

  // --- Lifecycle ---

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.docker.ping();
    } catch (err) {
      throw new SandboxUnavailableError(err as Error);
    }

    await ensureImage(this.docker, this.config.image);

    // Warm pool
    const warmPromises: Promise<void>[] = [];
    for (let i = 0; i < this.config.pool.minWarm; i++) {
      warmPromises.push(this.warmOne());
    }
    await Promise.all(warmPromises);

    // Start background loops
    this.healthTimer = setInterval(() => this.healthCheckLoop(), this.config.healthCheck.intervalMs);
    this.cleanupTimer = setInterval(() => this.cleanupLoop(), this.config.healthCheck.intervalMs);

    this.initialized = true;
    console.log("[SandboxManager] Initialized", { pool: this.config.pool, image: this.config.image });
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    // Grace period for executing sandboxes
    const executing = [...this.sandboxes.values()].filter((s) => s.state === SandboxState.Executing);
    if (executing.length > 0) {
      console.log(`[SandboxManager] Waiting for ${executing.length} executing sandbox(es)...`);
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.timeouts.shutdownGraceMs));
    }

    // Force-stop all
    const destroyPromises = [...this.sandboxes.values()].map((s) => this.destroySandbox(s.id, "shutdown"));
    await Promise.allSettled(destroyPromises);

    this.sandboxes.clear();
    this.readyQueue = [];
    this.initialized = false;
    console.log("[SandboxManager] Shut down.");
  }

  // --- Public API ---

  async acquire(sessionId?: string): Promise<Sandbox> {
    if (!this.initialized) await this.initialize();
    if (this.shutdownRequested) throw new SandboxUnavailableError(new Error("shutdown in progress"));

    // Try warm sandbox from queue
    while (this.readyQueue.length > 0) {
      const id = this.readyQueue.shift()!;
      const tracked = this.sandboxes.get(id);
      if (tracked && tracked.state === SandboxState.Ready) {
        this.transitionSandbox(tracked, SandboxState.Executing);
        tracked.sessionId = sessionId;
        tracked.lastUsedAt = Date.now();
        return this.createHandle(tracked);
      }
    }

    // Try to create new
    if (this.sandboxes.size < this.config.pool.maxTotal) {
      const tracked = await this.createTrackedSandbox(sessionId);
      this.transitionSandbox(tracked, SandboxState.Executing);
      return this.createHandle(tracked);
    }

    // Pool full — retry
    for (let attempt = 0; attempt < ACQUIRE_MAX_RETRIES; attempt++) {
      await new Promise<void>((r) => setTimeout(r, ACQUIRE_RETRY_INTERVAL_MS));

      // Check ready queue again
      while (this.readyQueue.length > 0) {
        const id = this.readyQueue.shift()!;
        const tracked = this.sandboxes.get(id);
        if (tracked && tracked.state === SandboxState.Ready) {
          this.transitionSandbox(tracked, SandboxState.Executing);
          tracked.sessionId = sessionId;
          tracked.lastUsedAt = Date.now();
          return this.createHandle(tracked);
        }
      }

      // Check if a slot freed up
      if (this.sandboxes.size < this.config.pool.maxTotal) {
        const tracked = await this.createTrackedSandbox(sessionId);
        this.transitionSandbox(tracked, SandboxState.Executing);
        return this.createHandle(tracked);
      }
    }

    throw new PoolExhaustedError(this.config.pool.maxTotal);
  }

  async release(sandboxId: string): Promise<void> {
    const tracked = this.sandboxes.get(sandboxId);
    if (!tracked) return;

    this.transitionSandbox(tracked, SandboxState.Idle);
    tracked.sessionId = undefined;
    tracked.lastUsedAt = Date.now();

    // Return to pool if we need warm sandboxes
    const readyCount = [...this.sandboxes.values()].filter((s) => s.state === SandboxState.Ready).length;
    if (readyCount < this.config.pool.minWarm) {
      this.transitionSandbox(tracked, SandboxState.Ready);
      this.readyQueue.push(tracked.id);
    }
    // Otherwise stays Idle for TTL cleanup
  }

  /**
   * Backward-compatible: returns SandboxInstance matching old API.
   */
  async createSandbox(): Promise<SandboxInstance> {
    const sandbox = await this.acquire();
    return {
      container: sandbox.container,
      stop: () => sandbox.release(),
    };
  }

  getStats(): PoolStats {
    const states = [...this.sandboxes.values()];
    return {
      total: states.length,
      ready: states.filter((s) => s.state === SandboxState.Ready).length,
      executing: states.filter((s) => s.state === SandboxState.Executing).length,
      idle: states.filter((s) => s.state === SandboxState.Idle).length,
      suspended: states.filter((s) => s.state === SandboxState.Suspended).length,
    };
  }

  on(listener: SandboxEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  // --- Internal ---

  private emit(event: SandboxEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[SandboxManager] Listener error:", err);
      }
    }
  }

  private transitionSandbox(tracked: TrackedSandbox, to: SandboxState): void {
    const from = tracked.state;
    tracked.state = transition(from, to);
    this.emit({ type: "state-change", sandboxId: tracked.id, from, to });
  }

  private async createTrackedSandbox(sessionId?: string): Promise<TrackedSandbox> {
    const id = crypto.randomUUID().slice(0, 8);
    const tracked: TrackedSandbox = {
      id,
      container: null as any, // set below
      state: SandboxState.Creating,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      healthFailures: 0,
      sessionId,
    };
    this.sandboxes.set(id, tracked);
    this.emit({ type: "created", sandboxId: id });

    try {
      const container = await createContainer(this.docker, this.config, id);
      tracked.container = container;

      this.transitionSandbox(tracked, SandboxState.Initializing);
      await startContainer(container);
      await initContainerPython(container, this.config.timeouts.initMs);

      this.transitionSandbox(tracked, SandboxState.Ready);
      return tracked;
    } catch (err) {
      console.error(`[SandboxManager] Failed to create sandbox ${id}:`, err);
      // Attempt cleanup
      if (tracked.container) {
        await removeContainer(tracked.container).catch(() => {});
      }
      this.sandboxes.delete(id);
      this.emit({ type: "error", sandboxId: id, error: err as Error });

      // Retry once with fresh container
      try {
        return await this.createTrackedSandboxRetry(sessionId);
      } catch (retryErr) {
        throw new SandboxUnavailableError(retryErr as Error);
      }
    }
  }

  private async createTrackedSandboxRetry(sessionId?: string): Promise<TrackedSandbox> {
    const id = crypto.randomUUID().slice(0, 8);
    const tracked: TrackedSandbox = {
      id,
      container: null as any,
      state: SandboxState.Creating,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      healthFailures: 0,
      sessionId,
    };
    this.sandboxes.set(id, tracked);

    const container = await createContainer(this.docker, this.config, id);
    tracked.container = container;

    this.transitionSandbox(tracked, SandboxState.Initializing);
    await startContainer(container);
    await initContainerPython(container, this.config.timeouts.initMs);

    this.transitionSandbox(tracked, SandboxState.Ready);
    return tracked;
  }

  private async warmOne(): Promise<void> {
    try {
      const tracked = await this.createTrackedSandbox();
      this.readyQueue.push(tracked.id);
    } catch (err) {
      console.error("[SandboxManager] Failed to warm sandbox:", err);
    }
  }

  private async destroySandbox(sandboxId: string, reason: string): Promise<void> {
    const tracked = this.sandboxes.get(sandboxId);
    if (!tracked || tracked.state === SandboxState.Destroyed) return;

    try {
      tracked.state = SandboxState.Destroyed; // direct set — any state can go to Destroyed
      await stopContainer(tracked.container);
      await removeContainer(tracked.container);
    } catch (err) {
      console.error(`[SandboxManager] Error destroying ${sandboxId}:`, err);
    } finally {
      this.sandboxes.delete(sandboxId);
      this.readyQueue = this.readyQueue.filter((id) => id !== sandboxId);
      this.emit({ type: "destroyed", sandboxId, reason });
    }
  }

  private createHandle(tracked: TrackedSandbox): Sandbox {
    return {
      id: tracked.id,
      container: tracked.container,
      get state() {
        return tracked.state;
      },
      exec: (cmd: string) => execInContainer(tracked.container, cmd, this.config.timeouts.execMs),
      writeFile: (filePath: string, content: Buffer) => writeToContainer(tracked.container, filePath, content),
      release: () => this.release(tracked.id),
      destroy: () => this.destroySandbox(tracked.id, "user-requested"),
    };
  }

  // --- Background loops ---

  private async healthCheckLoop(): Promise<void> {
    const checkable = [...this.sandboxes.values()].filter(
      (s) => s.state === SandboxState.Ready || s.state === SandboxState.Idle,
    );

    for (const tracked of checkable) {
      try {
        const result = await execInContainer(tracked.container, "python3 -c 'print(1)'", 5_000);
        if (result.exitCode === 0) {
          tracked.healthFailures = 0;
        } else {
          tracked.healthFailures++;
        }
      } catch {
        tracked.healthFailures++;
      }

      if (tracked.healthFailures >= this.config.healthCheck.maxFailures) {
        console.warn(`[SandboxManager] Sandbox ${tracked.id} failed ${tracked.healthFailures} health checks, destroying.`);
        this.emit({ type: "health-check-failed", sandboxId: tracked.id, failures: tracked.healthFailures });
        await this.destroySandbox(tracked.id, "health-check-failure");

        // Replace if we're below minWarm
        const readyCount = [...this.sandboxes.values()].filter((s) => s.state === SandboxState.Ready).length;
        if (readyCount < this.config.pool.minWarm) {
          this.warmOne().catch(() => {});
        }
      }
    }
  }

  private async cleanupLoop(): Promise<void> {
    const now = Date.now();
    const idleSandboxes = [...this.sandboxes.values()].filter((s) => s.state === SandboxState.Idle);

    for (const tracked of idleSandboxes) {
      const idleTime = now - tracked.lastUsedAt;
      if (idleTime > this.config.pool.maxIdleMs) {
        console.log(`[SandboxManager] Sandbox ${tracked.id} idle for ${Math.round(idleTime / 1000)}s, destroying.`);
        await this.destroySandbox(tracked.id, "idle-timeout");
      }
    }
  }
}

import type { SandboxConfig } from "./types";

const MB = 1024 * 1024;
const SEC = 1_000;
const MIN = 60 * SEC;

const DEFAULTS: SandboxConfig = {
  image: "ubuntu:22.04",
  pool: {
    minWarm: 0,
    maxTotal: 5,
    maxIdleMs: 5 * MIN,
  },
  resourceLimits: {
    memoryBytes: 512 * MB,
    nanoCpus: 1_000_000_000, // 1 CPU
    pidsLimit: 256,
  },
  healthCheck: {
    intervalMs: 30 * SEC,
    maxFailures: 3,
  },
  timeouts: {
    execMs: 60 * SEC,
    initMs: 120 * SEC,
    shutdownGraceMs: 10 * SEC,
  },
};

function envInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

export function loadConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    image: process.env.SANDBOX_IMAGE ?? overrides?.image ?? DEFAULTS.image,
    pool: {
      minWarm: envInt("SANDBOX_POOL_MIN_WARM") ?? overrides?.pool?.minWarm ?? DEFAULTS.pool.minWarm,
      maxTotal: envInt("SANDBOX_POOL_MAX_TOTAL") ?? overrides?.pool?.maxTotal ?? DEFAULTS.pool.maxTotal,
      maxIdleMs: envInt("SANDBOX_POOL_MAX_IDLE_MS") ?? overrides?.pool?.maxIdleMs ?? DEFAULTS.pool.maxIdleMs,
    },
    resourceLimits: {
      memoryBytes: envInt("SANDBOX_MEMORY_BYTES") ?? overrides?.resourceLimits?.memoryBytes ?? DEFAULTS.resourceLimits.memoryBytes,
      nanoCpus: overrides?.resourceLimits?.nanoCpus ?? DEFAULTS.resourceLimits.nanoCpus,
      pidsLimit: overrides?.resourceLimits?.pidsLimit ?? DEFAULTS.resourceLimits.pidsLimit,
    },
    healthCheck: {
      intervalMs: overrides?.healthCheck?.intervalMs ?? DEFAULTS.healthCheck.intervalMs,
      maxFailures: overrides?.healthCheck?.maxFailures ?? DEFAULTS.healthCheck.maxFailures,
    },
    timeouts: {
      execMs: overrides?.timeouts?.execMs ?? DEFAULTS.timeouts.execMs,
      initMs: overrides?.timeouts?.initMs ?? DEFAULTS.timeouts.initMs,
      shutdownGraceMs: overrides?.timeouts?.shutdownGraceMs ?? DEFAULTS.timeouts.shutdownGraceMs,
    },
  };
}

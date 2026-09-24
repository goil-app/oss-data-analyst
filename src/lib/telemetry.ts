import { LangfuseSpanProcessor } from "@langfuse/otel";
import { OpenTelemetry } from "@ai-sdk/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { registerTelemetry } from "ai";

/** Who asked: copied onto the Langfuse trace (propagateAttributes). */
export type TraceContext = { userId?: string; sessionId?: string; tags?: string[] };

// Stored on globalThis: Next bundles instrumentation.ts and routes separately.
const g = globalThis as { langfuse?: LangfuseSpanProcessor };

export function startTelemetry() {
  if (process.env.OBSERVABILITY_ENABLED !== "true" || g.langfuse) return;
  console.log("[Telemetry] Langfuse tracing enabled");
  g.langfuse = new LangfuseSpanProcessor();
  new NodeSDK({ spanProcessors: [g.langfuse] }).start();
  registerTelemetry(new OpenTelemetry());
}

/** Serverless functions freeze after the response: flush spans before the handler ends. */
export async function flushTelemetry() {
  if (!g.langfuse) console.warn("[Telemetry] Not started: no spans exported");
  await g.langfuse?.forceFlush().catch((err) => console.warn("[Telemetry] Flush failed:", err));
}

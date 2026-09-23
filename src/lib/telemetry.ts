import { LangfuseSpanProcessor } from "@langfuse/otel";
import { OpenTelemetry } from "@ai-sdk/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { registerTelemetry } from "ai";

// Stored on globalThis: Next bundles instrumentation.ts and routes separately.
const g = globalThis as { langfuse?: LangfuseSpanProcessor };

export function startTelemetry() {
  if (process.env.OBSERVABILITY_ENABLED !== "true" || g.langfuse) return;
  g.langfuse = new LangfuseSpanProcessor();
  new NodeSDK({ spanProcessors: [g.langfuse] }).start();
  registerTelemetry(new OpenTelemetry());
}

/** Serverless functions freeze after the response: flush spans before the handler ends. */
export async function flushTelemetry() {
  await g.langfuse?.forceFlush().catch((err) => console.warn("[Telemetry] Flush failed:", err));
}

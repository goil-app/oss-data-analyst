import { LangfuseSpanProcessor } from "@langfuse/otel";
import { OpenTelemetry } from "@ai-sdk/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { registerTelemetry } from "ai";

/** Who asked, passed to generateText as runtimeContext and copied onto the Langfuse trace. */
export type TraceContext = { userId?: string; sessionId?: string; tags?: string[] };

// Stored on globalThis: Next bundles instrumentation.ts and routes separately.
const g = globalThis as { langfuse?: LangfuseSpanProcessor };

export function startTelemetry() {
  if (process.env.OBSERVABILITY_ENABLED !== "true" || g.langfuse) return;
  g.langfuse = new LangfuseSpanProcessor();
  new NodeSDK({ spanProcessors: [g.langfuse] }).start();
  // Langfuse reads trace-level attributes from the root (operation) span
  registerTelemetry(new OpenTelemetry({
    enrichSpan: ({ spanType, runtimeContext }) => {
      const t = runtimeContext as TraceContext | undefined;
      if (spanType !== "operation" || !t) return undefined;
      return {
        "langfuse.trace.name": "ask",
        ...(t.userId && { "user.id": t.userId }),
        ...(t.sessionId && { "session.id": t.sessionId }),
        ...(t.tags?.length && { "langfuse.trace.tags": t.tags }),
      };
    },
  }));
}

/** Serverless functions freeze after the response: flush spans before the handler ends. */
export async function flushTelemetry() {
  await g.langfuse?.forceFlush().catch((err) => console.warn("[Telemetry] Flush failed:", err));
}

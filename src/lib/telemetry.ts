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

export const isTracing = () => Boolean(g.langfuse);

/** Records a 👍/👎 from Discord as a Langfuse score on the answer's trace. */
export async function scoreTrace(traceId: string, value: 1 | -1, userId: string) {
  const res = await fetch(new URL("/api/public/scores", process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ traceId, name: "user-feedback", value, dataType: "NUMERIC", comment: `by ${userId}` }),
  });
  if (!res.ok) throw new Error(`Langfuse score HTTP ${res.status}: ${await res.text()}`);
}

/** Serverless functions freeze after the response: flush spans before the handler ends. */
export async function flushTelemetry() {
  if (!g.langfuse) console.warn("[Telemetry] Not started: no spans exported");
  await g.langfuse?.forceFlush().catch((err) => console.warn("[Telemetry] Flush failed:", err));
}

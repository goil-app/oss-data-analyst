import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

export async function register() {
  if (process.env.OBSERVABILITY_ENABLED !== 'true') return;

  const sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
        secretKey: process.env.LANGFUSE_SECRET_KEY!,
        baseUrl: process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com',
      }),
    ],
  });
  sdk.start();
}

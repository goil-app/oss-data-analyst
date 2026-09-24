// Local end-to-end run of the agent: pnpm ask "how many accounts were created this month?"
import { runAgent } from "../src/lib/agent";
import { flushTelemetry, startTelemetry } from "../src/lib/telemetry";

const question = process.argv.slice(2).join(" ");
if (!question) throw new Error('Usage: pnpm ask "<question>"');
startTelemetry();
console.log((await runAgent([{ role: "user", content: question }], { trace: { userId: "cli", sessionId: "cli", tags: ["cli"] }, onProgress: (s) => console.error(s) })).narrative);
await flushTelemetry();
process.exit(0);

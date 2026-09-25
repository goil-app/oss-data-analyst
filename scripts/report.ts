// Preview the weekly report locally without posting it: pnpm report
import { runAgent } from "../src/lib/agent";
import { flushTelemetry, startTelemetry } from "../src/lib/telemetry";
import { weeklyReportPrompt } from "../src/lib/weekly-report";

startTelemetry();
const { narrative } = await runAgent([{ role: "user", content: weeklyReportPrompt(new Date()) }], {
  trace: { userId: "cli", sessionId: "weekly-report", tags: ["weekly-report", "cli"] },
  onProgress: (s) => console.error(s),
});
console.log(narrative);
await flushTelemetry();
process.exit(0);

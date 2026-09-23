// Local end-to-end run of the agent: pnpm ask "how many accounts were created this month?"
import { runAgent } from "../src/lib/agent";

const question = process.argv.slice(2).join(" ");
if (!question) throw new Error('Usage: pnpm ask "<question>"');
console.log(await runAgent([{ role: "user", content: question }]));
process.exit(0);

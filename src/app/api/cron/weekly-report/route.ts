import { runAgent } from "@/lib/agent";
import { bot, chunks } from "@/lib/bot";
import { flushTelemetry } from "@/lib/telemetry";
import { weeklyReportPrompt } from "@/lib/weekly-report";

export const maxDuration = 800;

/** Vercel Cron (vercel.json), every Monday: posts the weekly report to WEEKLY_REPORT_CHANNEL_ID. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  const channelId = process.env.WEEKLY_REPORT_CHANNEL_ID;
  if (!channelId) return new Response("WEEKLY_REPORT_CHANNEL_ID is not set", { status: 500 });

  try {
    const { narrative } = await runAgent([{ role: "user", content: weeklyReportPrompt(new Date()) }], {
      trace: { userId: "cron", sessionId: "weekly-report", tags: ["weekly-report"] },
    });
    await bot.initialize();
    const channel = bot.channel(channelId);
    for (const part of chunks(narrative)) await channel.post(part);
    return Response.json({ ok: true });
  } finally {
    await flushTelemetry();
  }
}

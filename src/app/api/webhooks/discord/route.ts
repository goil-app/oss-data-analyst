import { after } from "next/server";
import { bot } from "@/lib/bot";

// The agent runs inside after(), so the function must live long enough for it.
export const maxDuration = 800;

export function POST(request: Request) {
  return bot.webhooks.discord(request, { waitUntil: (task) => after(() => task) });
}
